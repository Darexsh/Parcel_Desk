import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/definitions.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InputRequiredError, InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { A_TU_HORA_DETAIL, A_TU_HORA_LOOKUP, adapter, ATuHoraExpressTracker, aTuHoraDetailUrl, aTuHoraLookupUrl } from './adapter.js';
import { aTuHoraCredential, carriesPostcode, parseATuHora, parseATuHoraGuid } from './parser.js';
import { aTuHoraStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const POSTCODE = '99999';
const DELIVERED = '0000009990000017';
const DELIVERED_LABEL = `${DELIVERED}001${POSTCODE}`;
const IN_TRANSIT = '0000009990000024';
const IN_TRANSIT_SHORT = '9990000024';
const UNKNOWN_LABEL = '0'.repeat(24);
const DELIVERED_GUID = '00000000-0000-4000-8000-000000000017';
const IN_TRANSIT_GUID = '00000000-0000-4000-8000-000000000024';
const DELIVERED_CREDENTIAL = { code: DELIVERED_LABEL, service: DELIVERED, postcode: POSTCODE };
const IN_TRANSIT_CREDENTIAL = { code: IN_TRANSIT, service: IN_TRANSIT, postcode: POSTCODE };

type Row = Record<string, unknown>;
interface Detail extends Record<string, unknown> { estados: Row[]; ultEstado: Row | null }
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Detail => JSON.parse(text(name));
/** A fixture with its reply changed in place by `change`. */
const changed = (name: string, change: (data: Detail) => void) => {
  const data = fixture(name);
  change(data);
  return data;
};
/** The lookup's reply naming `guid`. */
const stub = (guid: string) => JSON.stringify({ ...JSON.parse(text('lookup')), guid });
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A transport that answers each request with the next reply. */
const replies = (...bodies: (string | Response)[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const body of bodies) fetcher.mockResolvedValueOnce(typeof body === 'string' ? reply(body) : body);
  return fetcher;
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (cod: unknown, des: string, clock: string): Row => ({ pob: '', des, fecHoraAlta: clock, lecPun: 0, cod, codInc: null, desInc: null,
  tipo: 0, iconoEstado: 'otro18px', estadoFinal: false, latitud: null, longitud: null });

describe('A Tu Hora Express HTTP adapter', () => {
  it('asks the tracking page\'s lookup with the postcode the label carries, then the shipment it names', async () => {
    const fetcher = replies(stub(DELIVERED_GUID), text('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ATuHoraExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED_LABEL.slice(0, 12)} ${DELIVERED_LABEL.slice(12)} `, null, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[lookup, lookupInit], [detail, detailInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(String(lookup)).toBe(`${A_TU_HORA_LOOKUP}${DELIVERED_LABEL}/${POSTCODE}`);
    expect(aTuHoraLookupUrl(DELIVERED_LABEL, POSTCODE)).toBe(String(lookup));
    expect(String(detail)).toBe(`${A_TU_HORA_DETAIL}${DELIVERED_GUID}?idioma=ES`);
    expect(aTuHoraDetailUrl(DELIVERED_GUID)).toBe(String(detail));
    for (const init of [lookupInit, detailInit]) {
      // The page posts an empty JSON object to both routes.
      expect(init).toMatchObject({ method: 'POST', body: '{}', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'a-tu-hora-express', step: 'direct', outcome: 'ok' }));
  });

  it('takes the postcode from the 24-digit label, and the caller\'s for the shorter codes', async () => {
    // The label's own postcode wins over the caller's.
    expect(aTuHoraCredential(DELIVERED_LABEL, '00000')).toEqual(DELIVERED_CREDENTIAL);
    expect(aTuHoraCredential(IN_TRANSIT, ' 999 99 ')).toEqual(IN_TRANSIT_CREDENTIAL);
    // The page pads a ten-digit code with six zeros.
    expect(aTuHoraCredential(IN_TRANSIT_SHORT, POSTCODE)).toEqual(IN_TRANSIT_CREDENTIAL);
    expect(carriesPostcode(DELIVERED_LABEL)).toBe(true);
    expect(carriesPostcode(DELIVERED)).toBe(false);
    const fetcher = replies(stub(IN_TRANSIT_GUID), text('in-transit'));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT_SHORT, postcode: POSTCODE })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(aTuHoraLookupUrl(IN_TRANSIT, POSTCODE));
  });

  it('asks nothing without the postcode a shorter code needs, with an invalid one, for a code it does not issue, or once cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of [IN_TRANSIT, IN_TRANSIT_SHORT]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toBeInstanceOf(InputRequiredError);
      await expect(carrier(fetcher).track({ number, postcode: '  ' }), number).rejects.toMatchObject({ kind: 'input_required' });
    }
    for (const postcode of ['9999', '999999', 'ZZ999', '99-999']) {
      await expect(carrier(fetcher).track({ number: IN_TRANSIT, postcode }), postcode).rejects.toBeInstanceOf(InvalidInputError);
    }
    for (const number of ['999000002', '00000099900000241', `${DELIVERED_LABEL}9`, 'ATH9990000024', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number, postcode: POSTCODE }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED_LABEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('merges the history newest first as wall clocks, and stages an incident by its reason', () => {
    const result = parseATuHora(fixture('delivered'), DELIVERED_CREDENTIAL, DELIVERED_GUID);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Realizado con éxito', last_update: null, last_update_local: '2026-05-06T13:41:20', expected_delivery: null });
    expect(result).not.toHaveProperty('weight_kg');
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.description, event.provider_code])).toEqual([
      // `ultEstado` repeats the newest row and is kept once.
      ['2026-05-06T13:41:20', 'delivered', 'Realizado con éxito', '4'],
      ['2026-05-06T08:40:49', 'out_for_delivery', 'En reparto', '2'],
      // Rows of one clock keep the reply's order; the repeated row is kept once.
      ['2026-05-05T15:08:49', null, 'Pendiente de realizar', '5'],
      ['2026-05-05T15:08:49', 'failed_attempt', 'Incidencia - Pendiente nuevo reparto', '3'],
      ['2026-05-05T08:44:14', 'out_for_delivery', 'En reparto', '2'],
      ['2026-05-05T07:25:01', 'in_transit', 'En agencia distribución', '11'],
      ['2026-05-04T13:12:00', 'in_transit', 'En tránsito', '1'],
      ['2026-05-04T02:37:54', 'registered', 'Documentado', '0'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
  });

  it('keeps the town of a scan, the expected day the page shows and the weight', () => {
    const result = parseATuHora(fixture('in-transit'), IN_TRANSIT_CREDENTIAL, IN_TRANSIT_GUID);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'En reparto', last_update: null, last_update_local: '2026-11-11T08:10:00', expected_delivery: '2026-11-11', weight_kg: 2.35 });
    expect(result.events!.map((event) => [event.local_time, event.location ?? null, event.description, event.provider_code])).toEqual([
      ['2026-11-11T08:10:00', 'VILLA EJEMPLO', 'En reparto', '2'],
      ['2026-11-11T06:55:00', 'VILLA EJEMPLO', 'En agencia distribución', '11'],
      // A numeric code reads as the page's string.
      ['2026-11-10T19:30:00', null, 'En tránsito', '1'],
      ['2026-11-10T09:12:00', null, 'Documentado', '0'],
    ]);
  });

  it('shows the expected day only as the page does, before the shipment ends', () => {
    const expected = (data: Detail, guid = IN_TRANSIT_GUID, credential = IN_TRANSIT_CREDENTIAL) => parseATuHora(data, credential, guid).expected_delivery;
    expect(expected(changed('in-transit', (data) => { data.boMuestraFechaPrevista = false; }))).toBeNull();
    expect(expected(changed('in-transit', (data) => { data.boMuestraFechaPrevista = 'true'; }))).toBeNull();
    // An expected day before the departure is not shown.
    expect(expected(changed('in-transit', (data) => { data.fecEntr = '09/11/2026'; }))).toBeNull();
    expect(expected(changed('in-transit', (data) => { data.fecEntr = '31/02/2026'; }))).toBeNull();
    expect(expected(changed('in-transit', (data) => { data.fecEntr = '2026-11-12'; }))).toBeNull();
    expect(expected(changed('in-transit', (data) => { data.fecha = null; }))).toBe('2026-11-11');
    // A final status turns it into the delivery date, which the history already gives.
    expect(expected(changed('in-transit', (data) => { data.ultEstado!.estadoFinal = true; }))).toBeNull();
    expect(expected(changed('delivered', (data) => { data.boMuestraFechaPrevista = true; }), DELIVERED_GUID, DELIVERED_CREDENTIAL)).toBeNull();
    for (const weight of [0, -1, '2.35', 10_000, null]) {
      expect(parseATuHora(changed('in-transit', (data) => { data.pesoOri = weight; }), IN_TRANSIT_CREDENTIAL, IN_TRANSIT_GUID), String(weight))
        .not.toHaveProperty('weight_kg');
    }
  });

  it('reads any other incident as a problem with the shipment, and Pendiente de realizar as no step', () => {
    expect(aTuHoraStage('3', 'Incidencia - Ausente')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(aTuHoraStage('3', 'Incidencia - No cumplimiento agencia')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(aTuHoraStage('3', 'Motivo de muestra')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(aTuHoraStage('3', 'Incidencia - Motivo de muestra')).toMatchObject({ stage: 'exception' });
    expect(aTuHoraStage('5', 'Pendiente de realizar')).toBeNull();
    expect(aTuHoraStage('', 'Entregado con éxito')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(aTuHoraStage('99', 'Synthetic scan')).toBeNull();
    const incident = changed('in-transit', (data) => { data.estados.unshift(scan('3', 'Motivo de muestra', '11/11/2026 12:00:00')); });
    expect(parseATuHora(incident, IN_TRANSIT_CREDENTIAL, IN_TRANSIT_GUID)).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Motivo de muestra', last_update_local: '2026-11-11T12:00:00' });
    // A history whose newest rows have no step takes its stage from the newest that has one.
    const pending = changed('in-transit', (data) => { data.estados.unshift(scan('5', 'Pendiente de realizar', '11/11/2026 12:00:00')); });
    expect(parseATuHora(pending, IN_TRANSIT_CREDENTIAL, IN_TRANSIT_GUID)).toMatchObject({ status: 'out_for_delivery',
      last_status_text: 'Pendiente de realizar', last_update_local: '2026-11-11T12:00:00' });
  });

  it('keeps no recipient, sender, address, reference, remark, link, coordinates or shipment identifier', () => {
    for (const [name, credential, guid] of [['delivered', DELIVERED_CREDENTIAL, DELIVERED_GUID], ['in-transit', IN_TRANSIT_CREDENTIAL, IN_TRANSIT_GUID]] as const) {
      const result = JSON.stringify(parseATuHora(fixture(name), credential, guid));
      expect(result, name).not.toMatch(/MUESTRA|PEDIDO|CALLE|LLAMAR|600 000|https?:|example|40\.0000|3\.0000|00000000-0000|modificar/);
    }
  });

  it('counts a shipment only when it is the one the lookup named, under the number asked', async () => {
    expect(() => parseATuHora(fixture('in-transit'), DELIVERED_CREDENTIAL, IN_TRANSIT_GUID))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'A Tu Hora Express answered for another shipment' }));
    expect(() => parseATuHora(fixture('delivered'), DELIVERED_CREDENTIAL, IN_TRANSIT_GUID)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const change of [
      (data: Detail) => { data.albaran = '9990000018'; },
      (data: Detail) => { data.albaran = '999000001'; },
      (data: Detail) => { data.albaran = '99900000170'; },
      (data: Detail) => { data.codAgeCargo = '000001'; },
      (data: Detail) => { data.codAgeCargo = ''; },
    ]) {
      expect(() => parseATuHora(changed('delivered', change), DELIVERED_CREDENTIAL, DELIVERED_GUID)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The identifier is compared without case, and the numbers without padding.
    const guid = 'abcdef00-0000-4000-8000-000000000017';
    expect(parseATuHora(changed('delivered', (data) => {
      Object.assign(data, { guid: ` ${guid.toUpperCase()} `, albaran: ' 9990000017 ' });
    }), DELIVERED_CREDENTIAL, guid)).toMatchObject({ status: 'delivered' });
    await expect(carrier(replies(stub(DELIVERED_GUID), text('in-transit'))).track({ number: DELIVERED_LABEL })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('reads the lookup\'s reply as the page does', () => {
    expect(() => parseATuHoraGuid(null)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(parseATuHoraGuid({ guid: ` ${DELIVERED_GUID} ` })).toBe(DELIVERED_GUID);
    for (const payload of [{}, [], 'guid', 0, { guid: null }, { guid: 17 }, { guid: '' }, { guid: 'not-an-identifier' }, { guid: `${DELIVERED_GUID}0` }]) {
      expect(() => parseATuHoraGuid(payload), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects a changed shipment reply', () => {
    for (const payload of [
      null,
      [],
      'Realizado con éxito',
      changed('delivered', (data) => { delete data.guid; }),
      changed('delivered', (data) => { data.guid = 17; }),
      changed('delivered', (data) => { delete data.albaran; }),
      changed('delivered', (data) => { data.albaran = ''; }),
      changed('delivered', (data) => { data.albaran = 9990000017; }),
      changed('delivered', (data) => { data.codAgeCargo = null; }),
      changed('delivered', (data) => { Object.assign(data, { estados: 'none' }); }),
      changed('delivered', (data) => { Object.assign(data, { ultEstado: 'Realizado con éxito' }); }),
      changed('delivered', (data) => { Object.assign(data.estados, { 1: 'En reparto' }); }),
      changed('delivered', (data) => { data.estados[1]!.des = 5; }),
      changed('delivered', (data) => { data.estados[1]!.des = '  '; }),
      changed('delivered', (data) => { data.estados[1]!.pob = 5; }),
      changed('delivered', (data) => { data.estados[1]!.cod = -2; }),
      changed('delivered', (data) => { data.estados[1]!.cod = 2.5; }),
      changed('delivered', (data) => { data.estados[1]!.cod = true; }),
      changed('delivered', (data) => { data.estados[1]!.codInc = {}; }),
      changed('delivered', (data) => { data.estados[1]!.fecHoraAlta = '2026-05-06T08:40:49'; }),
      changed('delivered', (data) => { data.estados[1]!.fecHoraAlta = '06/05/2026'; }),
      changed('delivered', (data) => { data.estados[1]!.fecHoraAlta = '31/02/2026 08:40:49'; }),
      changed('delivered', (data) => { data.estados[1]!.fecHoraAlta = '06/05/2026 24:00:00'; }),
      changed('delivered', (data) => { data.estados[1]!.fecHoraAlta = 1778056849000; }),
      changed('delivered', (data) => { data.estados[1]!.fecHoraAlta = null; }),
      changed('delivered', (data) => { data.estados = Array.from({ length: 301 }, () => data.estados[0]!); }),
    ]) {
      expect(() => parseATuHora(payload, DELIVERED_CREDENTIAL, DELIVERED_GUID), JSON.stringify(payload)?.slice(0, 120))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = changed('delivered', (data) => { Object.assign(data, { estados: [], ultEstado: null }); });
    expect(() => parseATuHora(empty, DELIVERED_CREDENTIAL, DELIVERED_GUID)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A newest row missing from `estados` still counts.
    const latest = changed('delivered', (data) => { data.estados.shift(); });
    expect(parseATuHora(latest, DELIVERED_CREDENTIAL, DELIVERED_GUID).events).toHaveLength(8);
  });

  it('keeps an unknown code, a browser check, an error, a moved route and a rate limit apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(replies(reply(body, init))).track({ number: UNKNOWN_LABEL });
    // The page reads an empty reply as a code and postcode it does not pair.
    await expect(lookup('')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(' \n')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Forbidden', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    // A moved or withdrawn route, and a redirect.
    for (const status of [404, 405, 410]) await expect(lookup('', { status }), String(status)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://mydelivery.atuhoraexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Mantenimiento</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
    // The shipment route answers an identifier it does not know with a server error.
    const detail = (body: string, init?: ResponseInit) => carrier(replies(stub(DELIVERED_GUID), reply(body, init))).track({ number: DELIVERED_LABEL });
    await expect(detail('Internal Server Error', { status: 500, headers: { 'Content-Type': 'text/plain' } })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(detail('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED_LABEL })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED_LABEL)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failure to reach the tracker, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(stub(DELIVERED_GUID))).mockResolvedValueOnce(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ATuHoraExpressTracker({ fetcher, recorder }).fetch(DELIVERED_LABEL, null, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'a-tu-hora-express', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED_LABEL }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('recognizes the 24-digit label and an unknown one, and asks nothing for a code that needs a postcode', async () => {
    const fetcher = replies(stub(DELIVERED_GUID), text('delivered'), '');
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED_LABEL)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-06T13:41:20' });
    await expect(carrier(fetcher).recognize!(UNKNOWN_LABEL)).resolves.toEqual({ known: false });
    for (const number of [DELIVERED, IN_TRANSIT_SHORT, 'ATH9990000024']) await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('routes the 24-digit label to the adapter, and moves on from a shorter code without a postcode', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(String(url).startsWith(A_TU_HORA_LOOKUP) ? stub(DELIVERED_GUID) : text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED_LABEL, carrier: 'a-tu-hora-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'a-tu-hora-express', source: 'a-tu-hora-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === aTuHoraLookupUrl(DELIVERED_LABEL, POSTCODE))).toBe(true);
    fetcher.mockClear();
    await expect(tracker.track({ number: DELIVERED, carrier: 'a-tu-hora-express' }, { budgetMs: 3000 }))
      .rejects.toMatchObject({ attempts: [{ source: 'a-tu-hora-express', kind: 'input_required' }] });
    expect(fetcher).not.toHaveBeenCalled();
    // The catalog's optional postcode reaches the adapter with a shorter code.
    await expect(tracker.track({ number: DELIVERED, carrier: 'a-tu-hora-express', postcode: POSTCODE }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ source: 'a-tu-hora-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === aTuHoraLookupUrl(DELIVERED, POSTCODE))).toBe(true);
  });
});

describe('A Tu Hora Express numbers', () => {
  it('names the carrier for the padded code, suggests the label, and asks recognition only about the label', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'a-tu-hora-express', confidence: 'high', candidates: ['a-tu-hora-express'] });
    // The label and a sixteen-digit number without the padding keep their other candidates.
    const label = detectCarrierMatch(DELIVERED_LABEL);
    expect(label.candidates).toContain('a-tu-hora-express');
    expect(label.carrier === 'a-tu-hora-express' && label.confidence === 'high').toBe(false);
    for (const number of ['0000019990000017', '1000009990000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('a-tu-hora-express');
    }
    expect(carrierDefinition('a-tu-hora-express').tracking).toMatchObject({ adapter: 'a-tu-hora-express', localClocks: true });
    const asked = (number: string) => recognitionCandidates(number).map(({ carrier }) => carrier);
    expect(asked(DELIVERED_LABEL)).toContain('a-tu-hora-express');
    expect(asked(DELIVERED)).not.toContain('a-tu-hora-express');
  });
});

describe('A Tu Hora Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives, and the code it leaves out', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const answer = statusMapAnswer({ carrier: 'a-tu-hora-express', providerCode: entry.code ?? null, description: entry.wording });
      if (entry.unmapped) {
        expect(answer, entry.wording).toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        expect(aTuHoraStage(entry.code!, entry.wording), entry.wording).toBeNull();
      } else {
        expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
        expect(aTuHoraStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      }
    }
  });

  it('leaves an unknown code and wording to the shared rules', () => {
    expect(statusMap.stage('99', 'synthetic scan')).toBeUndefined();
    expect(statusMap.stage('5', 'en reparto')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'a-tu-hora-express', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});

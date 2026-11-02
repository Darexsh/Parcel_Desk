import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VASP_EXPRESSO_API, vaspExpressoLookupUrl, VaspExpressoTracker } from './adapter.js';
import { normalizeVaspExpressoNumber, parseVaspExpresso } from './parser.js';
import { statusMap, vaspExpressoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9990000000001';
const IN_TRANSIT = '9990000000002';
const UNKNOWN = '9990000000003';

type Row = Record<string, unknown>;
type Reply = Row & { service: Row; clientEvents: Row[]; currentEvent: Row | null };

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return JSON.stringify(reply);
};
const reply = (body: string, init: ResponseInit = {}) => new Response(init.status === 204 ? null : body,
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Vasp Expresso HTTP adapter', () => {
  it('asks the Track and Trace page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(raw('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VaspExpressoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 999 0000 000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${VASP_EXPRESSO_API}?term=${IN_TRANSIT}`);
    expect(vaspExpressoLookupUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vasp-expresso', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and stages it by its event type', () => {
    const result = parseVaspExpresso(raw('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregue ao cliente', last_update: null, last_update_local: '2026-04-16T14:05:21', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-04-16T14:05:21', '18', 'delivered', 'Sample Depot South'],
      ['2026-04-16T08:12:40', '7', 'out_for_delivery', null],
      ['2026-04-16T01:14:02', '10', 'in_transit', 'Sample Depot South'],
      // A new delivery day and the recipient's own requests move nothing.
      ['2026-04-15T19:22:08', '37', null, null],
      ['2026-04-15T19:11:30', '43', null, null],
      ['2026-04-15T19:11:30', '42', null, null],
      ['2026-04-15T17:48:55', '22', 'failed_attempt', 'Sample Depot South'],
      ['2026-04-15T07:31:17', '7', 'out_for_delivery', null],
      // The depot scan listed twice is kept once.
      ['2026-04-14T21:40:12', '10', 'in_transit', 'Sample Depot South'],
      ['2026-04-13T19:02:44', '10', 'in_transit', 'Sample Depot North'],
      ['2026-04-13T11:47:00', '1', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(result.events![6]).toMatchObject({ description: 'Incidência de distribuição: Destinatário Ausente', stage_source: 'carrier_map' });
    // The current event, which the list also holds, is not doubled; the
    // client reference and the proof of delivery are not kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE-ORDER|servicePod|canonical/);
  });

  it('heads the history with the current event the list lacks', () => {
    const result = parseVaspExpresso(raw('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'No centro de distribuição', last_update_local: '2026-05-09T00:51:12' });
    expect(result.events).toHaveLength(12);
    expect(result.events!.slice(0, 2).map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['10', 'in_transit', 'No centro de distribuição'],
      ['22', 'failed_attempt', 'Incidência de distribuição: Destinatário Ausente'],
    ]);
    expect(result.events!.filter((event) => event.provider_code === '22').map((event) => event.description)).toEqual([
      'Incidência de distribuição: Destinatário Ausente',
      'Incidência de distribuição: Sem Condições de Carga/Descarga',
      'Incidência de distribuição: Morada insuficiente',
    ]);
    expect(result.events!.find((event) => event.provider_code === '41'))
      .toMatchObject({ description: 'Incidência de armazém: Entrada em AEP', stage: 'exception' });
    // Without a current event, the list alone is the history.
    expect(parseVaspExpresso(changed('in-transit', (body) => { body.currentEvent = null; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'failed_attempt', last_update_local: '2026-05-08T18:57:31' });
  });

  it('finds a volume barcode’s service and names the service number', () => {
    const result = parseVaspExpresso(raw('delivered'), `${DELIVERED}001`);
    expect(result).toMatchObject({ current_stage: 'delivered', canonical_tracking_number: DELIVERED });
    expect(result.events).toHaveLength(11);
    expect(() => parseVaspExpresso(raw('delivered'), `${IN_TRANSIT}001`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Vasp Expresso answered for another shipment' }));
  });

  it('takes a Kios store as the scan’s place, except at creation', () => {
    const result = parseVaspExpresso(changed('in-transit', (body) => {
      body.currentEvent = null;
      Object.assign(body.clientEvents[0]!, { eventTypeId: 12, eventDescriptionPT: 'Na loja Kios', incidencePT: null, incidenceENG: null,
        kios: 'Sample Kios Store' });
      body.clientEvents.at(-1)!.kios = 'Sample Kios Store';
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: '12', stage: 'ready_for_pickup', location: 'Sample Kios Store' });
    expect(result.events!.at(-1)).not.toHaveProperty('location');
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
  });

  it('falls back to the English wording, and to the shared wording rules for a type it does not map', () => {
    const result = parseVaspExpresso(changed('in-transit', (body) => {
      body.currentEvent = null;
      Object.assign(body.clientEvents[0]!, { eventTypeId: 99, eventDescriptionPT: null, eventDescriptionENG: 'Returned to sender',
        incidencePT: null, incidenceENG: null });
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: '99', description: 'Returned to sender', stage: 'returned',
      stage_source: expect.stringMatching(/^wording:/) });
  });

  it('reads an empty reply as not found and a service without scans as no history', () => {
    for (const body of ['', '  ', 'null', '\uFEFF']) {
      expect(() => parseVaspExpresso(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    }
    expect(() => parseVaspExpresso(changed('delivered', (body) => { body.clientEvents = []; body.currentEvent = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseVaspExpresso(changed('delivered', (body) => { delete (body as Row).clientEvents; delete (body as Row).currentEvent; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a service only when it names the number asked', () => {
    expect(() => parseVaspExpresso(raw('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Vasp Expresso answered for another shipment' }));
    expect(() => parseVaspExpresso(changed('delivered', (body) => { body.service.serviceBarCode = `${DELIVERED}9`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).service; },
      (body: Reply) => { body.service = 'service' as never; },
      (body: Reply) => { body.service.serviceBarCode = 9990000000001; },
      (body: Reply) => { body.service.serviceBarCode = ' '; },
      (body: Reply) => { body.clientEvents = 'events' as never; },
      (body: Reply) => { body.clientEvents = Array.from({ length: 501 }, () => body.clientEvents[1]!); },
      (body: Reply) => { body.clientEvents[1] = 'scan' as never; },
      (body: Reply) => { body.currentEvent = 'current' as never; },
      (body: Reply) => { body.clientEvents[1]!.eventTypeId = '7'; },
      (body: Reply) => { body.clientEvents[1]!.eventTypeId = 7.5; },
      (body: Reply) => { body.clientEvents[1]!.eventTypeId = -1; },
      (body: Reply) => { body.clientEvents[1]!.eventDate = '16/04/2026 08:12'; },
      (body: Reply) => { body.clientEvents[1]!.eventDate = '2026-02-30T08:12:40'; },
      (body: Reply) => { body.clientEvents[1]!.eventDate = '2026-04-16T24:00:00'; },
      (body: Reply) => { body.clientEvents[1]!.eventDate = '0001-01-01T00:00:00'; },
      (body: Reply) => { body.clientEvents[1]!.eventDate = '2026-04-16T08:12:40Z'; },
      (body: Reply) => { delete body.clientEvents[1]!.eventDate; },
      (body: Reply) => { body.clientEvents[1]!.eventDescriptionPT = ['Carregado']; },
      (body: Reply) => { body.clientEvents[1]!.eventDescriptionPT = ''; body.clientEvents[1]!.eventDescriptionENG = null; },
      (body: Reply) => { body.clientEvents[1]!.depotName = { name: 'Sample Depot' }; },
      (body: Reply) => { body.clientEvents[1]!.kios = 7; },
    ]) {
      expect(() => parseVaspExpresso(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseVaspExpresso('{"service":', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseVaspExpresso('[]', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The page reads an empty reply as "Não existe registo".
    await expect(lookup('', { status: 204 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.vaspexpresso.pt/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Access Denied</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // The site's own pages load reCAPTCHA; one in place of the reply is a changed route.
    await expect(lookup('<html><title>Vasp Expresso</title><script src="https://www.google.com/recaptcha/api.js"></script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    // The service's failure when it gets no number, which says nothing about a parcel.
    await expect(lookup('System.ArgumentNullException: Value cannot be null.', { status: 500, headers: { 'Content-Type': 'text/plain' } }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty answer, and asks nothing for a number Vasp Expresso does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(raw('delivered')))
      .mockResolvedValueOnce(reply('', { status: 204 }))
      .mockResolvedValueOnce(reply(raw('in-transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-16T14:05:21' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // An answer for another service is no recognition.
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('99900000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Vasp Expresso does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['999000000000', '99900000000001', '999000000000100', '99900000000010000', 'VASP000000001', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeVaspExpressoNumber('999-0000-000-001 001')).toBe(`${DELIVERED}001`);
  });

  it('tries a read that never reaches the site once more inside the budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 200 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    const recovered = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(raw('in-transit')));
    await expect(carrier(recovered).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under Vasp Expresso to the adapter, and detection claims none', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(raw('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'vasp-expresso' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'vasp-expresso', source: 'vasp-expresso', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(VASP_EXPRESSO_API))).toBe(true);
    for (const number of [DELIVERED, `${DELIVERED}001`, '9040000000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('vasp-expresso');
    }
  });
});

describe('Vasp Expresso status vocabulary', () => {
  it('records every event type the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) continue;
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(vaspExpressoStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'vasp-expresso', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(vaspExpressoStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'vasp-expresso', providerCode: '22', description: 'Incidência de distribuição: Destinatário Ausente' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'vasp-expresso', providerCode: '99', description: 'Devolvido' })).toEqual({ kind: 'unknown' });
    expect(vaspExpressoStage('98', 'Synthetic note')).toBeNull();
  });
});

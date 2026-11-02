import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NINETYNINE_API, NinetynineTracker } from './adapter.js';
import { normalizeNinetynineNumber, parseNinetynine, parseNinetynineSummary, readConcern } from './parser.js';
import { ninetynineIncident, ninetynineStage, ninetynineWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9000000001';
const COLOMBIA = '9000000002';
const ABROAD = '9000000003';
const ABSENT = '9999999999';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const concern = (number: string, status: string, trackingId: number | null = status === 'success' ? Number(number) : null) =>
  [{ status, eta: null, requested_tracking: number, tracking_id: trackingId, internal_key: null }];
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
/** A service that answers the search, the summary and the history with these replies. */
const service = (search: () => Response, track: () => Response = () => reply(fixture('delivered-track')),
  detail: () => Response = () => reply(fixture('delivered-detail'))) => vi.fn<typeof fetch>().mockImplementation(async (url) => {
  const path = String(url).slice(NINETYNINE_API.length);
  return path === 'concerns' ? search() : path.endsWith('/track') ? track() : detail();
});
const found = (number: string, track: () => Response = () => reply(fixture('delivered-track')),
  detail: () => Response = () => reply(fixture('delivered-detail'))) => service(() => reply(concern(number, 'success')), track, detail);
const summary = (name: string, number: string, fields: Reply = {}) => parseNinetynineSummary({ ...fixture(name), ...fields }, number);
const rows = (result: ReturnType<typeof parseNinetynine>) => result.events!.map((event) => [event.time, event.provider_code, event.stage]);

describe('99minutos tracking adapter', () => {
  it('asks the search, the summary and the history in turn through the supplied transport, as the tracker does', async () => {
    const fetcher = found(DELIVERED);
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NinetynineTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000 000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://tracking-prd.hub.99min.io/api/v1/tracking/concerns',
      `https://tracking-prd.hub.99min.io/api/v1/tracking/${DELIVERED}/track`,
      `https://tracking-prd.hub.99min.io/api/v1/tracking/${DELIVERED}/detail`,
    ]);
    const [search, track, detail] = fetcher.mock.calls.map(([, init]) => init!);
    expect(search).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0',
      Origin: 'https://tracking.99minutos.com', 'x-action': 'search' } });
    expect(JSON.parse(String(search!.body))).toEqual({ concerns: [DELIVERED], token: 'secure' });
    for (const init of [track!, detail!]) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
      // The service refuses a JSON type without a body.
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has('content-type')).toBe(false);
    }
    for (const init of [search!, track!, detail!]) {
      const headers = new Headers(init.headers);
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: '99minutos', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, each row once, with its offset clock and the tracker’s wording', () => {
    const result = parseNinetynine(summary('delivered-track', DELIVERED), fixture('delivered-detail'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Tu pedido fue entregado exitosamente.', last_update: '2031-04-02T19:57:33Z',
      expected_delivery: null, delivered_at: '2031-04-02T19:57:33Z',
      events: [
        { time: '2031-04-02T19:57:33Z', description: 'Tu pedido fue entregado exitosamente.', provider_code: 'Delivery', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2031-04-02T14:10:19Z', description: 'Tu pedido está en camino hacia tu domicilio', provider_code: 'ToDelivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2031-04-02T09:31:02Z', description: 'Tu pedido está en nuestro almacén, estamos preparándonos para entregarlo.', provider_code: 'Warehouse', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2031-04-02T02:05:44Z', description: 'Tu pedido va en camino hacia la ciudad de destino', provider_code: 'Linehaul', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2031-04-01T23:48:09Z', description: 'Tu pedido está en nuestro almacén, estamos preparándonos para entregarlo.', provider_code: 'Warehouse', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2031-04-01T18:15:27Z', description: 'Ya hemos recogido tu pedido en el negocio.', provider_code: 'Collected', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2031-04-01T16:40:00Z', description: 'Vamos en camino al negocio a recoger tu pedido.', provider_code: 'Collecting', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2031-04-01T15:02:11Z', description: 'Orden creada: Tu pedido está siendo preparado por el negocio.', provider_code: 'Created', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // Remarks, evidence, the shop's key, addresses and stations stay behind.
    const text = JSON.stringify(result);
    for (const value of ['Synthetic', 'Example Person', 'Titular', 'operario', 'EXA', 'EXB', 'Ejemplo', 'Inventada', 'Ficticio', 'hasEvidence', 'NXD']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('keeps an offset other than UTC as the reply gives it, and orders equal clocks as the reply lists them', () => {
    const result = parseNinetynine(summary('delivered-track', DELIVERED, { status_web: 'Warehouse', status: 3001 }), [
      { id: 'c1', status: 'Collected', created_at: '2031-01-10T09:00:00-06:00' },
      { id: 'c2', status: 'Warehouse', created_at: '2031-01-10T15:00:00Z' },
      { id: 'c3', status: 'Linehaul', created_at: '2031-01-10T15:00:00.000Z' },
    ], DELIVERED);
    expect(rows(result)).toEqual([
      ['2031-01-10T15:00:00Z', 'Linehaul', 'in_transit'],
      ['2031-01-10T15:00:00Z', 'Warehouse', 'in_transit'],
      ['2031-01-10T09:00:00-06:00', 'Collected', 'accepted'],
    ]);
    // The summary's status decides, whatever the newest row says.
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Tu pedido está en nuestro almacén, estamos preparándonos para entregarlo.' });
  });

  it('lists only the milestones Colombia’s tracker shows and gives the estimate its day in Bogotá', () => {
    const result = parseNinetynine(summary('colombia-track', COLOMBIA), fixture('colombia-detail'), COLOMBIA);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'failed_attempt', last_status_text: 'No pudimos entregar tu pedido',
      last_update: '2031-07-08T13:30:00Z', expected_delivery: '2031-07-08',
    });
    expect(rows(result).map(([, code]) => code)).toEqual(['ToDelivery', 'Linehaul', 'Collected', 'Created']);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toContain('Cliente ausente');
  });

  it('shows an estimate only while the tracker does, never older than the newest row', () => {
    const detail = fixture('colombia-detail');
    const day = (fields: Reply, history: unknown = detail) => parseNinetynine(summary('colombia-track', COLOMBIA, fields), history, COLOMBIA).expected_delivery;
    expect(day({ status_web: 'Linehaul', status: 3004 })).toBe('2031-07-08');
    expect(day({ status_web: 'ToDelivery', status: 4001 })).toBe('2031-07-08');
    expect(day({ status_web: 'Linehaul', status: 3004 }, [])).toBe('2031-07-08');
    for (const fields of [{ status_web: 'Delivery', status: 4002 }, { status_web: 'ToReturn', status: 5001 }, { status_web: 'Collected', status: 2003 },
      { status_web: 'Linehaul', status: 8002 }, { status_web: 'Linehaul', country: 'CHL' }, { status_web: 'Linehaul', country: 'PER' },
      { status_web: 'Linehaul', eta: null }, { status_web: 'Linehaul', eta: '2031-07-07T12:00:00Z' }]) {
      expect(day(fields), JSON.stringify(fields)).toBeNull();
    }
    // Mexico's day is the carrier's home zone's.
    expect(parseNinetynine(summary('delivered-track', DELIVERED, { status_web: 'Linehaul', eta: '2031-04-03T05:30:00Z' }), [], DELIVERED).expected_delivery)
      .toBe('2031-04-02');
    expect(() => summary('colombia-track', COLOMBIA, { eta: '2031-07-09 03:00:00' })).toThrow('without an offset');
  });

  it('reads a summary without history, an incident code and a status name the map does not know', () => {
    expect(parseNinetynine(summary('delivered-track', DELIVERED, { status_web: 'Linehaul', status: 3004 }), [], DELIVERED)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Tu pedido va en camino hacia la ciudad de destino', provider_code: 'Linehaul', summary_only: true,
      last_update: null, expected_delivery: '2031-04-02', events: [],
    });
    const incident = parseNinetynine(summary('delivered-track', DELIVERED, { status_web: 'Warehouse', status: 8006 }), fixture('delivered-detail').slice(0, 4), DELIVERED);
    expect(incident).toMatchObject({ status: 'exception', current_stage: 'exception', expected_delivery: null,
      last_status_text: expect.stringMatching(/^Tu pedido presenta una incidencia/) });
    expect(parseNinetynine(summary('delivered-track', DELIVERED, { status_web: 'NotShowIncidence', status: 7101 }), [
      { id: 'd1', status: 'NotShowIncidence', created_at: '2031-04-01T15:00:00Z' }], DELIVERED)).toMatchObject({
      current_stage: 'exception', last_status_text: 'Hubo un incidente con tu pedido, por favor contacta a Atención al Cliente',
      events: [{ provider_code: 'NotShowIncidence', stage: 'exception', description: 'Hubo un incidente con tu pedido, por favor contacta a Atención al Cliente' }] });
    // A new name keeps its own word and the newest known row's stage.
    const unknown = parseNinetynine(summary('delivered-track', DELIVERED, { status_web: 'SyntheticStatus', status: 9999 }), [
      { id: 'e1', status: 'Collected', created_at: '2031-04-01T15:00:00Z' }, { id: 'e2', status: 'SyntheticStatus', created_at: '2031-04-01T16:00:00Z' }], DELIVERED);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'SyntheticStatus' });
    expect(unknown.events![0]).toEqual({ time: '2031-04-01T16:00:00Z', description: 'SyntheticStatus', provider_code: 'SyntheticStatus' });
    expect(parseNinetynine(summary('delivered-track', DELIVERED, { status_web: 'SyntheticStatus' }), [], DELIVERED))
      .toMatchObject({ status: 'unknown', provider_code: 'SyntheticStatus', summary_only: true });
  });

  it('hands an international shipment to UPS by its own number, without asking for the history', async () => {
    const fetcher = found(ABROAD, () => reply(fixture('international-track')));
    await expect(carrier(fetcher).track({ number: ABROAD })).resolves.toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Tu pedido va en camino hacia la ciudad de destino', provider_code: 'Linehaul', summary_only: true,
      last_update: null, expected_delivery: null, delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784', events: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A key that is no UPS number hands nothing over; a domestic shipment's key is never read.
    for (const fields of [{ internal_key: '1Z999AA10123456785' }, { internal_key: 'EXA-000-003' }, { delivery_type: 'NXD', internal_key: '1Z999AA10123456784' }]) {
      const result = parseNinetynine(summary('international-track', ABROAD, fields), [], ABROAD);
      expect(result, JSON.stringify(fields)).not.toHaveProperty('delivery_carrier');
      expect(JSON.stringify(result)).not.toContain('1Z999');
    }
  });

  it('binds every reply to the whole guía and rejects replies it cannot read', async () => {
    expect(() => readConcern(concern(DELIVERED, 'success'), DELIVERED)).not.toThrow();
    expect(() => readConcern([{ ...concern(DELIVERED, 'success')[0], tracking_id: String(DELIVERED) }], DELIVERED)).not.toThrow();
    for (const payload of [concern(ABSENT, 'success'), concern(DELIVERED, 'success', 9000000004), concern(DELIVERED, 'success', null), [], [...concern(DELIVERED, 'success'), ...concern(DELIVERED, 'success')]]) {
      expect(() => readConcern(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const payload of [{}, null, [null], concern(DELIVERED, 'pending')]) {
      expect(() => readConcern(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const fields of [{ tracking_id: 9000000004 }, { tracking_id: null }, { tracking_id: 90000000010 }]) {
      expect(() => summary('delivered-track', DELIVERED, fields), JSON.stringify(fields)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const fields of [{ status_web: null }, { status_web: 4 }, { status: '4002' }, { eta: 5 }, { country: {} }]) {
      expect(() => summary('delivered-track', DELIVERED, fields), JSON.stringify(fields)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const parsed = summary('delivered-track', DELIVERED);
    for (const detail of [{}, [null], [{ status: 'Created' }], [{ status: 'Created', created_at: '2031-04-01 15:02:11' }], [{ created_at: '2031-04-01T15:02:11Z' }],
      Array.from({ length: 501 }, () => ({ status: 'Created', created_at: '2031-04-01T15:02:11Z' }))]) {
      expect(() => parseNinetynine(parsed, detail, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const other = service(() => reply(concern(ABSENT, 'success')));
    await expect(carrier(other).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
    const swapped = found(DELIVERED, () => reply(fixture('colombia-track')));
    await expect(carrier(swapped).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('takes guías of seven to ten digits only, without a request', async () => {
    expect(normalizeNinetynineNumber(' 9000-000-001 ')).toBe(DELIVERED);
    expect(normalizeNinetynineNumber('1234567')).toBe('1234567');
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '123456', '01234567', '12345678901', '99MEX0000001', 'MX000000001', '9000000001A', 'ZZ00000000', ` ${'9'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the search’s own error as unknown and recognizes a known guía, from plain HTTP', async () => {
    const absent = service(() => reply(concern(ABSENT, 'error')));
    await expect(carrier(absent).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(absent).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(absent).toHaveBeenCalledTimes(2);
    await expect(carrier(found(DELIVERED)).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2031-04-02T19:57:33.000Z' });
  });

  it('asks for the recipient’s details where the tracker does, and keeps a failed summary or history open', async () => {
    const validate = service(() => reply(concern(DELIVERED, 'validate')));
    await expect(carrier(validate).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'input_required', field: 'recipient verification' });
    expect(validate).toHaveBeenCalledTimes(1);
    await expect(carrier(found(DELIVERED, () => reply({ message: 'Unauthorized' }, 401))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'input_required' });
    await expect(carrier(found(DELIVERED, undefined, () => reply({ message: 'Unauthorized' }, 401))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'input_required' });
    // The summary's bare 404 relays a failed lookup; the history's 500 is the service failing to read events.
    await expect(carrier(found(DELIVERED, () => reply({ message: 'Request failed with status code 404' }, 404))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(found(DELIVERED, undefined, () => reply({ message: '2 UNKNOWN: failed to retrieve events' }, 500))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(found(DELIVERED, undefined, () => reply('', 404))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [400, 'transport'], [500, 'indeterminate'], [503, 'maintenance'], [404, 'transport'], [401, 'transport'], [302, 'transport']] as const)(
    'keeps a search answered with HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = service(() => status === 302 ? new Response(null, { status, headers: { Location: '/' } }) : reply('', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps challenges, pages and oversized replies apart from missing shipments', async () => {
    const challenge = service(() => reply('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'));
    await expect(carrier(challenge).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['', '<html><head><title>99minutos - Rastreo</title></head><body><div id="root"></div></body></html>', '[{"status":']) {
      await expect(carrier(service(() => reply(body))).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
      await expect(carrier(found(DELIVERED, () => reply(body))).track({ number: DELIVERED }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = found(DELIVERED, undefined, () => new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const replies = [() => reply(concern(DELIVERED, 'success')), () => reply(fixture('delivered-track')), () => reply(fixture('delivered-detail'))];
    let calls = 0;
    const flaky = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      calls += 1;
      if (calls === 2) throw new TypeError('fetch failed');
      const path = String(url).slice(NINETYNINE_API.length);
      return (path === 'concerns' ? replies[0]! : path.endsWith('/track') ? replies[1]! : replies[2]!)();
    });
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(5);
    const immediate = found(DELIVERED);
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a guía to the adapter when the caller names 99minutos, which detection never offers', async () => {
    for (const number of [DELIVERED, '900000001', '1234567']) {
      expect(detectCarrierMatch(number)?.carrier).not.toBe('99minutos');
      expect(recognitionAskedCarriers(number)).not.toContain('99minutos');
    }
    for (const link of [`https://tracking.99minutos.com/search/${DELIVERED}`, `https://rastreo.99minutos.com/search/${DELIVERED}/`, `https://99minutos.com/tracking/${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: '99minutos', source: 'link' });
    }
    const fetcher = found(DELIVERED);
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: '99minutos' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: '99minutos', source: '99minutos', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(NINETYNINE_API))).toBe(true);
  });
});

describe('99minutos status vocabulary', () => {
  it('records every status name the map knows with the stage and wording it gives', () => {
    const recorded = new Set<string>();
    for (const entry of statuses.entries) {
      recorded.add(entry.code);
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(entry.code, wording), entry.code).toBe(entry.stage);
      expect(ninetynineWording(entry.code), entry.code).toBe(entry.wording);
      expect(statusMapAnswer({ carrier: '99minutos', providerCode: entry.code, description: wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    for (const code of ['Draft', 'Created', 'Collecting', 'UnsuccessfulCollect', 'Collected', 'Warehouse', 'Linehaul', 'ToDelivery', 'Delivery',
      'ToReturn', 'Return', 'UnsuccessfulDelivery', 'ToP99', 'P99', 'Cancelled', 'TheftOrLoss', 'Damaged', 'NotShowIncidence']) {
      expect(recorded.has(code), code).toBe(true);
    }
    for (const code of ['constructor', 'toString', 'delivery', 'DELIVERED', '4002']) {
      expect(ninetynineStage(code), code).toBeUndefined();
      expect(ninetynineWording(code), code).toBeUndefined();
    }
    expect([8001, 8002, 8003, 8004, 8006].every(ninetynineIncident)).toBe(true);
    expect([8005, 4002, '8001', null].some(ninetynineIncident)).toBe(false);
    expect(statusMapAnswer({ carrier: '99minutos', providerCode: null, description: 'tu pedido fue entregado exitosamente.' })).toEqual({ kind: 'unknown' });
  });
});

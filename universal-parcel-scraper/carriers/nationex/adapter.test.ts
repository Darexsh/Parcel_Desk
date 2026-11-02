import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NATIONEX_ENDPOINT, NationexTracker } from './adapter.js';
import { normalizeNationexNumber, parseNationex } from './parser.js';
import { nationexScanStage, nationexStateLabel, nationexStateStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900000123';
const TRANSIT = '900000456';
const CREATED = '900000789';
const SHIPMENT = '900000321';
const ABSENT = '900000999';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const NOT_FOUND = { code: 404, message: 'Sorry, no results.' };
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
const moved = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseNationex>) => result.events!.map((event) => [event.local_time, event.provider_code, event.stage]);
/** The transit fixture with its state, and its state history's newest entry, changed. */
const transitWith = (state: string | number, latest?: string | number): Reply => {
  const shipment = fixture('transit');
  shipment.ShipmentStatus = state;
  if (latest !== undefined) shipment.StatusHistories.push({ ...shipment.StatusHistories.at(-1), ShipmentStatus: latest });
  return shipment;
};
/** A scan added to the transit fixture's parcel, newest. */
const withScan = (shipment: Reply, scan: Reply): Reply => {
  shipment.Parcels[0].History.unshift({ ...shipment.Parcels[0].History[0], ...scan });
  return shipment;
};

describe('Nationex tracking adapter', () => {
  it('asks the shipment service once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NationexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' #900 000 123 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://nationex.com/api/nationex/get-shipment/${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'nationex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first, as wall clocks, with each scan once and its depot', () => {
    const result = parseNationex(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery completed - Parcel left at the front door', last_update: null,
      last_update_local: '2026-03-04T14:05:12', expected_delivery: null,
      events: [
        { local_time: '2026-03-04T14:05:12', description: 'Picture taken', location: 'EXAMPLEVILLE', provider_code: '730' },
        { local_time: '2026-03-04T14:05:12', description: 'Delivery completed - Parcel left at the front door', location: 'EXAMPLEVILLE',
          provider_code: '119', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-04T08:01:40', description: 'Delivery notifications sent to the consignee', location: 'EXAMPLEVILLE', provider_code: '720' },
        { local_time: '2026-03-04T07:12:03', description: 'Parcel out for delivery', location: 'EXAMPLEVILLE', provider_code: '900',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-04T03:22:51', description: 'Parcel scanned', location: 'SAMPLE HUB', provider_code: '901',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T22:47:09', description: 'Parcel scanned', location: 'SAMPLE HUB', provider_code: '903',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T16:31:27', description: 'Pickup of the parcel confirmed', location: 'EXAMPLEVILLE', provider_code: '52',
          stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T09:15:00', description: 'Driver in route for pickup', location: 'EXAMPLEVILLE', provider_code: '910',
          stage: 'registered', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T17:16:11', description: 'Shipment created', provider_code: '538', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The signer, the recipient's postcode and town, positions, references, notes and help texts stay behind.
    const text = JSON.stringify(result);
    for (const value of ['SYNTHETIC SIGNER', 'A1A 1A1', 'SYNTHETICTOWN', 'SYNTHETIC-REF-77', 'Synthetic note', 'Synthetic help', '46.75', '-71.25', '4242', 'Livraison']) {
      expect(text, value).not.toContain(value);
    }
    // The French wording stands in when the English is missing.
    const french = fixture('delivered');
    french.Parcels[0].History[1].DescriptionEn = null;
    expect(parseNationex(french, DELIVERED).events![1]).toMatchObject({ description: 'Livraison complétée - Colis laissé à la porte avant', stage: 'delivered' });
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const shipment = fixture('transit');
    const history = shipment.Parcels[0].History.reverse();
    history[2].ProcessedDate = history[1].ProcessedDate;
    expect(parseNationex(shipment, TRANSIT).events!.map((event) => event.provider_code)).toEqual(['901', '903', '52', '910', '538']);
  });

  it('shows the expected day only while the parcel is on its way and the day has not passed', () => {
    expect(parseNationex(fixture('transit'), TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'Parcel scanned', last_update_local: '2026-03-11T03:22:51', expected_delivery: '2026-03-12' });
    // Before the pickup the tracker says the day is still to come.
    expect(parseNationex(fixture('created'), CREATED)).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'Shipment created', expected_delivery: null });
    const late = fixture('transit');
    late.Parcels[0].EstimatedDeliveryDate = '2026-03-10';
    expect(parseNationex(late, TRANSIT).expected_delivery).toBeNull();
    const today = fixture('transit');
    today.Parcels[0].EstimatedDeliveryDate = '2026-03-11';
    expect(parseNationex(today, TRANSIT).expected_delivery).toBe('2026-03-11');
    for (const value of ['', null, '2026-02-30', '12/03/2026', '2026-03-12T09:30:00']) {
      const odd = fixture('transit');
      odd.Parcels[0].EstimatedDeliveryDate = value;
      expect(parseNationex(odd, TRANSIT).expected_delivery, String(value)).toBeNull();
    }
  });

  it('merges the parcels of a shipment and keeps a partial delivery on its way, while a parcel number reads that parcel', () => {
    const shipment = parseNationex(fixture('multi-parcel'), SHIPMENT);
    expect(shipment).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Partially delivered', last_update_local: '2026-03-24T11:40:00', expected_delivery: '2026-03-25' });
    // The scans both parcels share appear once.
    expect(rows(shipment)).toEqual([
      ['2026-03-24T11:40:00', '119', 'delivered'],
      ['2026-03-24T07:12:03', '900', 'out_for_delivery'],
      ['2026-03-23T22:47:09', '903', 'in_transit'],
      ['2026-03-23T16:31:27', '252', 'accepted'],
      ['2026-03-23T09:00:02', '538', 'registered'],
    ]);
    expect(parseNationex(fixture('multi-parcel'), `${SHIPMENT}01`)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_status_text: 'Delivery completed - Parcel left at the front door', expected_delivery: null });
    const second = parseNationex(fixture('multi-parcel'), `${SHIPMENT}02`);
    expect(second).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Parcel out for delivery',
      last_update_local: '2026-03-24T07:12:03', expected_delivery: '2026-03-25' });
    expect(second.events).toHaveLength(4);
  });

  it('counts a reply only when its shipment or one of its parcels is the number asked', () => {
    // The service also matches delivery notices and sender references, which name another shipment.
    for (const [name, number] of [['transit', DELIVERED], ['multi-parcel', `${SHIPMENT}03`], ['multi-parcel', `${DELIVERED}01`], ['delivered', '000000000']]) {
      expect(() => parseNationex(fixture(name!), number!), number).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const twice = fixture('multi-parcel');
    twice.Parcels[1].ParcelId = Number(`${SHIPMENT}01`);
    expect(() => parseNationex(twice, `${SHIPMENT}01`)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Numbers or strings alike.
    const strings = fixture('transit');
    strings.ShipmentId = TRANSIT;
    strings.Parcels[0].History[0].ExceptionId = '901';
    expect(parseNationex(strings, TRANSIT).events![0]).toMatchObject({ provider_code: '901', stage: 'in_transit' });
  });

  it('takes a problem the tracker shows from the state history, unless the shipment is delivered', () => {
    expect(parseNationex(transitWith('Transit', 'Attention'), TRANSIT)).toMatchObject({ status: 'exception', current_stage: 'exception',
      current_stage_source: 'carrier_map', last_status_text: 'Attention', expected_delivery: null });
    expect(parseNationex(transitWith('Transit', 500), TRANSIT)).toMatchObject({ current_stage: 'exception', last_status_text: 'Cancelled' });
    expect(parseNationex(transitWith('Delivered', 'PickupAttemptFailed'), TRANSIT)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(parseNationex(transitWith('OnHold'), TRANSIT)).toMatchObject({ current_stage: 'exception', last_status_text: 'On hold' });
    expect(parseNationex(transitWith('ReturnToSender'), TRANSIT)).toMatchObject({ status: 'exception', current_stage: 'returned' });
    // A state the map does not know leaves the scans to decide.
    expect(parseNationex(transitWith('Mystery'), TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Parcel scanned' });
    // A parcel number reads the parcel's own state history.
    const parcel = fixture('multi-parcel');
    parcel.Parcels[1].ParcelStatusHistories.push({ ParcelStatus: 'RefusedDelivery' });
    expect(parseNationex(parcel, `${SHIPMENT}02`)).toMatchObject({ current_stage: 'exception', last_status_text: 'Refused delivery' });
    expect(parseNationex(parcel, SHIPMENT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('lets a problem scan stand until the shipment is settled, and stages new wording through the shared rules', () => {
    const attempt = { ExceptionId: 150, ProcessedDate: '2026-03-11T12:00:00', DescriptionEn: 'Delivery attempt - nobody at the door' };
    expect(parseNationex(withScan(fixture('transit'), attempt), TRANSIT)).toMatchObject({ current_stage: 'failed_attempt',
      current_stage_source: expect.stringMatching(/^wording:/), last_status_text: 'Delivery attempt - nobody at the door', expected_delivery: null });
    expect(parseNationex(withScan(transitWith('Delivered'), attempt), TRANSIT)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    const unknown = parseNationex(withScan(transitWith('Mystery'), { ...attempt, DescriptionEn: 'Synthetic note on file' }), TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note on file' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-11T12:00:00', description: 'Synthetic note on file', location: 'SAMPLE HUB', provider_code: '150' });
    // A state ahead of the newest scan names itself.
    expect(parseNationex(transitWith('OutForDelivery'), TRANSIT)).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Out for delivery' });
  });

  it('answers with the state alone when the parcel lists no scan, and has no history without either', () => {
    const empty = fixture('created');
    empty.Parcels[0].History = [];
    expect(parseNationex(empty, CREATED)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Creation', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    empty.ShipmentStatus = 'Mystery';
    expect(() => parseNationex(empty, CREATED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('caps the history it returns', () => {
    const long = fixture('transit');
    long.Parcels[0].History = Array.from({ length: 120 }, (_, index) => ({ ...long.Parcels[0].History[0],
      ProcessedDate: `2026-03-${String(1 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00` }));
    const result = parseNationex(long, TRANSIT);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
    expect(result.events![0]!.local_time).toBe('2026-03-05T23:00:00');
  });

  it('keeps only the exact not-found notice as a missing shipment', () => {
    expect(() => parseNationex(NOT_FOUND, ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [{ code: 404, message: 'Something else' }, { code: 500, message: 'Sorry, no results.' },
      { name: 'Bad Request', message: 'Unable to verify your data submission.', code: 0, status: 400 },
      { message: 'cURL error 28: Operation timed out' }, { status: 502 }]) {
      expect(() => parseNationex(payload, ABSENT), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('rejects replies it cannot read', () => {
    const broken: Array<(shipment: Reply) => void> = [
      (shipment) => { shipment.ShipmentId = 12345; },
      (shipment) => { shipment.ShipmentId = null; },
      (shipment) => { shipment.Parcels = null; },
      (shipment) => { shipment.Parcels = [null]; },
      (shipment) => { shipment.Parcels[0].History = {}; },
      (shipment) => { shipment.Parcels[0].History[0] = 'scan'; },
      (shipment) => { shipment.Parcels[0].History[0].ProcessedDate = '2026-02-30T10:00:00'; },
      (shipment) => { shipment.Parcels[0].History[0].ProcessedDate = '2026-03-11T24:00:00'; },
      (shipment) => { shipment.Parcels[0].History[0].ProcessedDate = '2026-03-11T10:00:00+01:00'; },
      (shipment) => { shipment.Parcels[0].History[0].ProcessedDate = null; },
      (shipment) => { Object.assign(shipment.Parcels[0].History[0], { DescriptionEn: '', DescriptionFr: null }); },
      (shipment) => { shipment.Parcels[0].History[0].CityDepot = { name: 'SAMPLE HUB' }; },
      (shipment) => { shipment.StatusHistories = 'Transit'; },
      (shipment) => { shipment.StatusHistories.push(null); },
      (shipment) => { shipment.ShipmentStatus = ['Transit']; },
      (shipment) => { shipment.Parcels = Array.from({ length: 301 }, () => shipment.Parcels[0]); },
    ];
    for (const [index, change] of broken.entries()) {
      const shipment = fixture('transit');
      change(shipment);
      expect(() => parseNationex(shipment, TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], 'Sorry, no results.', { Shipments: [] }]) {
      expect(() => parseNationex(payload, TRANSIT), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes nine-digit shipment and eleven-digit parcel numbers only, without a request', async () => {
    expect(normalizeNationexNumber(' 900 000 123 ')).toBe(DELIVERED);
    expect(normalizeNationexNumber('#90000032101')).toBe(`${SHIPMENT}01`);
    const fetcher = vi.fn<typeof fetch>();
    // A delivery notice, a sender reference, and numbers of other lengths.
    for (const number of ['123456', 'REF-77', '90000012', '9000001234', '900000123012', '90000O123', '', `${'9'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the not-found notice as unknown and recognizes a known shipment, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('transit'))).mockResolvedValueOnce(reply(NOT_FOUND))
      .mockResolvedValueOnce(reply(NOT_FOUND));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-11T03:22:51' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Another shipment's reference match is no answer either way.
    const other = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('transit')));
    await expect(carrier(other).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps redirects, challenges, pages and oversized replies apart from missing shipments', async () => {
    for (const response of [() => moved('https://nationex.com/reperage'), () => moved('/', 301), () => new Response(null, { status: 307 })]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const challenge = vi.fn<typeof fetch>().mockImplementation(async () =>
      reply('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'));
    await expect(carrier(challenge).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['', '<html><head><title>Maintenance</title></head><body>Back soon</body></html>', '{"ShipmentId":']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(4_100_000)));
    await expect(carrier(large).track({ number: TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('transit')));
    await expect(carrier(flaky).track({ number: TRANSIT })).resolves.toMatchObject({ status: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('transit')));
    await expect(carrier(immediate).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number to the adapter when the caller names Nationex, which detection never offers', async () => {
    for (const number of [DELIVERED, `${SHIPMENT}01`]) {
      expect(detectCarrierMatch(number)?.carrier).not.toBe('nationex');
      expect(recognitionAskedCarriers(number)).not.toContain('nationex');
    }
    for (const link of [`https://nationex.com/reperage/${DELIVERED}`, `https://www.nationex.com/tracking/${DELIVERED}/`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'nationex', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'nationex' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'nationex', source: 'nationex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${NATIONEX_ENDPOINT}${DELIVERED}`)).toBe(true);
  });
});

describe('Nationex status vocabulary', () => {
  it('records every scan code and state the maps know with the stage they give', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      if (entry.note?.startsWith('A shipment state')) {
        expect(nationexStateStage(entry.code), entry.code).toBe(stage);
        expect(nationexScanStage(entry.code), entry.code).toBeUndefined();
        if ('wording' in entry) expect(nationexStateLabel(entry.code), entry.code).toBe(entry.wording);
        continue;
      }
      expect(nationexScanStage(entry.code), entry.code).toBe(stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording!)), entry.code).toBe(stage);
      expect(statusMapAnswer({ carrier: 'nationex', providerCode: entry.code, description: entry.wording! }), entry.code)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(nationexStateStage('500')).toBe('exception');
    expect(nationexStateLabel('501')).toBe('Cancelled');
    expect(nationexStateLabel('PartiallyOutForDelivery')).toBe('Partially out for delivery');
    for (const code of ['constructor', 'toString', '0', '1190']) {
      expect(nationexScanStage(code), code).toBeUndefined();
      expect(nationexStateStage(code), code).toBeUndefined();
    }
    expect(statusMapAnswer({ carrier: 'nationex', providerCode: '150', description: 'Parcel scanned' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'nationex', providerCode: null, description: 'Parcel scanned' })).toEqual({ kind: 'unknown' });
  });
});

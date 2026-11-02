import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FEDEX_FREIGHT_ENDPOINT, FedexFreightTracker, fedexFreightRequestBody } from './adapter.js';
import { normalizeFedexFreightNumber, parseFedexFreight } from './parser.js';
import { fedexFreightMappedStage, fedexFreightStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const TRANSIT = '9900000101';
const DELIVERED = '9900000202';
const ABSENT = '9999999999';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const shipment = (payload: Reply): Reply => payload.output.packages[0];
const scans = (payload: Reply): Reply[] => shipment(payload).scanEventList;
/** The delivered fixture after a change. */
const delivered = (change: (payload: Reply) => void) => {
  const payload = fixture('delivered');
  change(payload);
  return payload;
};
const staged = (time: string, description: string, location: string | null, code: string, stage: string) =>
  ({ time, description, ...(location ? { location } : {}), provider_code: code, stage, stage_source: 'carrier_map' });

describe('FedEx Freight tracking adapter', () => {
  it('posts the tracking page’s request once for the PRO number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FedexFreightTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 990-000-0202 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.ltl.tech/fxf-external-tracking-auth4/fxfgw/route/track/v2/track-shipments');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'X-client-id': 'FDXFWEB', 'X-locale': 'en_US', 'X-version': '1.0.0',
      'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({
      appDeviceType: 'WTRK', appType: 'WTRK', summaryView: false, supportHTML: true, supportCurrentLocation: true,
      trackingInfo: [{ trackNumberInfo: { trackingCarrier: '', trackingNumber: DELIVERED, trackingQualifier: '' } }],
      uniqueKey: '', guestAuthenticationToken: '',
    });
    const headers = new Headers(init!.headers);
    for (const name of ['cookie', 'authorization', 'origin', 'referer']) expect(headers.has(name), name).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fedex-freight', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a shipment in transit newest first, with each terminal’s town, offset clocks and the estimated day', () => {
    expect(parseFedexFreight(fixture('in-transit'), TRANSIT)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'At local facility', last_update: '2026-03-04T21:58:31-05:00', expected_delivery: '2026-03-06',
      weight_kg: 204.117, service_name: 'FedEx Freight Economy', destination_country: 'US',
      events: [
        staged('2026-03-04T21:58:31-05:00', 'At local facility', 'RIVERDELL, WA', 'AF', 'in_transit'),
        staged('2026-03-03T20:11:09-05:00', 'On the way', 'MESAWOOD, NV', 'IT', 'in_transit'),
        staged('2026-03-02T23:47:15-05:00', 'Left origin facility', 'OAKMERE, IL', 'DP', 'in_transit'),
        staged('2026-03-02T14:05:11-05:00', 'Picked up', 'OAKMERE, IL', 'PU', 'accepted'),
        // The bill of lading comes before pickup, without a place.
        staged('2026-03-01T10:00:00-05:00', 'Shipment information sent to FedEx Freight', null, 'OC', 'registered'),
      ],
    });
  });

  it('reads a delivery once per scan, with the arrival and the exception’s reason, and leaves the people and references behind', () => {
    const result = parseFedexFreight(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-04-09T10:26:50-05:00', expected_delivery: null,
      delivered_at: '2026-04-09T10:26:50-05:00', weight_kg: 105.233, service_name: 'FedEx Freight Economy', destination_country: 'US',
      events: [
        staged('2026-04-09T10:26:50-05:00', 'Delivered', 'PINEFIELD, CO', 'DL', 'delivered'),
        staged('2026-04-09T10:02:13-05:00', 'At delivery: Arrived at customer location for delivery', 'PINEFIELD, CO', 'AR', 'out_for_delivery'),
        staged('2026-04-09T07:31:44-05:00', 'Out for delivery', 'PINEFIELD, CO', 'OD', 'out_for_delivery'),
        staged('2026-04-08T15:40:20-05:00', 'At local facility', 'PINEFIELD, CO', 'AF', 'in_transit'),
        // The scan listed twice is kept once.
        staged('2026-04-08T03:10:00-05:00', 'On the way', 'LAKEMONT, MO', 'IT', 'in_transit'),
        staged('2026-04-07T23:55:00-05:00', 'Shipment exception: Weather – Delay in transit', 'LAKEMONT, MO', 'SE', 'exception'),
        staged('2026-04-07T22:10:00-05:00', 'On the way', 'LAKEMONT, MO', 'IT', 'in_transit'),
        staged('2026-04-07T18:02:00-05:00', 'Left origin facility', 'OAKMERE, IL', 'DP', 'in_transit'),
        staged('2026-04-07T16:12:00-05:00', 'Picked up', 'OAKMERE, IL', 'PU', 'accepted'),
        staged('2026-04-06T09:00:00-05:00', 'Shipment information sent to FedEx Freight', null, 'OC', 'registered'),
      ],
    });
    // Parties, the receiver and signee, the driver, streets, postcodes, references and coordinates stay behind.
    const text = JSON.stringify(result);
    for (const value of ['SYNTHSIGN', 'SAMPLE SIGNER', 'SAMPLETON', 'SHIPVILLE', 'Synthetic Way', 'Sample Street', 'Sample Driver',
      'Sample Consignee', '00002', '00012', 'PO-SYNTH', 'BOL-SYNTH', 'SHIP-REF', '-90.0001', '-91.2345', 'Prepaid', '2461000'])
      expect(text, value).not.toContain(value);
  });

  it('keeps a scan without an offset as a wall clock, and orders scans by clock with ties in the reply’s order', () => {
    const local = parseFedexFreight(delivered((payload) => { for (const scan of scans(payload)) scan.gmtOffset = ''; }), DELIVERED);
    expect(local).toMatchObject({ last_update: null, last_update_local: '2026-04-09T10:26:50', current_stage: 'delivered' });
    expect(local.delivered_at).toBeUndefined();
    expect(local.events![0]).toEqual({ local_time: '2026-04-09T10:26:50', description: 'Delivered', location: 'PINEFIELD, CO',
      provider_code: 'DL', stage: 'delivered', stage_source: 'carrier_map' });
    // Another offset is read as given.
    const western = parseFedexFreight(delivered((payload) => { scans(payload)[0].gmtOffset = '-07:00'; }), DELIVERED);
    expect(western).toMatchObject({ last_update: '2026-04-09T10:26:50-07:00', delivered_at: '2026-04-09T10:26:50-07:00' });

    const shuffled = parseFedexFreight(delivered((payload) => {
      const list = scans(payload);
      shipment(payload).scanEventList = [list[9], list[3], list[0], list[1], list[2]];
      shipment(payload).scanEventList[1] = { ...list[3], status: 'Synthetic note', statusCD: 'ZZ' };
      shipment(payload).scanEventList.splice(1, 0, list[3]);
    }), DELIVERED);
    expect(shuffled.events!.map((event) => event.description)).toEqual([
      'Delivered', 'At delivery: Arrived at customer location for delivery', 'Out for delivery', 'At local facility', 'Synthetic note', 'Picked up']);
  });

  it('keeps scans of one instant in the order of a reply listed oldest first', () => {
    const result = parseFedexFreight(delivered((payload) => {
      const list = scans(payload).reverse();
      list[6] = { ...list[6], status: 'Synthetic note', statusCD: 'ZZ' };
    }), DELIVERED);
    expect(result.events!.slice(3, 6).map((event) => event.description)).toEqual(['At local facility', 'Synthetic note', 'On the way']);
  });

  it('stages scans by code, the arrival at the consignee by its exception code, then the shared wording rules', () => {
    const stageOf = (row: Reply) => parseFedexFreight(delivered((payload) => {
      scans(payload)[0] = { ...scans(payload)[0], recipientSignee: '', delivered: false, ...row };
    }), DELIVERED).current_stage;
    expect(stageOf({ status: 'Synthetic', statusCD: 'od' })).toBe('out_for_delivery');
    expect(stageOf({ status: 'Synthetic arrival', statusCD: 'AR', statusExceptionCode: 'darv' })).toBe('out_for_delivery');
    // Another arrival keeps to its wording; wording nobody knows gives no stage, and the next staged scan decides.
    expect(stageOf({ status: 'Package returned to sender', statusCD: 'AR', statusExceptionCode: 'XX' })).toBe('returned');
    const unknown = parseFedexFreight(delivered((payload) => {
      scans(payload)[0] = { ...scans(payload)[0], status: 'Synthetic note', statusCD: 'ZZ', statusExceptionCode: '', delivered: false };
    }), DELIVERED);
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note', expected_delivery: null });
    expect(unknown.delivered_at).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-04-09T10:26:50-05:00', description: 'Synthetic note', location: 'PINEFIELD, CO',
      provider_code: 'ZZ' });
    // A delivery keeps its status alone; details that repeat the status add nothing.
    const detailed = parseFedexFreight(delivered((payload) => { scans(payload)[0].scanDetails = 'Signed for by SYNTHSIGN'; }), DELIVERED);
    expect(detailed.events![0]!.description).toBe('Delivered');
    expect(JSON.stringify(detailed)).not.toContain('SYNTHSIGN');
    const repeated = parseFedexFreight(delivered((payload) => { scans(payload)[2].scanDetails = 'out for delivery'; }), DELIVERED);
    expect(repeated.events![2]!.description).toBe('Out for delivery');
  });

  it('answers with the summary alone before any scan, and reads the estimate and weight only when they read', () => {
    const bare = delivered((payload) => { shipment(payload).scanEventList = []; });
    expect(parseFedexFreight(bare, DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      provider_code: 'DL', last_update: null, expected_delivery: null, summary_only: true, events: [],
    });
    const nothing = delivered((payload) => { shipment(payload).scanEventList = null; shipment(payload).keyStatus = ''; });
    expect(() => parseFedexFreight(nothing, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));

    const shaped = (change: (target: Reply) => void) => {
      const payload = fixture('in-transit');
      change(shipment(payload));
      return parseFedexFreight(payload, TRANSIT);
    };
    for (const value of ['', null, '03/06/2026', '2026-02-30T00:00:00-06:00']) {
      expect(shaped((target) => { target.estDeliveryDt = value; }).expected_delivery, String(value)).toBeNull();
    }
    for (const value of ['', '0', '-4', 'n/a', '1000000', null]) {
      expect(shaped((target) => { target.totalLbsWgt = value; }).weight_kg, String(value)).toBeUndefined();
    }
    expect(shaped((target) => { target.totalLbsWgt = 1; }).weight_kg).toBe(0.454);
    for (const value of [null, {}, { countryCode: 'USA' }]) {
      expect(shaped((target) => { target.recipientAddress = value; }).destination_country, JSON.stringify(value)).toBeUndefined();
    }
    expect(shaped((target) => { target.serviceDesc = ''; }).service_name).toBeUndefined();
  });

  it('caps the history it returns', () => {
    const long = delivered((payload) => {
      const row = scans(payload)[4];
      shipment(payload).scanEventList = Array.from({ length: 120 }, (_, index) => ({ ...row,
        date: `2026-04-${String(1 + Math.floor(index / 24)).padStart(2, '0')}`, time: `${String(index % 24).padStart(2, '0')}:00:00` }));
    });
    const result = parseFedexFreight(long, DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
  });

  it('counts only a package the page reads as not found as missing, and a reply only for the number and service asked', () => {
    expect(() => parseFedexFreight(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const absent = (change: (target: Reply) => void) => {
      const payload = fixture('not-found');
      change(shipment(payload));
      return () => parseFedexFreight(payload, ABSENT);
    };
    expect(absent((target) => { target.errorList = [{ code: 'TRACKING.TRACKINGNUMBER.NOTFOUND', message: '' }]; }))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(absent((target) => { target.notFound = false; target.invalid = true; })).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // A qualified package flagged missing, an error without the flag, or no flag at all is no answer either way.
    expect(absent((target) => { target.trackingQualifier = 'SYNTHETIC~QUALIFIER'; })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(absent((target) => { target.notFound = false; target.errorList = [{ code: 'SYSTEM.UNAVAILABLE.EXCEPTION' }]; }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page asks the visitor to sign in for these.
    for (const code of ['TRACKING.AUTHORIZATION.ERROR', 'tracking.accountnumber.mismatch']) {
      expect(absent((target) => { target.errorList = [{ code, message: '' }]; }), code).toThrow(expect.objectContaining({ kind: 'input_required' }));
    }
    // The service gives an empty answer to a value it refuses too.
    expect(() => parseFedexFreight(fixture('empty'), ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFedexFreight(fixture('delivered'), ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = delivered((payload) => { payload.output.packages.push({ ...shipment(payload), trackingQualifier: 'SYNTHETIC~OTHER' }); });
    expect(() => parseFedexFreight(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Another package beside the one asked for is left alone.
    const beside = delivered((payload) => { payload.output.packages.push({ ...shipment(payload), trackingNbr: ABSENT }); });
    expect(parseFedexFreight(beside, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    // FedEx Freight's own codes only; another FedEx service's history is not relayed.
    for (const code of ['FDXG', 'FXCC', '', null]) {
      expect(() => parseFedexFreight(delivered((payload) => { shipment(payload).trackingCarrierCd = code; }), DELIVERED), String(code))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseFedexFreight(delivered((payload) => { shipment(payload).trackingCarrierCd = 'FDFR'; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects replies it cannot read', () => {
    const broken: Array<(payload: Reply) => void> = [
      (payload) => { payload.output.packages = {}; },
      (payload) => { payload.output.packages = Array.from({ length: 51 }, () => shipment(payload)); },
      (payload) => { payload.output.packages[0] = 'found'; },
      (payload) => { shipment(payload).trackingNbr = { id: DELIVERED }; },
      (payload) => { shipment(payload).errorList = 'none'; },
      (payload) => { shipment(payload).errorList = ['TRACKING.AUTHORIZATION.ERROR']; },
      (payload) => { shipment(payload).notFound = 'false'; },
      (payload) => { shipment(payload).scanEventList = {}; },
      (payload) => { shipment(payload).scanEventList = Array.from({ length: 501 }, () => scans(payload)[1]); },
      (payload) => { scans(payload)[1] = null; },
      (payload) => { scans(payload)[1].date = '2026-02-30'; },
      (payload) => { scans(payload)[1].date = '04/09/2026'; },
      (payload) => { scans(payload)[1].time = '24:00:00'; },
      (payload) => { scans(payload)[1].time = '10:02'; },
      (payload) => { scans(payload)[1].time = null; },
      (payload) => { scans(payload)[1].gmtOffset = 'CDT'; },
      (payload) => { scans(payload)[1].gmtOffset = '-0500'; },
      (payload) => { scans(payload)[1].status = ''; scans(payload)[1].scanDetails = ''; },
      (payload) => { scans(payload)[1].status = { text: 'At delivery' }; },
      (payload) => { scans(payload)[1].delivered = 'false'; },
      (payload) => { shipment(payload).keyStatus = ['Delivered']; },
    ];
    for (const [index, change] of broken.entries()) {
      expect(() => parseFedexFreight(delivered(change), DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], {}, 'Not found.', { output: {} }, { output: [] }, fixture('refused-request')]) {
      expect(() => parseFedexFreight(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes a ten-digit PRO number and refuses other input without a request', async () => {
    expect(normalizeFedexFreightNumber(' 990.000.0202 ')).toBe(DELIVERED);
    expect(JSON.parse(fedexFreightRequestBody('990 000 0202')).trackingInfo[0].trackNumberInfo.trackingNumber).toBe(DELIVERED);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '990000020', '99000002020', 'AB00000202', '990000020/', '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it.each([[400, 'schema'], [403, 'challenge'], [301, 'transport'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('keeps HTTP %s as %s, without a retry', async (status, kind) => {
    const body = status === 400 || status === 500 ? fixture('refused-request') : '';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status));
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the rate limit’s wait, block pages, other pages and oversized replies apart from missing shipments', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(reply('', 429, { 'Retry-After': '30' }));
    await expect(carrier(limited).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    for (const body of [
      '<html><head><title>Access Denied</title></head><body>You don\'t have permission to access this server. Reference #18.0000 https://errors.edgesuite.net/18.0000</body></html>',
      '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'challenge' });
    }
    for (const body of ['', '<html><head><title>Detailed Tracking</title></head><body><app-root></app-root></body></html>', '{"output":']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
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

  it('routes a PRO number to the adapter when the caller names FedEx Freight, which detection and recognition never offer', async () => {
    for (const number of [TRANSIT, DELIVERED, ABSENT]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('fedex-freight');
      expect(recognitionAskedCarriers(number), number).not.toContain('fedex-freight');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'fedex-freight' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'fedex-freight', source: 'fedex-freight', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === FEDEX_FREIGHT_ENDPOINT)).toBe(true);
  });
});

describe('FedEx Freight status vocabulary', () => {
  it('records every code and wording seen with the stage the map gives', () => {
    for (const entry of statuses.entries) {
      const label = `${entry.code} ${entry.wording}`;
      expect(fedexFreightStage(entry.code, '', entry.wording), label).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), label).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'fedex-freight', providerCode: entry.code, description: entry.wording }), label)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    for (const code of ['constructor', 'toString', 'ZZ', 'AR', '']) expect(fedexFreightMappedStage(code), code).toBeUndefined();
    expect(statusMap.stage('AR', normalizeStatusWording('Arrived at FedEx location'))).toBeUndefined();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
  });
});

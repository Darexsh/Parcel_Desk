import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { carrierIdFromName, carrierIdFromPartner } from '../../core/catalog/hints.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ARAMEX_AU_ENDPOINT, AramexAuTracker, aramexAuUrl } from './adapter.js';
import { normalizeAramexAuNumber, parseAramexAu } from './parser.js';
import { aramexAuMappedStage, aramexAuStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'QX0000000042';
const TRANSIT = '2Q0000000017';
const LABELLED = 'QZ0000000033';
const SSCC = '00399999900000000423';
const ALIAS_LABEL = 'QX9000000058';
const ABSENT = 'QX9999999990';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
/** The fixture changed in place by `change`. */
const edited = (name: string, change: (result: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload.result);
  return payload;
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'text/javascript; charset=utf-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

describe('Aramex Australia tracking adapter', () => {
  it('asks the tracking page’s service once for the number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AramexAuTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' qx 0000-000042 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.aramex.com.au/umbraco/api/TrackingApi/GetTrackingData?LabelNo=${DELIVERED}&dataFormat=json`);
    expect(String(url)).toBe(aramexAuUrl(DELIVERED));
    expect(String(url).startsWith(ARAMEX_AU_ENDPOINT)).toBe(true);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal),
      headers: { Accept: expect.stringContaining('application/json'), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'aramex-au', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first as the page shows it, on the depots’ wall clocks', () => {
    const result = parseAramexAu(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-05T13:09:14', expected_delivery: null, service_name: 'Economy Delivery',
    });
    expect(result.delivered_at).toBeUndefined();
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.events).toEqual([
      { local_time: '2026-03-05T13:09:14', description: 'Delivered', location: 'Northgate', provider_code: 'R36', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-03-05T06:45:26', description: 'Onboard for delivery', location: 'Northgate', provider_code: 'ONB',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-03-05T04:30:05', description: 'Received into Depot', location: 'Northgate', provider_code: 'RID', stage: 'in_transit', stage_source: 'carrier_map' },
      // The page's name for the regional linehaul partner's depot.
      { local_time: '2026-03-04T05:12:40', description: 'Your parcel is in our care', location: 'Aramex Regional Network', provider_code: 'RIA',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-03T19:01:00', description: 'In transit', location: 'Eastport', provider_code: 'SYD', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-03T15:00:55', description: 'Picked up from sender', location: 'Eastport', provider_code: 'PP1', stage: 'accepted', stage_source: 'carrier_map' },
      // No place before pickup.
      { local_time: '2026-03-02T08:24:18', description: 'Sender preparing parcel for pick-up', provider_code: 'PP8', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    // The label's own record, internal scans, explanations, parties, couriers and references stay behind.
    const text = JSON.stringify(result);
    for (const value of ['Consignment created', 'Internal', 'successfully delivered', 'Signer Fixture', 'Fixture Pty', '2999', 'ZZfixture',
      'Recipient Fixture', 'REF-FIXTURE', 'NAC', 'safe place']) expect(text, value).not.toContain(value);
  });

  it('gives the page’s delivery estimate only while the parcel moves, and keeps a label notice after pickup from setting it back', () => {
    const transit = parseAramexAu(fixture('in-transit'), TRANSIT);
    expect(transit).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Consignment Information Submitted',
      last_update_local: '2026-03-10T19:30:00', expected_delivery: null, service_name: 'Priority Delivery' });
    // The newest scan is the label notice, so the page shows no estimate; without it, it does.
    const moving = edited('in-transit', (result) => { result.Scans.pop(); });
    expect(parseAramexAu(moving, TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Parcel In Transit',
      expected_delivery: '2026-03-13' });
    expect(JSON.stringify(parseAramexAu(moving, TRANSIT))).not.toContain('Fixture');
    for (const [label, change] of [
      ['passed', (result: Reply) => { result.Scans.pop(); result.PickupFranchiseCurrentDate = '14/03/2026'; }],
      ['reissued label', (result: Reply) => { result.Scans.pop(); result.Scans[0].Status = 'PP5'; }],
      ['no delivery depot', (result: Reply) => { result.Scans.pop(); result.DeliveryFranchiseCode = ''; }],
      ['unreadable', (result: Reply) => { result.Scans.pop(); result.DeliveryETADate = '2026-03-13'; }],
      ['impossible', (result: Reply) => { result.Scans.pop(); result.DeliveryETADate = '31/02/2026'; }],
    ] as const) expect(parseAramexAu(edited('in-transit', change), TRANSIT).expected_delivery, label).toBeNull();
    // The same day, or no date at the pickup depot, still shows it.
    const today = edited('in-transit', (result) => { result.Scans.pop(); result.PickupFranchiseCurrentDate = '13/03/2026'; });
    expect(parseAramexAu(today, TRANSIT).expected_delivery).toBe('2026-03-13');
    const undated = edited('in-transit', (result) => { result.Scans.pop(); result.PickupFranchiseCurrentDate = null; });
    expect(parseAramexAu(undated, TRANSIT).expected_delivery).toBe('2026-03-13');
  });

  it('reads a parcel the courier has not collected as registered, without a place, service or estimate', () => {
    const result = parseAramexAu(fixture('pre-pickup'), LABELLED);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', expected_delivery: null, last_status_text: 'Tracking number allocated' });
    expect(result.service_name).toBeUndefined();
    expect(result.events).toEqual([{ local_time: '2026-03-12T07:15:42', description: 'Tracking number allocated', provider_code: 'PP2',
      stage: 'registered', stage_source: 'carrier_map' }]);
    // Only the label's own record: the tracker lists the parcel, the page shows nothing.
    const bare = edited('pre-pickup', (result) => { result.Scans.pop(); });
    expect(() => parseAramexAu(bare, LABELLED)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('reads a parcel asked by the sender’s SSCC and keeps Aramex’s own label', async () => {
    const result = parseAramexAu(fixture('sscc-alias'), SSCC);
    expect(result).toMatchObject({ current_stage: 'in_transit', canonical_tracking_number: ALIAS_LABEL });
    expect(result.events![0]).toMatchObject({ provider_code: '054', stage: 'in_transit', location: 'Northgate' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('sscc-alias')));
    await expect(carrier(fetcher).track({ number: `(00) ${SSCC.slice(2)}` })).resolves.toMatchObject({ canonical_tracking_number: ALIAS_LABEL });
    expect(String(fetcher.mock.calls[0]![0])).toContain(`LabelNo=${SSCC}&`);
  });

  it('counts a reply only for the number asked, and only the service’s own error for it as a missing parcel', () => {
    expect(() => parseAramexAu(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAramexAu(fixture('not-found'), DELIVERED)).toThrow('answered for another number');
    expect(() => parseAramexAu(fixture('delivered'), TRANSIT)).toThrow('answered for another number');
    expect(() => parseAramexAu(fixture('sscc-alias'), ALIAS_LABEL)).toThrow('answered for another number');
    for (const error of ['Something went wrong.', 'An error has occurred.', { message: 'busy' }]) {
      expect(() => parseAramexAu({ error, data: null }, ABSENT), JSON.stringify(error)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('rejects replies it cannot read', () => {
    const broken: [string, Reply][] = [
      ['array', []],
      ['without its parcel', { generated_in: '1ms' }],
      ['parcel not an object', { result: 'parcel' }],
      ['scans not a list', edited('delivered', (result) => { result.Scans = {}; })],
      ['scan not an object', edited('delivered', (result) => { result.Scans[1] = 'scan'; })],
      ['scan without a clock', edited('delivered', (result) => { result.Scans[1].RealDateTime = '02/03/2026 08:24:18'; })],
      ['impossible clock', edited('delivered', (result) => { result.Scans[1].RealDateTime = '2026-02-30 24:00:00'; })],
      ['hour 24', edited('delivered', (result) => { result.Scans[1].RealDateTime = '2026-03-02 24:00:00'; })],
      ['scan without heading', edited('delivered', (result) => { result.Scans[1].Description = ' '; })],
      ['heading not text', edited('delivered', (result) => { result.Scans[1].Description = { text: 'Delivered' }; })],
      ['label not text', edited('delivered', (result) => { result.LabelNumber = [DELIVERED]; })],
    ];
    for (const [label, payload] of broken) expect(() => parseAramexAu(payload, DELIVERED), label).toThrow(expect.objectContaining({ kind: 'schema' }));
    const long = edited('delivered', (result) => { result.Scans.push(...Array.from({ length: 300 }, () => result.Scans[2])); });
    expect(() => parseAramexAu(long, DELIVERED)).toThrow('invalid parcel history');
  });

  it('caps the history it returns and leaves a scan nobody knows without a stage', () => {
    const many = edited('delivered', (result) => { result.Scans.splice(1, 0, ...Array.from({ length: 120 }, () => result.Scans[3])); });
    const capped = parseAramexAu(many, DELIVERED);
    expect(capped.events).toHaveLength(100);
    expect(capped.history_truncated).toBe(true);
    const odd = edited('delivered', (result) => { Object.assign(result.Scans.at(-1), { Status: 'ZQX', Description: 'Parcel scanned' }); });
    expect(parseAramexAu(odd, DELIVERED)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Parcel scanned' });
    expect(parseAramexAu(odd, DELIVERED).events![0]).toEqual({ local_time: '2026-03-05T13:09:14', description: 'Parcel scanned', location: 'Northgate',
      provider_code: 'ZQX' });
    // A heading the map does not know goes to the code, then the shared rules.
    const card = edited('delivered', (result) => { Object.assign(result.Scans.at(-1), { Status: 'CCL', Description: 'Calling card left', Type: 'T' }); });
    expect(parseAramexAu(card, DELIVERED)).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
    const worded = edited('delivered', (result) => { Object.assign(result.Scans.at(-1), { Status: 'U05', Description: 'Return to sender' }); });
    expect(parseAramexAu(worded, DELIVERED).events![0]).toMatchObject({ provider_code: 'U05', stage: 'exception', stage_source: expect.stringMatching(/^wording:/) });
    // A place with a digit, an odd code, and the depot the page leaves out on a delivery.
    const places = edited('delivered', (result) => {
      result.Scans.at(-1).Name = 'Devonport';
      result.Scans.at(-2).Name = 'Unit 4';
      result.Scans.at(-3).Status = 'r-i-d';
    });
    const [delivered, onboard, depot] = parseAramexAu(places, DELIVERED).events!;
    expect(delivered!.location).toBeUndefined();
    expect(onboard!.location).toBeUndefined();
    expect(depot).toMatchObject({ description: 'Received into Depot', stage: 'in_transit' });
    expect(depot!.provider_code).toBeUndefined();
  });

  it('takes a label or a valid SSCC and refuses other input without a request', async () => {
    expect(normalizeAramexAuNumber(' 2q-0000 000017 ')).toBe(TRANSIT);
    expect(normalizeAramexAuNumber('U90000000017')).toBe('U90000000017');
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['MP000000004', 'QX00000000420', '220000000042', 'MPX000000042', '00399999900000000424', '1'.repeat(70), '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a parcel the tracker has scans for and reads its unknown number as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T13:09:14' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const other = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(carrier(other).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps the rate limit’s wait, block pages, other pages and oversized replies apart from missing parcels', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(reply('', 429, { 'Retry-After': '30' }));
    await expect(carrier(limited).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    for (const body of ['<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>You don\'t have permission to access this server.</BODY></HTML>']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    }
    for (const body of ['', '<!DOCTYPE html><html><head><title>Track your parcel | Aramex</title></head><body></body></html>', '{"result":']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
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

  it('offers Aramex Australia its two-character labels for recognition, beside the other twelve-character formats', () => {
    for (const number of [DELIVERED, TRANSIT, LABELLED, ABSENT]) {
      expect(detectCarrierMatch(number).candidates, number).toContain('aramex-au');
      expect(recognitionAskedCarriers(number), number).toContain('aramex-au');
    }
    // A letter and a digit is a shape other networks share; the SSCC names the sender, not the carrier.
    for (const number of ['U90000000017', SSCC, 'MP000000004', 'MPX000000042', '220000000042']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('aramex-au');
    }
  });

  it('reads tracker links on Aramex Australia’s and Fastway’s old hosts, and names the carrier from its home page', () => {
    for (const link of [`https://www.aramex.com.au/tools/track?l=${DELIVERED}`, `https://www.aramex.com.au/tools/track/?l=${DELIVERED}`,
      `https://www.fastway.com.au/tools/track/?l=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'aramex-au', source: 'link' });
    }
    expect(carrierIdFromPartner('', 'https://www.aramex.com.au/')).toBe('aramex-au');
    // The Middle East network's site stays with the global carrier.
    expect(carrierIdFromPartner('', 'https://www.aramex.com/')).not.toBe('aramex-au');
    expect(carrierIdFromName('Aramex Australia')).toBe('aramex-au');
    expect(carrierIdFromName('Fastway Australia')).toBe('aramex-au');
    expect(carrierIdFromName('Fastway')).toBeUndefined();
  });

  it('tracks a parcel UBI hands to Aramex Australia under the label UBI names', async () => {
    expect(deliveryHandoff('ubi-smart-parcel', 'AU0000000000025', { delivery_carrier: 'aramex-au', delivery_tracking_number: DELIVERED }))
      .toEqual({ carrier: 'aramex-au', number: DELIVERED, basis: 'partner' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(ARAMEX_AU_ENDPOINT)
      ? reply(fixture('delivered')) : reply('', 500));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'aramex-au' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'aramex-au', source: 'aramex-au', result: { current_stage: 'delivered' } });
  });
});

describe('Aramex Australia status vocabulary', () => {
  it('records every code and heading the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const wording = ('wording' in entry ? entry.wording : undefined) ?? '';
      const label = `${entry.code} ${wording}`;
      expect(aramexAuStage(entry.code, wording), label).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(entry.code, normalizeStatusWording(wording)), label).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'aramex-au', providerCode: entry.code, description: wording || 'Scan' }), label)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('lets the heading decide over the code, and leaves the page’s problem codes to their wording', () => {
    // The page script counts PP1 among scans before pickup; its heading says otherwise.
    expect(aramexAuMappedStage('PP1', 'Picked up from sender')).toBe('accepted');
    expect(aramexAuMappedStage('PP1', 'Something new')).toBeUndefined();
    expect(aramexAuMappedStage('B72', 'Processed by customs')).toBe('in_transit');
    expect(aramexAuMappedStage('B72', 'Held by customs')).toBeUndefined();
    expect(aramexAuStage('B72', 'Held by customs')).toMatchObject({ stage: 'customs' });
    expect(aramexAuMappedStage('OZS', 'Parcel scanned')).toBeUndefined();
    for (const code of ['constructor', 'toString', 'XYZ', '']) expect(aramexAuMappedStage(code, 'Parcel scanned'), code).toBeUndefined();
    expect(statusMap.stage(null, 'delivered')).toBe('delivered');
    expect(statusMap.stage(null, 'parcel scanned')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'aramex-au', providerCode: 'ZZZ', description: 'Parcel scanned' })).toEqual({ kind: 'unknown' });
  });
});

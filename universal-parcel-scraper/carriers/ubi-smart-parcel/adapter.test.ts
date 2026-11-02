import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, UBI_ENDPOINT, UbiSmartParcelTracker } from './adapter.js';
import { normalizeUbiNumber, parseUbi, readUbiReply } from './parser.js';
import { statusMap, ubiMappedStage, ubiStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'AU0000000000017';
const PARTNER = '99ZZZ000000101000000017';
const LINEHAUL = 'AU0000000000025';
const ARAMEX = 'MP0000000042';
const CANADA = '7000000000000018';
const ABSENT = 'AU9999999999999';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
// After every fixture scan, so a booked flight counts.
const LATER = Date.parse('2026-04-01T00:00:00Z');
/** The fixture's parcel as found by another of its numbers. */
const askedBy = (name: string, number: string): Reply => {
  const payload = fixture(name);
  payload.data.queryTrackingNos = [number];
  payload.data.trackParcelEvents[0].trackingNo = number;
  return payload;
};
/** The fixture's scans changed in place by `change`. */
const withScans = (name: string, change: (scans: Reply[]) => void): Reply => {
  const payload = fixture(name);
  change(payload.data.trackParcelEvents[0].events);
  return payload;
};

describe('UBI Smart Parcel tracking adapter', () => {
  it('asks the tracker’s service once for the number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('auspost-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new UbiSmartParcelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' au0000000000017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://shipper.ubismartparcel.com/api/aggregator/v1/track/trackParcel');
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', language: 'en_US',
      Origin: 'https://shipper.ubismartparcel.com', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ trackingNo: DELIVERED, serverName: 'shipper.ubismartparcel.com' });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ubi-smart-parcel', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first, each scan once, and names Australia Post with its number', () => {
    const result = parseUbi(fixture('auspost-delivered'), DELIVERED, LATER);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED - LEFT IN A SAFE PLACE', last_update: '2026-03-12T13:41:07+11:00', expected_delivery: null,
      delivered_at: '2026-03-12T13:41:07+11:00', delivery_carrier: 'australia-post', delivery_tracking_number: PARTNER, destination_country: 'AU',
    });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events).toHaveLength(17);
    expect(result.events!.slice(0, 2)).toEqual([
      { time: '2026-03-12T13:41:07+11:00', description: 'DELIVERED - LEFT IN A SAFE PLACE', location: 'WATTLE CREEK, VIC', provider_code: 'DLD',
        stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-03-12T08:12:44+11:00', description: 'WITH AUSTRALIA POST FOR DELIVERY TODAY', location: 'GUMTREE PARK, VIC', provider_code: 'INF-OFD',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    // The receipt under each number is kept, the shipping information once.
    expect(result.events!.filter((event) => event.provider_code === 'RCV').map((event) => event.location)).toEqual(['EASTPORT', 'RIVERMOUTH']);
    expect(result.events!.filter((event) => event.description === 'SHIPPING INFORMATION RECEIVED')).toEqual([
      { time: '2026-02-27T10:15:36+08:00', description: 'SHIPPING INFORMATION RECEIVED', provider_code: 'INF', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    // A place part with a digit, the scan ids, parties and the site's hours stay behind.
    expect(result.events!.find((event) => event.provider_code === 'HDD')).toMatchObject({ location: 'NORTH QUAY' });
    const text = JSON.stringify(result);
    for (const value of ['3999', 'ZZfixture', '17001', 'Mon–Fri', 'Handover to Post']) expect(text, value).not.toContain(value);
  });

  it('keeps an offset for hub scans on China’s clock and partner scans recorded after it, else the wall clock', () => {
    const delivered = parseUbi(fixture('auspost-delivered'), DELIVERED, LATER).events!;
    const at = (code: string, description?: string) => delivered.find((event) => event.provider_code === code
      && (!description || event.description === description));
    // UBI's own scans abroad carry a label that ignores daylight saving time.
    expect(at('ARR')).toMatchObject({ local_time: '2026-03-10T09:30:00' });
    expect(at('INF', 'ARRIVED AT DESTINATION AIRPORT')).toMatchObject({ local_time: '2026-03-09T18:50:00' });
    for (const event of [at('ARR'), at('INF', 'ARRIVED AT DESTINATION AIRPORT')]) expect(event!.time).toBeUndefined();
    expect(at('CCD')).toMatchObject({ time: '2026-03-09T16:05:00+11:00' });
    expect(at('LHL')).toMatchObject({ time: '2026-03-08T23:40:00+08:00' });

    // Aramex's wall clock under China's label.
    const linehaul = parseUbi(fixture('aramex-linehaul'), LINEHAUL, LATER).events!;
    expect(linehaul.find((event) => event.location === 'WTL')).toEqual({ local_time: '2026-03-19T03:16:42',
      description: expect.stringMatching(/^THE SENDER IS NOW COMPLETING/), location: 'WTL', provider_code: 'INF', stage: 'registered', stage_source: 'carrier_map' });

    // Canada Post's zone abbreviation, and UBI's arrival there as a wall clock.
    const canada = parseUbi(fixture('canada-transit'), CANADA, LATER);
    expect(canada).toMatchObject({ last_update: null, last_update_local: '2026-01-20T06:10:00', destination_country: 'CA' });
    expect(canada.events!.filter((event) => event.location === 'MAPLEFORD').map((event) => event.time))
      .toEqual(['2026-01-17T14:05:33-05:00', '2026-01-16T10:02:45-05:00', '2026-01-16T10:02:45-05:00']);

    // A partner scan the service recorded before its labelled instant, and unreadable labels.
    const early = withScans('auspost-delivered', (scans) => { scans[0].dateCreated = '2026-03-12 09:00:00'; });
    expect(parseUbi(early, DELIVERED, LATER)).toMatchObject({ last_update: null, last_update_local: '2026-03-12T13:41:07' });
    expect(parseUbi(early, DELIVERED, LATER).delivered_at).toBeUndefined();
    for (const zone of ['CST', 'GMT+15:00', 'GMT+05:20', '', null]) {
      const odd = withScans('auspost-delivered', (scans) => { scans[0].localTimeZone = zone; });
      expect(parseUbi(odd, DELIVERED, LATER).events![0], String(zone)).toMatchObject({ local_time: '2026-03-12T13:41:07' });
    }
    const unrecorded = withScans('auspost-delivered', (scans) => { delete scans[0].dateCreated; });
    expect(parseUbi(unrecorded, DELIVERED, LATER).events![0]).toMatchObject({ local_time: '2026-03-12T13:41:07' });
  });

  it('counts a booked flight once its time has come, and a partner’s manifest as no step back', () => {
    const before = parseUbi(fixture('aramex-linehaul'), LINEHAUL, Date.parse('2026-03-21T12:00:00Z'));
    expect(before).toMatchObject({ status: 'in_transit', last_status_text: 'EXPORT CUSTOMS CLEARED', last_update: '2026-03-21T12:50:00+08:00',
      delivery_tracking_number: ARAMEX, destination_country: 'AU' });
    expect(before.events!.some((event) => event.provider_code === 'LHL')).toBe(false);
    // UBI links Aramex Australia's home page for the parcel.
    expect(before.delivery_carrier).toBe('aramex-au');
    expect(deliveryHandoff('ubi-smart-parcel', LINEHAUL, before)).toEqual({ carrier: 'aramex-au', number: ARAMEX, basis: 'partner' });
    expect(parseUbi(fixture('aramex-linehaul'), LINEHAUL, Date.parse('2026-03-21T14:30:00Z')))
      .toMatchObject({ last_status_text: 'UPLIFTED FROM TRANSSHIPMENT HUB', last_update: '2026-03-21T22:30:00+08:00' });

    const manifest = withScans('auspost-delivered', (scans) => { scans.splice(0, 10); });
    expect(parseUbi(manifest, DELIVERED, LATER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'SHIPPING INFORMATION APPROVED BY AUSTRALIA POST' });
    // A partner's notice has no stage and changes none.
    const canada = parseUbi(fixture('canada-transit'), CANADA, LATER);
    expect(canada.events!.find((event) => event.description === 'EXPECTED DELIVERY DATE UPDATED')).toEqual({
      time: '2026-01-17T14:05:33-05:00', description: 'EXPECTED DELIVERY DATE UPDATED', location: 'MAPLEFORD', provider_code: 'INF' });
    expect(canada).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(canada.delivery_carrier).toBeUndefined();
    expect(canada.delivery_tracking_number).toBeUndefined();
  });

  it('names a partner only from one site the catalog knows', () => {
    const sites = (webSites: unknown) => {
      const payload = fixture('auspost-delivered');
      payload.data.trackParcelEvents[0].webSites = webSites;
      return parseUbi(payload, DELIVERED, LATER).delivery_carrier;
    };
    expect(sites([{ webSite: 'https://auspost.com.au/' }, { webSite: 'https://auspost.com.au/mypost/track' }])).toBe('australia-post');
    expect(sites([{ webSite: 'https://auspost.com.au/' }, { webSite: 'https://www.aramex.com.au/' }])).toBeUndefined();
    expect(sites([{ webSite: 'https://www.aramex.com.au/' }])).toBe('aramex-au');
    expect(sites([{ webSite: 'https://www.canadapost-postescanada.ca/' }])).toBe('canada-post');
    for (const value of [[], null, undefined, [{ webSite: 'not a link' }], [{}]]) expect(sites(value), JSON.stringify(value)).toBeUndefined();
    expect(() => sites({ webSite: 'https://auspost.com.au/' })).toThrow('invalid partner links');
  });

  it('reads a parcel found by its partner’s number without claiming it, and hands it over under that number', () => {
    const found = readUbiReply(askedBy('auspost-delivered', PARTNER), PARTNER, LATER);
    expect(found.partnerNumber).toBe(true);
    expect(found.result).toMatchObject({ status: 'delivered', delivery_carrier: 'australia-post' });
    expect(found.result.delivery_tracking_number).toBeUndefined();
    expect(deliveryHandoff('ubi-smart-parcel', PARTNER, found.result)).toEqual({ carrier: 'australia-post', number: PARTNER, basis: 'partner' });
    expect(deliveryHandoff('ubi-smart-parcel', DELIVERED, parseUbi(fixture('auspost-delivered'), DELIVERED, LATER)))
      .toEqual({ carrier: 'australia-post', number: PARTNER, basis: 'partner' });
    // A parcel under one number, relayed scans included, is UBI's own.
    expect(readUbiReply(fixture('canada-transit'), CANADA, LATER).partnerNumber).toBe(false);
    // A number on the scans that is not a tracking number is no partner number.
    const odd = withScans('aramex-linehaul', (scans) => { for (const scan of scans) if (scan.trackingNo === ARAMEX) scan.trackingNo = 'MP-1'; });
    expect(parseUbi(odd, LINEHAUL, LATER).delivery_tracking_number).toBeUndefined();
  });

  it('counts a reply only for the number asked, and only the tracker’s unknown list as a missing parcel', () => {
    expect(() => parseUbi(fixture('not-found'), ABSENT, LATER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseUbi(fixture('not-found'), DELIVERED, LATER)).toThrow('answered for another number');
    expect(() => parseUbi(askedBy('auspost-delivered', LINEHAUL), DELIVERED, LATER)).toThrow('answered for another number');
    const other = fixture('auspost-delivered');
    other.data.trackParcelEvents[0].trackingNo = LINEHAUL;
    expect(() => parseUbi(other, DELIVERED, LATER)).toThrow('no single parcel');
    const both = fixture('auspost-delivered');
    both.data.missTrackingNos = [DELIVERED];
    expect(() => parseUbi(both, DELIVERED, LATER)).toThrow('no single parcel');
    const silent = fixture('not-found');
    silent.data.missTrackingNos = [];
    expect(() => parseUbi(silent, ABSENT, LATER)).toThrow('no single parcel');
    const empty = withScans('auspost-delivered', (scans) => { scans.splice(0); });
    expect(() => parseUbi(empty, DELIVERED, LATER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const planned = withScans('aramex-linehaul', (scans) => { scans.splice(1); });
    expect(() => parseUbi(planned, LINEHAUL, Date.parse('2026-03-21T12:00:00Z'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUbi(fixture('refused'), DELIVERED, LATER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects replies it cannot read', () => {
    const broken: [string, Reply][] = [
      ['array', []],
      ['without data', { success: true, code: '0' }],
      ['parcels not a list', { success: true, code: '0', data: { queryTrackingNos: [DELIVERED], trackParcelEvents: {} } }],
      ['numbers not a list', { success: true, code: '0', data: { queryTrackingNos: DELIVERED, trackParcelEvents: [] } }],
      ['scan not an object', withScans('auspost-delivered', (scans) => { scans[0] = 'scan'; })],
      ['scan without a clock', withScans('auspost-delivered', (scans) => { scans[0].eventTime = '2026-03-12T13:41:07'; })],
      ['impossible clock', withScans('auspost-delivered', (scans) => { scans[0].eventTime = '2026-02-30 24:00:00'; })],
      ['scan without wording', withScans('auspost-delivered', (scans) => { scans[0].activity = ''; scans[0].sourceActivity = null; })],
      ['wording not text', withScans('auspost-delivered', (scans) => { scans[0].activity = { text: 'DELIVERED' }; })],
      ['history not a list', withScans('auspost-delivered', () => undefined)],
    ];
    broken.at(-1)![1].data.trackParcelEvents[0].events = {};
    for (const [label, payload] of broken) expect(() => parseUbi(payload, DELIVERED, LATER), label).toThrow(expect.objectContaining({ kind: 'schema' }));
    const long = withScans('auspost-delivered', (scans) => { scans.push(...Array.from({ length: 500 }, () => scans[0])); });
    expect(() => parseUbi(long, DELIVERED, LATER)).toThrow('invalid parcel history');
  });

  it('caps the history it returns', () => {
    const many = withScans('auspost-delivered', (scans) => {
      const first = scans[0];
      scans.splice(0, scans.length, ...Array.from({ length: 120 }, (_, index) => ({ ...first, location: `PLACE ${String.fromCharCode(65 + (index % 26))}${'X'.repeat(Math.floor(index / 26))}` })));
    });
    const result = parseUbi(many, DELIVERED, LATER);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
  });

  it('takes the number as letters and digits and refuses other input without a request', async () => {
    expect(normalizeUbiNumber(' au-0000000000017 ')).toBe(DELIVERED);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['AU12', 'A'.repeat(41), `${'1'.repeat(70)}`, '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a parcel UBI knows, reads its unknown number as unknown, and leaves partner numbers to the partner', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('auspost-delivered'))).mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T02:41:07.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const partner = vi.fn<typeof fetch>().mockImplementation(async () => reply(askedBy('auspost-delivered', PARTNER)));
    await expect(carrier(partner).recognize!(PARTNER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(partner).track({ number: PARTNER })).resolves.toMatchObject({ delivery_carrier: 'australia-post' });
    const other = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('auspost-delivered')));
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
      '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.</body></html>']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    }
    for (const body of ['', '<!DOCTYPE html><html><head><title>UBI</title></head><body><div id="app"></div></body></html>', '{"success":']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('auspost-delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('auspost-delivered')));
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

  it('offers UBI its own Australian numbers for recognition and leaves partner numbers to the partner', () => {
    for (const number of [DELIVERED, LINEHAUL, ABSENT]) {
      expect(detectCarrierMatch(number), number).toEqual({ carrier: 'unknown', confidence: 'low', candidates: ['ubi-smart-parcel'],
        preferred: ['ubi-smart-parcel'] });
      expect(recognitionAskedCarriers(number), number).toContain('ubi-smart-parcel');
    }
    for (const number of ['AU000000000001', 'AU00000000000170', 'AX0000000000017']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('ubi-smart-parcel');
    }
    expect(detectCarrierMatch(PARTNER)).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
    for (const number of [PARTNER, CANADA, ARAMEX]) expect(recognitionAskedCarriers(number), number).not.toContain('ubi-smart-parcel');
  });

  it('reads tracker links, the first of several numbers included', () => {
    for (const link of [`https://shipper.ubismartparcel.com/#/ubi?trackingNos=${DELIVERED}`,
      `https://shipper.ubismartparcel.com/#/ubi?trackingNos=${DELIVERED},${LINEHAUL}`,
      `https://shipper.ubismartparcel.com/#/ubi?lang=en&trackingNos=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'ubi-smart-parcel', source: 'link' });
    }
  });

  it('tracks a parcel the caller files under UBI and offers its partner the hand-over', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === UBI_ENDPOINT
      ? reply(fixture('auspost-delivered')) : reply('', 500));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'ubi-smart-parcel' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ubi-smart-parcel', source: 'ubi-smart-parcel',
      result: { current_stage: 'delivered', delivery_carrier: 'australia-post', delivery_tracking_number: PARTNER },
      handoff: { carrier: 'australia-post', number: PARTNER, basis: 'partner' } });
  });
});

describe('UBI Smart Parcel status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const label = `${entry.code} ${entry.wording}`;
      expect(ubiStage(entry.code, entry.wording), label).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), label).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ubi-smart-parcel', providerCode: entry.code, description: entry.wording }), label)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'ubi-smart-parcel', providerCode: 'INF', description: 'Expected delivery date updated' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(ubiStage('INF', 'Expected delivery date updated')).toBeNull();
    // `SCN` and `INF` need their wording; an unknown one goes to the shared rules.
    expect(ubiMappedStage('SCN', 'Attempted delivery - card left')).toBeUndefined();
    expect(ubiStage('SCN', 'Attempted delivery - card left')).toMatchObject({ stage: 'failed_attempt' });
    for (const code of ['constructor', 'toString', 'XYZ', '']) expect(ubiMappedStage(code, 'RECEIVED SHIPMENT'), code).toBeUndefined();
    expect(statusMap.stage(null, 'received shipment')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'ubi-smart-parcel', providerCode: 'ZZZ', description: 'DELIVERED' })).toEqual({ kind: 'unknown' });
  });
});

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
import { ARAMEX_AU_ENDPOINT } from '../aramex-au/adapter.js';
import { parseAramexAu } from '../aramex-au/parser.js';
import { adapter, ARAMEX_NZ_ORIGIN, AramexNzTracker, aramexNzUrl } from './adapter.js';
import { normalizeAramexNzNumber, parseAramexNz } from './parser.js';
import { aramexNzMappedStage, aramexNzStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'QZ0000000042';
const TRANSIT = 'QZ0000000017';
const LABELLED = 'QZ0000000033';
const CUSTOMS = 'QZ0000000050';
const ABSENT = 'QZ9999999990';
const ONFORWARDED = 'QZ0000000068';
// NZ Post's label for the parcel Aramex hands on.
const HANDED_ON = 'XD123456799NZ';
const ENDPOINT = `${ARAMEX_NZ_ORIGIN}/umbraco/api/TrackingApi/GetTrackingData`;
const NZ_POST_ENDPOINT = 'https://tools.nzpost.co.nz/tracking/api/parceltrack/parcels';
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

describe('Aramex New Zealand tracking adapter', () => {
  it('asks New Zealand’s tracking service once for the number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AramexNzTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' qz 0000-000042 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.aramex.co.nz/umbraco/api/TrackingApi/GetTrackingData?LabelNo=${DELIVERED}&dataFormat=json`);
    expect(String(url)).toBe(aramexNzUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { Accept: expect.stringContaining('application/json'),
      'Accept-Language': expect.stringContaining('en-NZ'), Referer: 'https://www.aramex.co.nz/tools/track/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'aramex-nz', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first on New Zealand’s clock, across the end of daylight saving', () => {
    const result = parseAramexNz(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-04-06T11:42:09+12:00', delivered_at: '2026-04-06T11:42:09+12:00', expected_delivery: null,
    });
    expect(result.last_update_local).toBeUndefined();
    // The page names no service, and the tracker keeps no SSCC beside the label.
    expect(result.service_name).toBeUndefined();
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.events).toEqual([
      // A courier's run keeps its area's name.
      { time: '2026-04-06T11:42:09+12:00', description: 'Delivered', location: 'Southvale', provider_code: 'R36', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-04-06T07:05:12+12:00', description: 'Onboard for delivery', location: 'Southvale', provider_code: 'ONB',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
      // The hour the clocks go back happens twice: the first reading is kept.
      { time: '2026-04-05T02:30:00+13:00', description: 'In transit', location: 'Southvale', provider_code: 'SVL', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-04-03T19:40:00+13:00', description: 'In transit', location: 'Harbourside', provider_code: 'HBS', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-04-03T15:10:22+13:00', description: 'Picked up from sender', location: 'Harbourside', provider_code: 'PPP',
        stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    // Explanations, parties, couriers and references stay behind.
    const text = JSON.stringify(result);
    for (const value of ['successfully delivered', 'Signer Fixture', 'Fixture Ltd', 'Fixture Lane', 'Recipient Fixture', 'REF-FIXTURE', 'safe place',
      'Zone', '518']) expect(text, value).not.toContain(value);
  });

  it('keeps the depots’ wall clocks when the reply does not say the journey stays in New Zealand', () => {
    for (const flag of [true, undefined, 'false']) {
      const result = parseAramexNz(edited('delivered', (result) => { result.IsInternationalJourney = flag; }), DELIVERED);
      expect(result, String(flag)).toMatchObject({ last_update: null, last_update_local: '2026-04-06T11:42:09' });
      expect(result.delivered_at, String(flag)).toBeUndefined();
      expect(result.events!.every((event) => event.local_time && !event.time), String(flag)).toBe(true);
    }
    // The shared parser still reads Australian depots on their own clocks, without the zone's area as a place.
    expect(parseAramexAu(fixture('delivered'), DELIVERED).events![0]).toEqual({ local_time: '2026-04-06T11:42:09', description: 'Delivered',
      provider_code: 'R36', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('gives the page’s delivery estimate only while the parcel moves between two known depots', () => {
    const transit = parseAramexNz(fixture('in-transit'), TRANSIT);
    expect(transit).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In transit',
      last_update: '2026-02-10T21:15:00+13:00', expected_delivery: '2026-02-12' });
    // A depot named after two towns stays as the page shows it; a failed collection before pickup keeps its depot.
    expect(transit.events!.map((event) => [event.provider_code, event.location, event.stage])).toEqual([
      ['NBR', 'Northbank,Riverton', 'in_transit'], ['PPP', 'Harbourside', 'accepted'], ['NOH', 'Harbourside', 'registered']]);
    expect(JSON.stringify(transit)).not.toContain('Fixture');
    for (const [label, change] of [
      ['passed', (result: Reply) => { result.PickupFranchiseCurrentDate = '13/02/2026'; }],
      ['no pickup depot', (result: Reply) => { result.PickupFranchiseCode = ''; }],
      ['no delivery depot', (result: Reply) => { result.DeliveryFranchiseCode = null; }],
      ['onboard', (result: Reply) => { Object.assign(result.Scans.at(-1), { Status: 'ONB', Description: 'Onboard for delivery' }); }],
      ['unreadable', (result: Reply) => { result.DeliveryETADate = '2026-02-12'; }],
    ] as const) expect(parseAramexNz(edited('in-transit', change), TRANSIT).expected_delivery, label).toBeNull();
    // A label reissue does not hide it on this page.
    const reissued = edited('in-transit', (result) => { result.Scans[0].Status = 'PP5'; });
    expect(parseAramexNz(reissued, TRANSIT).expected_delivery).toBe('2026-02-12');
  });

  it('reads a parcel from abroad through customs, without an estimate until its pickup depot is known', () => {
    const result = parseAramexNz(fixture('customs'), CUSTOMS);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: null, last_update: '2026-02-17T20:05:00+13:00' });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['HBS', 'in_transit'], ['Z30', 'in_transit'], ['ICC', 'in_transit'], ['CLG', 'customs']]);
    const known = edited('customs', (result) => { result.PickupFranchiseCode = 'HBS'; });
    expect(parseAramexNz(known, CUSTOMS).expected_delivery).toBe('2026-02-19');
    const held = edited('customs', (result) => { result.Scans.splice(1); });
    expect(parseAramexNz(held, CUSTOMS)).toMatchObject({ current_stage: 'customs', last_status_text: 'Awaiting customs clearance', expected_delivery: null });
  });

  it('reads a parcel the courier has not collected as registered, without a place', () => {
    const result = parseAramexNz(fixture('pre-pickup'), LABELLED);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', expected_delivery: null, last_status_text: 'Tracking number allocated' });
    // The page shows the label's own records, still without a place.
    expect(result.events).toEqual([{ time: '2026-07-14T08:15:42+12:00', description: 'Tracking number allocated', provider_code: 'PP2',
      stage: 'registered', stage_source: 'carrier_map' }]);
    const created = edited('pre-pickup', (result) => { Object.assign(result.Scans[0], { Status: 'PP0', Description: 'Consignment created' }); });
    expect(parseAramexNz(created, LABELLED).events).toEqual([{ time: '2026-07-14T08:15:42+12:00', description: 'Consignment created', provider_code: 'PP0',
      stage: 'registered', stage_source: 'carrier_map' }]);
    const bare = edited('pre-pickup', (result) => { result.Scans = []; });
    expect(() => parseAramexNz(bare, LABELLED)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('names NZ Post and its label for a parcel handed on to NZ Post, keeping Aramex’s own scans and status', () => {
    const result = parseAramexNz(fixture('onforwarded'), ONFORWARDED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Delivery onforwarded',
      last_update: '2026-05-13T06:20:41+12:00', expected_delivery: null, delivery_carrier: 'nz-post', delivery_tracking_number: HANDED_ON });
    // The hand-on scan keeps its heading and depot, without a stage of its own.
    expect(result.events![0]).toEqual({ time: '2026-05-13T06:20:41+12:00', description: 'Delivery onforwarded', location: 'Southvale', provider_code: 'RUR', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toContain('rural agent');
    // Spaces and case do not matter, and NZ Post's courier label counts too.
    for (const [label, expected] of [[' xd 123 456 799 nz ', HANDED_ON], ['0000000000000017AKL001AS', '0000000000000017AKL001AS']] as const) {
      expect(parseAramexNz(edited('onforwarded', (result) => { result.OnforwardLabelNumber = label; }), ONFORWARDED), label)
        .toMatchObject({ delivery_carrier: 'nz-post', delivery_tracking_number: expected });
    }
    for (const [label, change] of [
      ['not flagged', (result: Reply) => { result.IsNZPostOnforward = false; }],
      ['flag as text', (result: Reply) => { result.IsNZPostOnforward = 'true'; }],
      ['no label', (result: Reply) => { result.OnforwardLabelNumber = ''; }],
      ['label not text', (result: Reply) => { result.OnforwardLabelNumber = { label: HANDED_ON }; }],
      ['broken check digit', (result: Reply) => { result.OnforwardLabelNumber = 'XD123456798NZ'; }],
      ['part of the label', (result: Reply) => { result.OnforwardLabelNumber = 'XD123456799'; }],
      ['another post’s item', (result: Reply) => { result.OnforwardLabelNumber = 'RA123456785CH'; }],
      ['an Aramex label', (result: Reply) => { result.OnforwardLabelNumber = TRANSIT; }],
    ] as const) {
      const other = parseAramexNz(edited('onforwarded', change), ONFORWARDED);
      expect(other.delivery_carrier, label).toBeUndefined();
      expect(other.delivery_tracking_number, label).toBeUndefined();
      expect(other.current_stage, label).toBe('in_transit');
    }
    // Aramex Australia's replies carry the same fields; its page links no partner with them.
    expect(parseAramexAu(fixture('onforwarded'), ONFORWARDED).delivery_carrier).toBeUndefined();
  });

  it('counts a reply only for the number asked, and only the service’s own error for it as a missing parcel', () => {
    expect(() => parseAramexNz(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found', provider: 'Aramex New Zealand' }));
    expect(() => parseAramexNz(fixture('not-found'), DELIVERED)).toThrow('Aramex New Zealand answered for another number');
    expect(() => parseAramexNz(fixture('delivered'), TRANSIT)).toThrow('answered for another number');
    expect(() => parseAramexNz({ error: 'Invalid label number!', data: null }, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const [label, payload] of [['array', []], ['scans not a list', edited('delivered', (result) => { result.Scans = {}; })],
      ['scan without a clock', edited('delivered', (result) => { result.Scans[1].RealDateTime = '03/04/2026 19:40:00'; })]] as const) {
      expect(() => parseAramexNz(payload, DELIVERED), label).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes a label but not an SSCC, and refuses other input without a request', async () => {
    expect(normalizeAramexNzNumber(' qz-0000 000017 ')).toBe(TRANSIT);
    expect(normalizeAramexNzNumber('W90000000017')).toBe('W90000000017');
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['QZ000000004', 'QZ00000000420', '220000000042', '00399999900000000423', '1'.repeat(70), '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a parcel the tracker has scans for, with its last activity, and reads its unknown number as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-05T23:42:09.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [500, 'indeterminate']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages apart from missing parcels and tries once more after a failed connection', async () => {
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(reply('<html><head><title>Just a moment...</title></head></html>'));
    await expect(carrier(blocked).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge', message: expect.stringContaining('Aramex New Zealand') });
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new AramexNzTracker({ fetcher: flaky, recorder }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'aramex-nz', step: 'retry', outcome: 'ok' }));
  });

  it('offers Aramex New Zealand two letters, or a digit and a letter, and ten digits for recognition, beside Aramex Australia', () => {
    for (const number of [DELIVERED, TRANSIT, LABELLED, ABSENT, '2Q0000000017']) {
      expect(detectCarrierMatch(number).candidates, number).toEqual(expect.arrayContaining(['aramex-au', 'aramex-nz']));
      expect(recognitionAskedCarriers(number), number).toContain('aramex-nz');
    }
    // A letter and a digit is a shape other networks share.
    for (const number of ['W90000000017', '00399999900000000423', 'QZ000000004']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('aramex-nz');
    }
  });

  it('names Aramex New Zealand for its MX labels, which Aramex Australia does not issue', () => {
    expect(detectCarrierMatch('MX0000000017')).toMatchObject({ carrier: 'aramex-nz', confidence: 'high' });
    expect(detectCarrierMatch('MX0000000017').candidates).not.toContain('aramex-au');
    expect(detectCarrierMatch('MQ0000000017').candidates).toEqual(expect.arrayContaining(['aramex-au', 'aramex-nz']));
  });

  it('reads tracker links on Aramex New Zealand’s and Fastway’s old hosts, and names the carrier from its home page', () => {
    for (const link of [`https://www.aramex.co.nz/tools/track?l=${DELIVERED}`, `https://www.aramex.co.nz/tools/track/?l=${DELIVERED}`,
      `https://www.fastway.co.nz/tools/track/?l=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'aramex-nz', source: 'link' });
    }
    expect(carrierIdFromPartner('', 'https://www.aramex.co.nz/')).toBe('aramex-nz');
    expect(carrierIdFromPartner('', 'https://www.aramex.com.au/')).toBe('aramex-au');
    for (const name of ['Aramex New Zealand', 'Aramex NZ', 'Fastway NZ', 'Fastway New Zealand']) expect(carrierIdFromName(name), name).toBe('aramex-nz');
    expect(carrierIdFromName('Fastway')).toBeUndefined();
  });

  it('tracks a parcel a partner hands to Aramex New Zealand under the label it names, on New Zealand’s host only', async () => {
    expect(deliveryHandoff('ubi-smart-parcel', 'NZ0000000000025', { delivery_carrier: 'aramex-nz', delivery_tracking_number: DELIVERED }))
      .toEqual({ carrier: 'aramex-nz', number: DELIVERED, basis: 'partner' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(ENDPOINT)
      ? reply(fixture('delivered')) : reply('', 500));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'aramex-nz' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'aramex-nz', source: 'aramex-nz', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(ARAMEX_AU_ENDPOINT))).toBe(false);
  });
});

describe('Aramex New Zealand hand-off to NZ Post', () => {
  it('offers NZ Post the label of a parcel Aramex hands on, and keeps NZ Post’s answer apart', async () => {
    const nzPost = JSON.parse(readFileSync(new URL('../nz-post/fixtures/delivered.json', import.meta.url), 'utf8'));
    nzPost.results[0].tracking_reference = HANDED_ON;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(ENDPOINT) ? reply(fixture('onforwarded'))
      : String(url).startsWith(NZ_POST_ENDPOINT) ? reply(nzPost) : reply('', 500));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: ONFORWARDED, carrier: 'aramex-nz' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'aramex-nz', source: 'aramex-nz',
      result: { current_stage: 'in_transit', delivery_carrier: 'nz-post', delivery_tracking_number: HANDED_ON },
      handoff: { carrier: 'nz-post', number: HANDED_ON, basis: 'partner', confirmed: true, result: { current_stage: 'delivered' } } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([aramexNzUrl(ONFORWARDED), `${NZ_POST_ENDPOINT}?tracking_reference=${HANDED_ON}`]);
  });
});

describe('Aramex New Zealand status vocabulary', () => {
  it('records every code and heading the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const wording = ('wording' in entry ? entry.wording : undefined) ?? '';
      const label = `${entry.code} ${wording}`;
      expect(aramexNzStage(entry.code, wording), label).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(entry.code, normalizeStatusWording(wording)), label).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'aramex-nz', providerCode: entry.code, description: wording || 'Scan' }), label)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('lets the heading decide over the code, and leaves the page’s mixed groups to their wording', () => {
    expect(aramexNzMappedStage('Z30', 'Arrived in destination country')).toBe('in_transit');
    expect(aramexNzMappedStage('Z30', 'Something new')).toBe('accepted');
    // The page counts DVR both as delivered and as handed to another carrier.
    expect(aramexNzMappedStage('DVR', 'Parcel scanned')).toBeUndefined();
    expect(aramexNzMappedStage('POP', 'Parcel scanned')).toBeUndefined();
    for (const code of ['constructor', 'toString', 'XYZ', '']) expect(aramexNzMappedStage(code, 'Parcel scanned'), code).toBeUndefined();
    expect(aramexNzStage('UND', 'Return to sender')).toMatchObject({ stage: 'exception' });
    expect(statusMap.stage(null, 'delivered')).toBe('delivered');
    expect(statusMapAnswer({ carrier: 'aramex-nz', providerCode: 'ZZZ', description: 'Parcel scanned' })).toEqual({ kind: 'unknown' });
  });
});

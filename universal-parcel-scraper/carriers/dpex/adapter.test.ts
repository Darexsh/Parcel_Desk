import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DpexTracker } from './adapter.js';
import { DPEX_CHINA_TRACKER, DPEX_TRACKER, normalizeDpexNumber, parseDpex, parseDpexChina } from './parser.js';
import { dpexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '200000000001';
const IN_TRANSIT = '200000000012';
const UNKNOWN = '999999999994';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
/** DPEX China's page for a number it holds nothing for. */
const chinaUnknown = (number: string) => fixture('china-not-found').replaceAll(UNKNOWN, number);
/** A transport answering the GETOnline page and DPEX China's page each with its own reply. */
const trackers = (getOnline: () => Response | Promise<Response>, china: () => Response | Promise<Response>) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(DPEX_TRACKER) ? getOnline() : china()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scans = (events: { time?: string; local_time?: unknown; provider_code?: string }[] = []) =>
  events.map((event) => [event.time ?? event.local_time, event.provider_code]);

describe('DPEX Worldwide HTTP adapter', () => {
  it('asks both trackers for the whole number once each, through the supplied transport', async () => {
    const fetcher = trackers(() => reply(fixture('in-transit')), () => reply(fixture('china-in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DpexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2000 0000 0012 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `${DPEX_CHINA_TRACKER}?id=${IN_TRANSIT}`,
      `${DPEX_TRACKER}?stid=dpexwwe&cn=${IN_TRANSIT}`,
    ]);
    expect(DPEX_TRACKER).toMatch(/^https:\/\/tracking\.frontierforce\.com\/go\/plm-tracking$/);
    expect(DPEX_CHINA_TRACKER).toMatch(/^https:\/\/erp\.dpex\.com\.cn\/trace-and-track\/index$/);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledTimes(1);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the GETOnline scans in Singapore on its clock, keeps Hong Kong’s as wall clocks and drops the signatory', () => {
    const result = parseDpex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-16T14:41:00+08:00', expected_delivery: null, destination_country: 'SG' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-03-16T14:41:00+08:00', '1', 'delivered', 'Singapore - SINGAPORE'],
      ['2026-03-16T09:05:00+08:00', '15', 'out_for_delivery', 'Singapore - SINGAPORE'],
      ['2026-03-16T07:12:00+08:00', '40', 'in_transit', 'Singapore - SINGAPORE'],
      ['2026-03-15T23:58:00+08:00', '4', 'in_transit', 'Singapore - SINGAPORE'],
      // The tracker's name for Hong Kong settles no zone, so its scans keep the station's wall clock.
      ['2026-03-15T18:20:00', '3', 'in_transit', 'Hong Kong - HONG KONG'],
      ['2026-03-15T00:00:00', '4', 'in_transit', 'Hong Kong - HONG KONG'],
    ]);
    // The masked signatory, the service type and the destination's town are not kept.
    expect(JSON.stringify(result)).not.toMatch(/S\*{7}|Export Non Documents|SAMPLETOWN/);
  });

  it('keeps the GETOnline scans in Australia, which has several zones, as wall clocks', () => {
    const result = parseDpex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null,
      last_update_local: '2026-04-21T07:36:00', last_status_text: 'Arrived Depot', destination_country: 'AU' });
    expect(result.events!.map((event) => [event.time ?? null, event.local_time ?? null, event.provider_code, event.location])).toEqual([
      [null, '2026-04-21T07:36:00', '40', 'Sydney - AUSTRALIA'],
      [null, '2026-04-20T14:07:00', '3', 'Sydney - AUSTRALIA'],
      ['2026-04-19T22:15:00+08:00', null, '3', 'Singapore - SINGAPORE'],
      ['2026-04-19T16:40:00+08:00', null, '4', 'Singapore - SINGAPORE'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/eCommerce|SAMPLEVILLE/);
  });

  it('counts a GETOnline history only when every scan names the number asked', () => {
    expect(() => parseDpex(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'DPEX answered for another shipment' }));
    const mixed = fixture('delivered').replace(`$(".cn").html("${DELIVERED}");`, `$(".cn").html("${IN_TRANSIT}");`);
    expect(() => parseDpex(mixed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads an air waybill the GETOnline page holds without scans as not found, as its page does', () => {
    // The page writes the destination and service before its "No tracking found" notice.
    const held = fixture('not-found').replace('$(".tracking-events").html("");',
      '$(".trackingstatus").hide();\n            $(".trackingstatus-connote").show();\n            $(".destination").html("SAMPLETOWN SINGAPORE");\n            $(".tracking-events").html("");');
    expect(() => parseDpex(held, DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('rejects a changed GETOnline page', () => {
    const page = fixture('delivered');
    for (const changed of [
      '<html><title>GETOnline</title></html>',
      page.replace('function js_getTrack()', 'function js_getTracking()'),
      page.replace('$(".trackingstatus-connote").show();', '').replace(/\$\("\.cn"\)\.html\("\d+"\);/g, ''),
      page.replace('16 Mar 2026</span>', '2026-03-16</span>'),
      page.replace('02:41 PM</span>', '14:41</span>'),
      page.replace(/langtag="event_' \+ 1\+'">' \+ "Delivered"/, 'langtag="event_\' + 1+\'">\' + ""'),
      page.replace('var sno = 0;', 'var sno = 0;\n            $(".no-trackingstatus").show();'),
    ]) {
      expect(() => parseDpex(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads DPEX China’s history on the stations’ wall clocks and drops the notes', () => {
    const result = parseDpexChina(fixture('china-delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-16T14:41:00', expected_delivery: null,
      destination_country: 'SG' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-03-16T14:41:00', '1', 'delivered', 'Singapore'],
      ['2026-03-16T09:05:00', '15', 'out_for_delivery', 'Singapore'],
      ['2026-03-16T07:12:00', '40', 'in_transit', 'Singapore'],
      ['2026-03-15T23:58:00', '4', 'in_transit', 'Singapore'],
      ['2026-03-15T18:20:00', '3', 'in_transit', 'Hong Kong'],
      ['2026-03-15T00:00:00', '4', 'in_transit', 'Hong Kong'],
      ['2026-03-14T20:12:00', '4', 'in_transit', 'Sampleport (Guangdong) - CHINA'],
      ['2026-03-14T16:30:00', '2', 'accepted', 'Sampleport (Guangdong) - CHINA'],
      // Scans of the same minute keep the page's order.
      ['2026-03-14T10:05:00', '91', 'registered', 'Sampleport (Guangdong) - CHINA'],
      ['2026-03-14T10:05:00', '90', 'registered', 'Sampleport (Guangdong) - CHINA'],
    ]);
    // The scans' notes, which can name the recipient, and the references are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Sample note|S\. SAMPLE|SAMPLE API|Track[A-Z]/);
  });

  it('binds DPEX China’s answer to the number asked', () => {
    expect(() => parseDpexChina(chinaUnknown(UNKNOWN), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const [page, number] of [
      [fixture('china-in-transit'), DELIVERED],
      [chinaUnknown(UNKNOWN), DELIVERED],
      [fixture('china-delivered').replace(`"TrackConnote":"${DELIVERED}"`, `"TrackConnote":"${IN_TRANSIT}"`), DELIVERED],
    ] as const) {
      expect(() => parseDpexChina(page, number)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'DPEX China answered for another shipment' }));
    }
  });

  it('rejects a changed DPEX China page', () => {
    const page = fixture('china-delivered');
    for (const changed of [
      '<html><title>Trace and Track</title></html>',
      page.replace('var cardInfoArray', 'var cardArray'),
      page.replace('var trackAndEventsArray = [[[', 'var trackAndEventsArray = [[[,'),
      page.replace('"TrackDateTime":"2026-03-16 14:41:00"', '"TrackDateTime":"16\\/03\\/2026 14:41"'),
      page.replace('"TrackEventCode":"1",', '"TrackEventCode":"D",'),
      page.replace('"TrackEventCustViewName":"Delivered"', '"TrackEventCustViewName":""'),
      page.replace('var locationNamesArray = [[', 'var locationNamesArray = [["Singapore",'),
      // A page for two numbers.
      page.replace('var trackAndEventsArray = [[', 'var trackAndEventsArray = [[],['),
    ]) {
      expect(() => parseDpexChina(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDpexChina('<html><head><title>Just a moment...</title></head></html>', DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('follows the GETOnline history with DPEX China’s scans from before it', async () => {
    const delivered = await carrier(trackers(() => reply(fixture('delivered')), () => reply(fixture('china-delivered')))).track({ number: DELIVERED });
    expect(delivered).toMatchObject({ status: 'delivered', last_update: '2026-03-16T14:41:00+08:00', destination_country: 'SG' });
    expect(scans(delivered.events)).toEqual([
      ...scans(parseDpex(fixture('delivered'), DELIVERED).events),
      // DPEX China's own scans of the same parcel at the origin; its copies of the page's scans are left out.
      ['2026-03-14T20:12:00', '4'], ['2026-03-14T16:30:00', '2'], ['2026-03-14T10:05:00', '91'], ['2026-03-14T10:05:00', '90'],
    ]);
    // The page's scans lead even when DPEX China has not copied the latest of them.
    const moving = await carrier(trackers(() => reply(fixture('in-transit')), () => reply(fixture('china-in-transit')))).track({ number: IN_TRANSIT });
    expect(moving).toMatchObject({ status: 'in_transit', last_update_local: '2026-04-21T07:36:00', last_status_text: 'Arrived Depot', destination_country: 'AU' });
    expect(scans(moving.events)).toEqual([
      ...scans(parseDpex(fixture('in-transit'), IN_TRANSIT).events),
      ['2026-04-19T13:25:00', '2'], ['2026-04-19T09:10:00', '91'], ['2026-04-19T09:10:00', '90'],
    ]);
  });

  it('takes the history of the one tracker that has it, or DPEX China’s when it holds a later scan', async () => {
    const china = await carrier(trackers(() => reply(fixture('not-found')), () => reply(fixture('china-delivered')))).track({ number: DELIVERED });
    expect(china).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-03-16T14:41:00', destination_country: 'SG' });
    expect(china.events).toHaveLength(10);
    const getOnline = await carrier(trackers(() => reply(fixture('delivered')), () => reply(chinaUnknown(DELIVERED)))).track({ number: DELIVERED });
    expect(getOnline).toEqual(parseDpex(fixture('delivered'), DELIVERED));
    const later = fixture('china-delivered').replace('"TrackDateTime":"2026-03-16 14:41:00"', '"TrackDateTime":"2026-03-16 18:41:00"');
    const ahead = await carrier(trackers(() => reply(fixture('delivered')), () => reply(later))).track({ number: DELIVERED });
    expect(ahead).toMatchObject({ last_update: null, last_update_local: '2026-03-16T18:41:00', destination_country: 'SG' });
    expect(ahead.events).toHaveLength(10);
  });

  it('answers not found only when both trackers say so', async () => {
    const unknown = trackers(() => reply(fixture('not-found')), () => reply(chinaUnknown(UNKNOWN)));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const failures: [string, ResponseInit, string][] = [
      ['', { status: 404 }, 'transport'],
      ['', { status: 302, headers: { Location: '/' } }, 'transport'],
      ['<html><head><title>Access Denied</title></head><body>Request Rejected</body></html>', {}, 'challenge'],
      ['', {}, 'indeterminate'],
      ['<html><title>Tracking</title></html>', {}, 'schema'],
      ['', { status: 429 }, 'rate_limited'],
    ];
    for (const [body, init, kind] of failures) {
      // Either tracker failing leaves an unknown answer from the other open.
      await expect(carrier(trackers(() => reply(body, init), () => reply(chinaUnknown(UNKNOWN)))).track({ number: UNKNOWN }), `GETOnline ${kind}`)
        .rejects.toMatchObject({ kind });
      await expect(carrier(trackers(() => reply(fixture('not-found')), () => reply(body, init))).track({ number: UNKNOWN }), `China ${kind}`)
        .rejects.toMatchObject({ kind });
    }
    // A history from one tracker stands when the other fails.
    await expect(carrier(trackers(() => reply('', { status: 503 }), () => reply(fixture('china-delivered')))).track({ number: DELIVERED }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(carrier(trackers(() => reply(fixture('in-transit')), () => reply('', { status: 403 }))).track({ number: IN_TRANSIT }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a read that did not reach either tracker once more', async () => {
    let getOnlineCalls = 0;
    let chinaCalls = 0;
    const fetcher = trackers(
      () => (getOnlineCalls++ ? reply(fixture('in-transit')) : Promise.reject(new TypeError('fetch failed'))),
      () => (chinaCalls++ ? reply(fixture('china-in-transit')) : Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect([getOnlineCalls, chinaCalls]).toEqual([2, 2]);
  });

  it('sends only a whole air waybill with its check digit: no partial reference, pattern or letters', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The trackers read % as a wildcard and answer short references with other shipments.
    for (const number of ['20000000001', '2000000000011', '20000000000%', '2000000000%1', '20000000000*', 'ZZ0000000001', '200000000002', '20000000001,200000000012']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
      expect(() => parseDpexChina(fixture('china-delivered'), number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDpexNumber('2000-0000-0001')).toBe(DELIVERED);
  });

  it('recognizes a known air waybill by its last scan and an unknown one by both trackers’ answers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const asked = String(url);
      if (asked.startsWith(DPEX_TRACKER)) return reply(fixture(asked.endsWith(DELIVERED) ? 'delivered' : 'not-found'));
      if (asked.endsWith(DELIVERED)) return reply(fixture('china-delivered'));
      return reply(asked.endsWith(IN_TRANSIT) ? fixture('china-in-transit') : chinaUnknown(UNKNOWN));
    });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-16T06:41:00.000Z' });
    // DPEX China's wall clocks show the air waybill exists and date it without an instant.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-19T22:15:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const blocked = trackers(() => reply(fixture('not-found')), () => reply('', { status: 403 }));
    await expect(carrier(blocked).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('routes a number filed under DPEX to the adapter', async () => {
    const fetcher = trackers(() => reply(fixture('delivered')), () => reply(fixture('china-delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'dpex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dpex', source: 'dpex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(DPEX_TRACKER))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(DPEX_CHINA_TRACKER))).toBe(true);
  });
});

describe('DPEX Worldwide numbers and links', () => {
  it('claims no bare twelve digits: Yamato, Sagawa and Japan Post use the same check', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) {
      const match = detectCarrierMatch(number);
      expect(match.carrier).not.toBe('dpex');
      expect(match.candidates).not.toContain('dpex');
    }
  });

  it('reads the number from DPEX’s own links and from the GETOnline page only under its member id', () => {
    for (const link of [
      `https://dpex.com/track-and-trace/?cn=${DELIVERED},${IN_TRANSIT}`,
      `https://dpexonline.com/trace-and-track/index?id=${DELIVERED}`,
      `https://erp.dpex.com.cn/trace-and-track/index?id=${DELIVERED}`,
      `https://tracking.frontierforce.com/tracking_search.aspx?stid=dpexwwe&cn=${DELIVERED}`,
      `https://tracking.frontierforce.com/go/plm-tracking?stid=dpexwwe&cn=${DELIVERED}`,
      `https://tracking.frontierforce.com/tracking.aspx?cn=${DELIVERED}&stid=DPEXWWE&option=,8,`,
    ]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'dpex', source: 'link' });
    }
    expect(parseTrackingInput(`https://tracking.frontierforce.com/go/plm-tracking?stid=skynet&cn=${DELIVERED}`).carrier).toBe('skynet-worldwide');
    expect(parseTrackingInput(`https://tracking.frontierforce.com/go/plm-tracking?stid=dpexwwe2&cn=${DELIVERED}`).carrier).not.toBe('dpex');
  });
});

describe('DPEX Worldwide status vocabulary', () => {
  it('records every event number the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(dpexStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'dpex', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(dpexStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'dpex', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // An event number the map does not know falls to the shared wording rules.
    expect(dpexStage('999', 'Out for Delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(dpexStage('999', 'Synthetic note')).toBeNull();
  });
});

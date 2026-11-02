import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EPOST_GLOBAL_ENDPOINT, EpostGlobalTracker } from './adapter.js';
import { normalizeEpostGlobalNumber, parseEpostGlobal } from './parser.js';
import { osmStage } from '../osm-worldwide/status.js';
import { epostGlobalScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const SPRING = 'EPG990000000000001';
const ROYAL = 'EPG990000000000002';
const UNKNOWN = 'EPG999999999999999';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (html: string) => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CALL = /transactionDetails\('(.*?)','0','([^']*)', '([^']*)', '(.*?)'\)"/s;
const encoded = (value: unknown) => JSON.stringify(value).replaceAll('"', '&quot;');

type Details = Record<string, unknown> & { Events: Record<string, unknown>[] };

/** A fixture whose details the test changes, encoded back as the page encodes them. */
function rewrite(name: string, change: (details: Details) => void, echoed?: string): string {
  const html = text(name);
  const call = CALL.exec(html)!;
  const details = JSON.parse(call[4]!.replaceAll('&quot;', '"')) as Details;
  change(details);
  const handler = `transactionDetails('${encoded(details.Events)}','0','${echoed ?? call[2]}', '${String(details.Track)}', '${encoded(details)}')"`;
  return html.replace(call[0], () => handler);
}

describe('ePost Global HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('spring-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EpostGlobalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' epg 990 000 000 000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(EPOST_GLOBAL_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html, */*; q=0.01', 'User-Agent': 'SyntheticHost/1.0', 'X-Requested-With': 'XMLHttpRequest' } });
    expect(String(init!.body)).toBe(`id=${SPRING}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'epost-global', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the processing center’s scans on its clock, keeps relayed wall clocks and reads no postcode or reference', () => {
    const result = parseEpostGlobal(text('spring-delivered'), SPRING);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'The item is delivered in the mailbox', last_update: null, last_update_local: '2026-03-12T10:45:00',
      expected_delivery: null, delivery_carrier: 'spring-gds', delivery_tracking_number: 'LX000000005NL', destination_country: 'FR' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage, event.stage_source, event.location ?? null])).toEqual([
      ['2026-03-12T10:45:00', '3043', 'delivered', 'wording:language', 'FR'],
      ['2026-03-12T08:20:00', '74', 'out_for_delivery', 'wording:language', 'FR'],
      ['2026-03-11T07:55:00', 'EPG-1265', 'in_transit', 'wording:language', null],
      ['2026-03-10T14:34:00', '30', 'in_transit', 'wording:language', 'FR'],
      ['2026-03-09T00:51:00', '301', 'in_transit', 'wording:language', 'NL'],
      // PostNL's acceptance after ePost Global shipped the parcel.
      ['2026-03-07T08:59:00', '173', 'in_transit', 'carrier_map', 'NL'],
      ['2026-03-05T19:02:00', '6010', 'customs', 'wording:language', 'NL'],
      ['2026-03-05T17:47:00', '1233', 'registered', 'wording:language', 'US'],
      ['2026-03-04T23:41:44', '41', 'in_transit', 'carrier_map', null],
      ['2026-03-04T23:40:44-06:00', '32', 'in_transit', 'carrier_map', 'Sampleton IL'],
      ['2026-03-04T15:04:46-06:00', '30', 'accepted', 'carrier_map', 'Sampleton IL'],
      ['2026-03-02T09:43:01', 'EPGS01', 'registered', 'carrier_map', null],
      ['2026-03-02T09:42:01', '11', 'registered', 'carrier_map', null],
    ]);
    expect(result.events!.filter((event) => event.time)).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/99999|60999|SYNTHETIC-ORDER|7000001|12345678/);
  });

  it('reads a Pacific center in summer time, cuts partner places at their digits and names Royal Mail', () => {
    const result = parseEpostGlobal(text('royal-mail-in-transit'), ROYAL);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update_local: '2026-07-15T08:56:00',
      delivery_carrier: 'royal-mail', delivery_tracking_number: 'GB000000005GB', destination_country: 'GB' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null])).toEqual([
      ['2026-07-15T08:56:00', null],
      ['2026-07-14T08:11:00', 'Hubton'],
      ['2026-07-12T16:56:00', 'GB'],
      ['2026-07-12T14:45:00', null],
      ['2026-07-11T23:14:13', null],
      ['2026-07-11T23:13:13-07:00', 'Sampleville CA'],
      ['2026-07-11T21:43:47-07:00', 'Sampleville CA'],
      ['2026-07-10T15:27:28', null],
    ]);
  });

  it('keeps a center’s wall clock when its state spans zones or its place is missing', () => {
    const split = parseEpostGlobal(rewrite('spring-delivered', (details) => {
      details.Events[10]!.Loc = 'Sampleton TX';
      details.Events[11]!.Loc = '';
    }), SPRING);
    expect(split.events!.slice(-4, -2)).toMatchObject([
      { local_time: '2026-03-04T23:40:44', location: 'Sampleton TX' },
      { local_time: '2026-03-04T15:04:46' },
    ]);
    expect(split.events!.some((event) => event.time)).toBe(false);
  });

  it('does not step back to a partner’s announcement after the parcel was shipped', () => {
    const result = parseEpostGlobal(rewrite('royal-mail-in-transit', (details) => {
      details.Events.splice(0, 2);
    }), ROYAL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipment Announced' });
    expect(result.events![0]).toMatchObject({ stage: 'registered' });
  });

  it('reads the rows it relays from OSM Worldwide by OSM’s codes, in the stages OSM’s own tracker gives them', () => {
    const osm = (ECode: string, Event: string, EventDT: string, Loc = '') => ({ ParcelID: 12345678, ECategory: '', ECategoryID: 0, ECode, Event, EventDT, Loc, Zip: '' });
    const result = parseEpostGlobal(rewrite('royal-mail-in-transit', (details) => {
      details.Events = [
        osm('OSM09', 'Package processed by courier partner', '2026-07-14T16:56:00', 'EXAMPLE CITY NV 00000'),
        osm('OSM07', 'Package accepted at courier partner', '2026-07-14T15:41:00', 'EXAMPLE TOWN CA 00000'),
        osm('OSM05', 'Departed OSM facility', '2026-07-14T13:33:00', 'EXAMPLE CITY NV 00000'),
        osm('OSM04', 'Arrived at OSM facility', '2026-07-14T08:21:00', 'EXAMPLE CITY NV 00000'),
        osm('OSM02', 'Shipping label created - OSM awaiting item', '2026-07-12T18:50:00', 'EXAMPLE PORT CA 00000'),
        osm('41', 'In transit', '2026-07-12T18:38:46'),
      ];
    }), ROYAL);
    const flags = { group: 0, instructionsNeeded: false, isException: false };
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual(result.events!.map((event) => [
      event.provider_code, ...event.provider_code === '41' ? ['in_transit', 'carrier_map'] : Object.values(osmStage(event.provider_code!, event.description!, flags)!),
    ]));
    expect(result.events!.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'in_transit', 'in_transit', 'registered', 'in_transit']);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(statusMapAnswer({ carrier: 'epost-global', providerCode: 'OSM07', description: 'Package accepted at courier partner' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it('names a partner only from a name the catalog knows and a link that agrees, and keeps its number', () => {
    const unlinked = parseEpostGlobal(rewrite('royal-mail-in-transit', (details) => { details.VendorTrackingUrl = null; }), ROYAL);
    expect(unlinked.delivery_carrier).toBe('royal-mail');
    const elsewhere = parseEpostGlobal(rewrite('royal-mail-in-transit', (details) => {
      details.VendorTrackingUrl = 'https://postnl.post/track?barcodes=GB000000005GB';
    }), ROYAL);
    expect(elsewhere.delivery_carrier).toBeUndefined();
    const gls = parseEpostGlobal(rewrite('royal-mail-in-transit', (details) => {
      Object.assign(details, { Vendor: 'GLSEU', VendorTrackingUrl: '', VendorBaseUrl: 'https://gls-group.com/GROUP/en/parcel-tracking' });
    }), ROYAL);
    expect(gls.delivery_carrier).toBeUndefined();
    expect(gls.delivery_tracking_number).toBe('GB000000005GB');
    const dai = parseEpostGlobal(rewrite('royal-mail-in-transit', (details) => {
      Object.assign(details, { Vendor: 'DAI POST', VendorTrackingUrl: 'https://daipost.com/track?tracknbr=NZC999999999', VendorBaseUrl: '' });
    }), ROYAL);
    expect(dai.delivery_carrier).toBe('dai-post');
    const own = parseEpostGlobal(rewrite('royal-mail-in-transit', (details) => { details.Track = ROYAL; }), ROYAL);
    expect(own.delivery_tracking_number).toBeUndefined();
  });

  it('tracks and recognizes a shipment filed under the USPS code ending in US that its label carries', async () => {
    // A synthetic USPS code with a passing check digit.
    const number = 'LV123456785US';
    const filed = rewrite('spring-delivered', (details) => { details.Ref = number; }, number);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(filed));
    await expect(carrier(fetcher).track({ number: 'lv 123 456 785 us' })).resolves.toMatchObject({ status: 'delivered' });
    await expect(carrier(fetcher).recognize!(number)).resolves.toMatchObject({ known: true });
    expect(fetcher.mock.calls.map(([, init]) => String(init!.body))).toEqual([`id=${number}`, `id=${number}`]);
    // Another post's code is not ePost Global's to answer.
    await expect(carrier(fetcher).track({ number: 'LV123456785NL' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('binds the card to the number asked and the details to their own number', () => {
    expect(() => parseEpostGlobal(rewrite('spring-delivered', () => {}, 'LX000000005NL'), SPRING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEpostGlobal(rewrite('spring-delivered', (details) => { details.Ref = 'EPG990000000000009'; }), SPRING))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // Found by another number of the shipment: its partner number.
    expect(() => parseEpostGlobal(rewrite('spring-delivered', (details) => {
      details.Ref = 'EPG990000000000009';
      details.Track = SPRING;
    }), SPRING)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('drops repeated scans and rejects a changed reply', () => {
    for (const change of [
      (details: Details) => { details.Events[2]!.EventDT = '2026-03-11 07:55'; },
      (details: Details) => { details.Events[2]!.EventDT = '2026-02-30T07:55:00'; },
      (details: Details) => { details.Events[2]!.Event = { text: 'Out for delivery' }; },
      (details: Details) => { details.Events[2] = 'Out for delivery' as never; },
      (details: Details) => { details.Events = {} as never; },
      (details: Details) => { details.Events = Array.from({ length: 501 }, () => details.Events[0]!); },
    ]) {
      expect(() => parseEpostGlobal(rewrite('spring-delivered', change), SPRING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const html = text('spring-delivered');
    for (const body of [html.replace(/'(\{&quot;ID.*?\})'\)"/s, () => `'{broken')"`), html.replace('tracking-card0', 'card0'),
      html.replace('</div>\n    </div>\n    <!-- detailed', () => '</div>\n<div id=tracking-card1 onclick=""></div>\n    </div>\n    <!-- detailed')]) {
      expect(() => parseEpostGlobal(body, SPRING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a card without details, a shipment without scans and a browser check apart', async () => {
    const lookup = (html: string, number = UNKNOWN) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(html))).track({ number });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found').replaceAll("We haven't received any tracking updates", 'Please try again later')))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(rewrite('spring-delivered', (details) => { details.Events = []; }), SPRING)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>EPG Track | Track your Shipments</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: SPRING })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(SPRING)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known shipment and the unknown-number answer, and asks nothing for a number ePost Global does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('spring-delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(SPRING)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T05:40:44.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('LX000000005NL')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers ePost Global does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['EPG123456789', 'EPG1234567890123456', 'EPG99000000000000A', 'LX000000005NL', 'XPG990000000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: SPRING }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEpostGlobalNumber('epg-0110-0001-274')).toBe('EPG01100001274');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('royal-mail-in-transit')));
    await expect(carrier(fetcher).track({ number: ROYAL }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: SPRING }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a shipment filed under ePost Global to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('spring-delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: SPRING, carrier: 'epost-global' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'epost-global', source: 'epost-global', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === EPOST_GLOBAL_ENDPOINT)).toBe(true);
  });
});

describe('ePost Global status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, whatever the code', () => {
    for (const entry of statuses.entries) {
      expect(epostGlobalScanStage(entry.wording, entry.code)).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'epost-global', providerCode: '41', description: 'In transit via Post NL PACKTRACKED DIRECT tracking #:  LX000000005NL' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    // PostNL's 30 is not ePost Global's receipt.
    expect(statusMapAnswer({ carrier: 'epost-global', providerCode: '30', description: 'The item has been processed in the country of destination' }))
      .toEqual({ kind: 'unknown' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MHI_TRACKER, MhiTracker, mhiTrackingUrl } from './adapter.js';
import { normalizeMhiNumber, parseMhi } from './parser.js';
import { mhiMappedStage, mhiStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'MHI999W000000000017';
const POSTED = 'MHI999P000000017';
const UNKNOWN = 'MHI999W999999999999';
const COURIER = 'GLSX0001';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

const ROW = /<div class="item">[\s\S]*?<div class="itemlocationinfo">[^<]*<\/div>\s*<\/div>/;
/** The delivered page with its newest row changed. */
const newest = (change: (row: string) => string) => text('delivered.html').replace(ROW, change);
/** The delivered page with the courier's link changed. */
const linked = (href: string, reference = COURIER) => text('delivered.html')
  .replace(`<strong>${COURIER}</strong>`, `<strong>${reference}</strong>`)
  .replace(/<a href="[^"]*" target="_blank">View carrier tracking/, `<a href="${href}" target="_blank">View carrier tracking`);
const GLS_PL = `https://gls-group.com/PL/pl/sledzenie-paczek?match=${COURIER}`;

describe('MHI HTTP adapter', () => {
  it('opens the tracking page at the number’s address, with the dashes a P series label prints', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MhiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' mhi999 w0000 0000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MHI_TRACKER}?Tracking=${PARCEL}&command=Track`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mhi', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(mhiTrackingUrl(POSTED)).toBe(`${MHI_TRACKER}?Tracking=MHI-999-P000000017&command=Track`);
    expect(mhiTrackingUrl('MHI999WBB000000017')).toBe(`${MHI_TRACKER}?Tracking=MHI999WBB000000017&command=Track`);
    expect(mhiTrackingUrl('MHI999000000000017')).toBe(`${MHI_TRACKER}?Tracking=MHI999000000000017&command=Track`);
  });

  it('keeps the events as wall clocks with their places, newest first, without the courier’s link', () => {
    const result = parseMhi(text('delivered.html'), PARCEL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Successfully delivered', last_update: null, last_update_local: '2026-04-07T08:36:00', expected_delivery: null,
      service_name: 'Tracked' });
    expect(result.events).toHaveLength(18);
    expect(result.events!.slice(0, 3).map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-04-07T08:36:00', 'Successfully delivered', 'Sampletown, Samplecounty, MP, Poland', 'delivered'],
      ['2026-04-07T08:35:00', 'Delivery scheduled in the final delivery depot', 'Sampletown, Samplecounty, MP, Poland', 'out_for_delivery'],
      ['2026-04-06T18:52:00', 'Arrived at Pick-up Point', 'Sampletown, Samplecounty, MP, Poland', 'ready_for_pickup'],
    ]);
    expect(result.events!.slice(-3).map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-23T06:06:00', 'Notification sent to recipient', undefined, 'in_transit'],
      ['2026-03-23T06:03:00', 'Shipment information sent to last mile service provider', 'Demoford, Democounty, MZ, Netherlands', 'registered'],
      ['2026-03-23T06:02:00', 'Your order has been processed at the UK export facility. It is now on route to the receiver.', undefined, 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // Of two events on one minute, the row higher on the page is the newer.
    expect(result.events!.filter((event) => event.local_time === '2026-03-26T10:50:00').map((event) => event.description))
      .toEqual(['Dispatched from sorting center', 'Arrived at sorting center']);
    // The catalog knows no courier at the link's address; the link and the recipient's postcode in it are not kept.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/gls-info|zipcode|00-000|GLSX/);
  });

  it('hands off only to a courier its link names, for the number beside it', () => {
    expect(parseMhi(linked(GLS_PL), PARCEL)).toMatchObject({ delivery_carrier: 'gls-pl', delivery_tracking_number: COURIER });
    const usps = '9200190000000000000017';
    expect(parseMhi(linked(`https://tools.usps.com/go/TrackConfirmAction?tLabels=${usps}`, usps), PARCEL))
      .toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: usps });
    // The same number as asked is no second number.
    const same = parseMhi(linked(`https://tools.usps.com/go/TrackConfirmAction?tLabels=${PARCEL}`, PARCEL), PARCEL);
    expect(same).toMatchObject({ delivery_carrier: 'usps' });
    expect(same).not.toHaveProperty('delivery_tracking_number');
    // A courier's host the catalog does not know, a link for another number, a link that is no web address,
    // or a number that is not one name no courier.
    for (const body of [
      linked(`https://courier.example/track/${COURIER}`),
      linked('https://gls-group.com/PL/pl/sledzenie-paczek?match=GLSX0099'),
      linked(`javascript:void('${COURIER}')`),
      linked('not a link'),
      linked(GLS_PL.replace(COURIER, 'GLS'), 'GLS'),
      linked(GLS_PL).replace('<div class="itemcarrier">', '<div class="itemcarrier"></div><div class="itemcarrier">'),
    ]) {
      expect(parseMhi(body, PARCEL)).not.toHaveProperty('delivery_carrier');
    }
    // The MHI tracker itself is no courier.
    expect(parseMhi(linked(`${MHI_TRACKER}?Tracking=${COURIER}`), PARCEL)).not.toHaveProperty('delivery_carrier');
  });

  it('reads an untracked item, and the number the destination’s post gives it', () => {
    const untracked = text('untracked.html');
    const result = parseMhi(untracked, POSTED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', service_name: 'Untracked',
      last_update_local: '2026-02-03T11:20:00', delivery_tracking_number: 'UF000000014SE', destination_country: 'SE' });
    expect(result.events).toHaveLength(1);
    expect(result).not.toHaveProperty('delivery_carrier');
    // The post that gave the number is asked, even by a reader in its own country.
    const australian = parseMhi(untracked.replace('UF000000014SE', 'RR000000014AU'), POSTED);
    expect(australian).toMatchObject({ delivery_tracking_number: 'RR000000014AU', destination_country: 'AU' });
    expect(deliveryHandoff('mhi', POSTED, australian, 'AU')).toEqual({ carrier: 'australia-post', number: 'RR000000014AU', basis: 'destination' });
    // The dashed and the compact forms are one number.
    expect(parseMhi(untracked, 'MHI-999-P000000017')).toMatchObject({ delivery_tracking_number: 'UF000000014SE' });
    // A number that fails its check, or one the page does not offer as the post's, is none.
    expect(parseMhi(untracked.replace('UF000000014SE', 'UF000000017SE'), POSTED)).not.toHaveProperty('delivery_tracking_number');
    expect(parseMhi(untracked.replace(/local poster number/g, 'sample text'), POSTED)).not.toHaveProperty('delivery_tracking_number');
  });

  it('gives a text the map does not know the shared wording rules’ stage, else its category’s', () => {
    const changed = (wording: string, category: string) => parseMhi(newest((row) => row
      .replace('Successfully delivered', wording).replace('<div class="itemdetail">Delivery</div>', `<div class="itemdetail">${category}</div>`)), PARCEL);
    expect(changed('Returned to sender', 'Others')).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language' });
    expect(changed('Sample scan', 'Transit')).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Sample scan' });
    // A category that could hide another stage settles none, and the newest staged event decides.
    const odd = changed('Sample scan', 'Delivery');
    expect(odd).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Sample scan' });
    expect(odd.events![0]).not.toHaveProperty('stage');
    expect(mhiStage('Sample scan', 'Pre-alert')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(mhiStage('Sample scan', 'Out for delivery')).toBeNull();
  });

  it('reads the page for a number the tracker does not know as not found', async () => {
    expect(() => parseMhi(text('not-found.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps only the parcel under the whole number asked, and has no history for one without rows', () => {
    expect(() => parseMhi(text('not-found.html'), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'MHI answered for another shipment' }));
    expect(() => parseMhi(text('delivered.html').replace(`value="${PARCEL}"`, 'value=""'), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'MHI answered for another shipment' }));
    const empty = text('delivered.html').replace(/<fieldset name="detailedInfo">[\s\S]*?<\/fieldset>/, '<fieldset name="detailedInfo"></fieldset>');
    expect(() => parseMhi(empty, PARCEL)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    const row = ROW.exec(delivered)![0];
    const unknownRow = ROW.exec(text('not-found.html'))![0];
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('id="Tracking"', 'id="Search"'),
      delivered.replace('<fieldset>', `<fieldset><input id="Tracking" value="${PARCEL}" />`),
      newest((value) => value.replace('7 Apr 2026', '2026-04-07')),
      newest((value) => value.replace('7 Apr 2026', '31 Apr 2026')),
      newest((value) => value.replace('7 Apr 2026', '7 Apr 1999')),
      newest((value) => value.replace('08:36', '8.36')),
      newest((value) => value.replace('08:36', '24:00')),
      newest((value) => value.replace('Successfully delivered', ' ')),
      newest((value) => value.replace(/<div class="itemlocationinfo">[^<]*<\/div>/, '')),
      newest((value) => value.replace('<div class="itemdetail">08:36</div>', '<div class="itemdetail">08:36</div><div class="itemdetail">08:37</div>')),
      delivered.replace(row, `${row}${unknownRow}`),
      delivered.replace(row, row.repeat(501)),
    ].entries()) {
      expect(() => parseMhi(body, PARCEL), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a firewall page, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: PARCEL });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://www.trackmail.co.uk/Error' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
  });

  it('refuses what is no MHI number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The older two-digit and eight-digit series, a courier's number and a USPS number are not asked.
    for (const number of ['12345', COURIER, 'MHI99900000017', 'MHI99W000000000017', 'MHI999X000000000017', 'MHI999P00000017', 'MHI999WBB0000000017',
      '9200190000000000000017', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMhiNumber(' mhi-999-p000000017 ')).toBe(POSTED);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => html(text('delivered.html')))).recognize!(PARCEL)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(text('not-found.html')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('12345')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under MHI to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: PARCEL, carrier: 'mhi' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'mhi', source: 'mhi', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === mhiTrackingUrl(PARCEL))).toBe(true);
  });
});

describe('MHI status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'mhi', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(mhiMappedStage(entry.wording), entry.wording).toBe(entry.stage);
    }
  });
});

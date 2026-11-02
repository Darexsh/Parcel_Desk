import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HUNTER_EXPRESS_TRACKER, HunterExpressTracker, hunterExpressLookupUrl } from './adapter.js';
import { normalizeHunterExpressNumber, parseHunterExpress } from './parser.js';
import { hunterExpressMappedStage, hunterExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZZ000001';
const IN_TRANSIT = 'ZZZ000002';
const UNKNOWN = 'ZZZ000009';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';
// The detail-panel address of the delivered fixture's depot row, and its ticks.
const DEPOT_ROW = 'Depot+In%3aSAMPLEVILLE%7c%7c14%2f04%2f2026%7c%7c100000001%7c%7c639117486000000000%7c%7c639117486000000000';

describe('Hunter Express HTTP adapter', () => {
  it('opens the tracker with the number in its address, as the search box does', async () => {
    const fetcher = replying(() => html(text('in-transit.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HunterExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzz 000-002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HUNTER_EXPRESS_TRACKER}${IN_TRANSIT}`);
    expect(url).toBe(hunterExpressLookupUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hunter-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history, newest first, with the instants the page gives and the weight', () => {
    const result = parseHunterExpress(text('delivered.html'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-04-15T13:15:00+10:00', delivered_at: '2026-04-15T13:15:00+10:00',
      expected_delivery: null, weight_kg: 12 });
    expect(result.events).toEqual([
      { time: '2026-04-15T13:15:00+10:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-04-14T21:40:12Z', location: 'SAMPLEVILLE', description: 'On Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-04-14T08:05:41Z', location: 'SAMPLEVILLE', description: 'Held For Processing', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-04-14T07:30:00Z', location: 'SAMPLEVILLE', description: 'Depot In', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-04-14T09:12:00+10:00', description: 'Pickup Completed', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE \(|Sampletown|VIC|100000001|17\/04|-10\.0|mydel/);
  });

  it('adds the newer dated status above the history and reads the estimate window', () => {
    const result = parseHunterExpress(text('in-transit.html'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'OnDelivery, Left Depot',
      last_update: '2026-02-04T07:42:00+11:00', delivered_at: null, expected_delivery_from: '2026-02-04', expected_delivery: '2026-02-06', weight_kg: 25 });
    // The out-for-delivery row's first scan, which falls on the day before in UTC.
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-02-04T07:42:00+11:00', 'OnDelivery, Left Depot', 'out_for_delivery'],
      ['2026-02-03T20:15:30Z', 'On Delivery', 'out_for_delivery'],
      ['2026-02-03T07:50:00Z', 'Depot In', 'in_transit'],
      ['2026-02-03T14:05:00+11:00', 'Pickup Completed', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample note|Sample Name|Approx|Sampletown|8:03|08:03/);
  });

  it('leaves out a dated status that the history already reaches', () => {
    for (const heading of ['OnDelivery, Left Depot: 4/02/2026 7:15 AM AEDT', 'Depot In: 3/02/2026']) {
      const page = text('in-transit.html').replace('OnDelivery, Left Depot: 4/02/2026 7:42 AM AEDT\n</h2>', `${heading}\n</h2>`);
      const result = parseHunterExpress(page, IN_TRANSIT);
      expect(result.events, heading).toHaveLength(3);
      expect(result, heading).toMatchObject({ last_status_text: 'On Delivery', last_update: '2026-02-03T20:15:30Z' });
    }
  });

  it('keeps a row as its day when its panel address does not bind it, and an unknown zone as a wall clock', () => {
    const page = text('delivered.html');
    const dayOf = (body: string) => parseHunterExpress(body, DELIVERED).events!.find((event) => event.description === 'Depot In');
    for (const changed of [
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('100000001', '100000003')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('SAMPLEVILLE', 'OTHERVILLE')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('14%2f04', '13%2f04')),
      // Ticks a day off the row's date, or in the wrong order.
      page.replace(DEPOT_ROW, DEPOT_ROW.replace(/639117486000000000$/, '639116622000000000').replace('639117486000000000%7c', '639116622000000000%7c')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace(/639117486000000000$/, '639117485990000000')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace(/%7c%7c639117486000000000$/, '')),
      page.replace(`<td childSectionUrl='https://mydel.info/Public/Consignment/ConsignmentTrackingScanChild?id=${DEPOT_ROW}'>`, '<td>'),
      page.replace('https://mydel.info/Public/Consignment/ConsignmentTrackingScanChild?id=Depot', 'not a url Depot'),
    ]) {
      expect(dayOf(changed)).toEqual({ local_time: '2026-04-14', location: 'SAMPLEVILLE', description: 'Depot In', stage: 'in_transit', stage_source: 'carrier_map' });
    }
    const result = parseHunterExpress(page.replace('15/04/2026 1:15 PM AEST</td>', '15/04/2026 12:15 AM NZST</td>'), DELIVERED);
    expect(result.events![0]).toEqual({ local_time: '2026-04-15T00:15:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    // A delivery without an instant has no delivery instant.
    expect(result).toMatchObject({ delivered_at: null, last_update: null, last_update_local: '2026-04-15T00:15:00' });
  });

  it('reads the tracker’s “missing or incorrect” as inconclusive, not as a missing consignment', async () => {
    expect(() => parseHunterExpress(text('not-found.html'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // The empty form with another notice is not the tracker's answer.
    expect(() => parseHunterExpress(text('not-found.html').replace('Missing or incorrect tracking number', 'Please try again later'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a page that names the whole number asked', () => {
    expect(() => parseHunterExpress(text('delivered.html'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Hunter Express answered for another consignment' }));
    expect(() => parseHunterExpress(text('delivered.html').replace(`'label-Text'>${DELIVERED} `, `'label-Text'>${DELIVERED}0 `), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Hunter Express answered for another consignment' }));
    expect(() => parseHunterExpress(text('delivered.html').replace(`'label-Text'>${DELIVERED} `, '\'label-Text\'> '), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Hunter Express did not name the consignment' }));
    expect(parseHunterExpress(text('delivered.html').replace(`'label-Text'>${DELIVERED} `, `'label-Text'>${DELIVERED.toLowerCase()} `), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed page', () => {
    const page = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      page.replace('id="IdConsignment" value="100000001"', 'id="IdConsignment" value="sample"'),
      page.replace('<input type="hidden" name="IdConsignment"', '<input type="hidden" id="IdConsignment" value="1"><input type="hidden" name="IdConsignment"'),
      page.replace('Current Status: Delivered', 'Status: Delivered'),
      page.replace('GridScansAdv GridScansAdv', 'GridScans'),
      page.replace("<th class='Location'>Location</th>", "<th class='Location'>Place</th>"),
      page.replace('<td class="Location" >SAMPLEVILLE</td>', ''),
      page.replace('<td class="ScanType" >Depot In</td>', '<td class="ScanType" > </td>'),
      page.replace('<td class="ScanDate" >14/04/2026</td>', '<td class="ScanDate" >2026-04-14</td>'),
      page.replace('<td class="ScanDate" >14/04/2026</td>', '<td class="ScanDate" >31/04/2026</td>'),
      page.replace('14/04/2026 9:12 AM AEST', '14/04/2026 13:12 PM AEST'),
      page.replace('14/04/2026 9:12 AM AEST', '14/04/2026 9:72 AM AEST'),
      page.replace(/<tbody>\n/, `<tbody>\n${'<tr><td></td><td class="ScanType" >Depot In</td><td class="Location" >X</td><td class="ScanDate" >14/04/2026</td></tr>'.repeat(501)}`),
    ].entries()) {
      expect(() => parseHunterExpress(body, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a consignment whose table holds no scan', () => {
    const empty = text('delivered.html').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(() => parseHunterExpress(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads no estimate or weight it cannot parse', () => {
    const page = text('in-transit.html');
    for (const estimate of ['6/02/2026 - 4/02/2026', '31/02/2026 - 6/02/2026', 'Sample', '']) {
      expect(parseHunterExpress(page.replace('4/02/2026 - 6/02/2026', estimate), IN_TRANSIT), estimate).toMatchObject({ expected_delivery: null });
    }
    expect(parseHunterExpress(page.replace('4/02/2026 - 6/02/2026', '1-4 Business Days <br/><small>6/02/2026</small>'), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-02-06' });
    expect(parseHunterExpress(page.replace('25kgs', 'Sample'), IN_TRANSIT)).not.toHaveProperty('weight_kg');
    expect(parseHunterExpress(page.replace('25kgs', '0kgs'), IN_TRANSIT)).not.toHaveProperty('weight_kg');
    expect(parseHunterExpress(page.replace('25kgs', '2.5kg'), IN_TRANSIT)).toMatchObject({ weight_kg: 2.5 });
  });

  it('keeps a browser check, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: DELIVERED });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://portal.hunterexpress.com.au/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    // A page that carries the consignment is the tracker's, whatever else it embeds.
    await expect(lookup(() => html(text('delivered.html').replace('</body>', '<div class="g-recaptcha"></div></body>'))))
      .resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
  });

  it('refuses what the carrier does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZZ00', 'ZZZZZZZZZ', `ZZZ${'0'.repeat(28)}`, 'ZZZ000001,ZZZ000002', 'ZZZ/000001', 'ZZZ000001?', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHunterExpressNumber(' zzz-000 001 ')).toBe(DELIVERED);
    expect(normalizeHunterExpressNumber('000001')).toBe('000001');
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('declares no recognition: the tracker never says a number is unknown', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Hunter Express to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'hunter-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'hunter-express', source: 'hunter-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === hunterExpressLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Hunter Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'hunter-express', description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(hunterExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves another wording to the shared rules', () => {
    expect(hunterExpressMappedStage('card left')).toBeUndefined();
    expect(hunterExpressStage('Card Left')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(hunterExpressStage('Sample Wording')).toBeNull();
    expect(statusMap.stage(null, 'depot in')).toBe('in_transit');
    expect(statusMapAnswer({ carrier: 'hunter-express', description: 'Sample Wording' })).toEqual({ kind: 'unknown' });
  });
});

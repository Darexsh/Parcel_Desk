import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PBT_RESULT, pbtResultUrl, PbtTracker } from './adapter.js';
import { normalizePbtNumber, parsePbt, readPbtRedirect } from './parser.js';
import { pbtStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZD00000002';
const IN_TRANSIT = 'ZZT0000001';
const UNKNOWN = 'ZZU0000009';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
// The tracking page's answer for a number it does not know.
const missing = (number: string) => answering(() => reply(null,
  { status: 302, headers: { Location: `/?consignmentNumber=${number}&hasError=true#tracking-search` } }));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parsePbt>) => result.events!.map((event) => [event.local_time, event.description,
  event.stage ?? null, event.location ?? null]);
// One item of the page, by its number: its heading, then its history.
const ITEM = (number: string) => new RegExp(`(<div class="tracking-result-item">\\s*<div id="heading-${number}"[\\s\\S]*?</div>\\s*</div>\\s*)(?=<div class="tracking-result-item">|</div>\\s*</div>\\s*<div class="tracking-result-details">)`);
const withItem = (html: string, number: string, change: (item: string) => string) => html.replace(ITEM(number), (item: string) => change(item));
const entry = (day: string, hour: string, wording: string, line = '') => '<div class="tracking-result-item-collapse-entry "><div class="row">'
  + `<div class="tracking-result-item-collapse-time"><div><strong>${day}</strong></div><div>at ${hour}</div></div>`
  + `<div class="tracking-result-item-collapse-status"><div>${wording}</div>${line ? `<div>${line}</div>` : ''}</div></div></div>`;
// A row added at the end of an item's history.
const addRow = (html: string, number: string, row: string) => withItem(html, number, (item) => item.replace(/(\s*<\/div>\s*<\/div>\s*)$/, `${row}$1`));
const headingStatus = (html: string, number: string, status: string) => withItem(html, number,
  (item) => item.replace(/(js-tracking-result-item-heading-status">\s*<div>)[^<]*/, `$1${status}`));

describe('PBT HTTP adapter', () => {
  it('asks the tracking page for the whole number, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PbtTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzt-000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PBT_RESULT}?consignmentNumber=${IN_TRANSIT}`);
    expect(pbtResultUrl(`${DELIVERED}001`)).toBe(`https://www.pbt.nz/tracking-result/?consignmentNumber=${DELIVERED}001`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pbt', step: 'direct', outcome: 'ok' }));
  });

  it('reads an in-transit item newest first by its clocks, at PBT’s sites, with its heading’s status', () => {
    const result = parsePbt(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Drivers Bay', last_update: null, last_update_local: '2026-10-18T09:46:00', expected_delivery: null,
      weight_kg: 6,
    });
    for (const field of ['summary_only', 'history_truncated', 'delivered_at', 'receiver_name', 'sender_name', 'canonical_tracking_number']) {
      expect(result).not.toHaveProperty(field);
    }
    // The repeated row is kept once; the pickup request, stamped after the pickup, has its reference, which is not a place.
    expect(events(result)).toEqual([
      ['2026-10-18T09:46:00', 'In Drivers Bay', 'in_transit', 'PBT Couriers Exampleton North Depot'],
      ['2026-10-17T08:59:00', 'In Drivers Bay', 'in_transit', 'PBT Couriers Exampleton North Depot'],
      ['2026-10-16T22:37:00', 'In Depot', 'in_transit', 'PBT Couriers Exampleton Central Depot'],
      ['2026-10-14T21:06:00', 'In Transit', 'in_transit', 'PBT Couriers Sampleton'],
      ['2026-10-14T15:33:00', 'Pickup Requested', 'registered', null],
      ['2026-10-14T15:21:00', 'Picked Up', 'accepted', 'PBT Couriers Sampleton'],
    ]);
    // Rows of one status out of their clocks' order, as the page can list them, are put in order.
    const swapped = fixture('in-transit').replace('<div>at 21:06</div>', '<div>at 15:25</div>');
    expect(events(parsePbt(swapped, IN_TRANSIT)).slice(3).map(([clock, label]) => [clock, label])).toEqual([
      ['2026-10-14T15:33:00', 'Pickup Requested'], ['2026-10-14T15:25:00', 'In Transit'], ['2026-10-14T15:21:00', 'Picked Up'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && !('provider_code' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLETON|PUC000001|SAMPLE-REF|Cubic|Express Freight Network/);
  });

  it('reads a delivered consignment’s items as one history, without the receiver or the proof of delivery', () => {
    const result = parsePbt(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Signed as received', last_update_local: '2026-04-07T10:05:00', weight_kg: 12.5,
    });
    // The rows both items share are kept once.
    expect(events(result)).toEqual([
      ['2026-04-07T10:05:00', 'Signed as received', 'delivered', null],
      ['2026-04-07T07:30:00', 'Goods with delivery courier', 'out_for_delivery', 'PBT Couriers Exampleton Central Depot'],
      ['2026-04-07T06:12:00', 'In Depot', 'in_transit', 'PBT Couriers Exampleton Central Depot'],
      ['2026-04-06T18:40:00', 'In Transit', 'in_transit', 'PBT Couriers Sampleton Depot'],
      ['2026-04-06T11:13:00', 'Pickup Requested', 'registered', null],
      ['2026-04-06T10:58:00', 'Picked Up', 'accepted', 'PBT Couriers Sampleton'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECEIVER|example\.invalid|Proof of delivery|SAMPLE-REF/);
    // Who took the item is left out of the wording and the heading.
    const signed = headingStatus(addRow(fixture('delivered'), `${DELIVERED}002`,
      entry('08 Apr 26', '09:00', 'Delivered - signed by SAMPLE PERSON', 'SAMPLE PERSON')), `${DELIVERED}002`, 'Received by SAMPLE PERSON');
    const kept = parsePbt(signed, DELIVERED);
    expect(kept.events![0]).toEqual({ local_time: '2026-04-08T09:00:00', description: 'Delivered - signed', stage: 'delivered', stage_source: 'wording:language' });
    expect(JSON.stringify(kept)).not.toContain('SAMPLE PERSON');
  });

  it('keeps a consignment on its way until every item is delivered', () => {
    const second = `${DELIVERED}002`;
    const partial = headingStatus(fixture('delivered').replace(/(<div id="heading-ZZD00000002002"[\s\S]*?)<div class="tracking-result-item-collapse-entry ">\s*<div class="row">\s*<div class="col-4 col-xl-3 tracking-result-item-collapse-time">\s*<div><strong>07 Apr 26<\/strong><\/div>\s*<div>at 10:05<\/div>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*(?=<\/div>\s*<\/div>\s*<div class="tracking-result-details">)/, '$1'), second, 'Goods with delivery courier');
    const result = parsePbt(partial, DELIVERED);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Goods with delivery courier', last_update_local: '2026-04-07T07:30:00' });
    expect(result.events![0]).toMatchObject({ description: 'Signed as received' });
  });

  it('reads an item number as its own item, without its siblings or the consignment’s weight', () => {
    const second = `${DELIVERED}002`;
    const own = headingStatus(addRow(fixture('delivered'), second, entry('08 Apr 26', '08:00', 'In Depot', 'PBT Couriers Sampleton Depot')),
      second, 'In Depot');
    expect(parsePbt(own, `${DELIVERED}001`)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Signed as received' });
    const item = parsePbt(own, second);
    expect(item).toMatchObject({ current_stage: 'in_transit', last_status_text: 'In Depot', last_update_local: '2026-04-08T08:00:00' });
    expect(item).not.toHaveProperty('weight_kg');
    expect(item.events).toHaveLength(7);
    // The consignment's weight belongs to the item when the item is all of it.
    const single = fixture('in-transit');
    expect(parsePbt(single, `${IN_TRANSIT}001`)).toMatchObject({ current_stage: 'in_transit', weight_kg: 6 });
    // An item the page does not list is no answer.
    expect(() => parsePbt(own, `${DELIVERED}003`)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes the newest staged row when the heading has no status, and keeps unknown wording without a stage', () => {
    const blank = headingStatus(fixture('in-transit'), `${IN_TRANSIT}001`, '');
    expect(parsePbt(blank, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'In Drivers Bay' });
    const unknown = addRow(fixture('in-transit'), `${IN_TRANSIT}001`, entry('19 Oct 26', '07:00', 'Sample Status', 'PBT Couriers Sampleton'));
    const result = parsePbt(headingStatus(unknown, `${IN_TRANSIT}001`, ''), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'In Drivers Bay', last_update_local: '2026-10-18T09:46:00' });
    expect(result.events![0]).toEqual({ local_time: '2026-10-19T07:00:00', location: 'PBT Couriers Sampleton', description: 'Sample Status' });
    const labelled = parsePbt(headingStatus(unknown, `${IN_TRANSIT}001`, 'Sample Status'), IN_TRANSIT);
    expect(labelled).toMatchObject({ status: 'unknown', last_status_text: 'Sample Status', last_update_local: '2026-10-19T07:00:00' });
    expect(labelled).not.toHaveProperty('current_stage');
    // An item with a status and no rows is a summary.
    const summary = withItem(fixture('in-transit'), `${IN_TRANSIT}001`, (item) => item.replace(/<div class="tracking-result-item-collapse-entry[\s\S]*(?=<\/div>\s*<\/div>\s*$)/, ''));
    expect(parsePbt(summary, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', summary_only: true, events: [] });
    const empty = headingStatus(summary, `${IN_TRANSIT}001`, '');
    expect(() => parsePbt(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const none = withItem(fixture('in-transit'), `${IN_TRANSIT}001`, () => '');
    expect(() => parsePbt(none, IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the redirect back to the form as not found, and a page only when it lists the number asked', () => {
    expect(() => readPbtRedirect(`/?consignmentNumber=${UNKNOWN}&hasError=true#tracking-search`, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => readPbtRedirect(`https://www.pbt.nz/?consignmentNumber=${UNKNOWN.toLowerCase()}&hasError=true`, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => readPbtRedirect(`/?consignmentNumber=${IN_TRANSIT}&hasError=true`, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PBT answered for another number' }));
    for (const location of [null, '', '/', `/?consignmentNumber=${UNKNOWN}`, `/maintenance/?consignmentNumber=${UNKNOWN}&hasError=true`,
      `https://example.com/?consignmentNumber=${UNKNOWN}&hasError=true`, 'http://[']) {
      expect(() => readPbtRedirect(location, UNKNOWN), String(location)).toThrow(expect.objectContaining({ kind: 'transport' }));
    }
    // A client that follows the redirect lands on the form, with the number in it.
    expect(() => parsePbt(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePbt(fixture('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A page for another consignment, or one that mixes in another consignment's item, is no answer.
    expect(() => parsePbt(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PBT answered for another consignment' }));
    expect(() => parsePbt(fixture('in-transit'), 'ZZT00000010')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = fixture('delivered').replaceAll(`${DELIVERED}002`, 'ZZX00000002002');
    expect(() => parsePbt(mixed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePbt(mixed, `${DELIVERED}001`)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    const item = `${IN_TRANSIT}001`;
    for (const change of [
      (html: string) => html.replace(`id="heading-${item}"`, 'id="heading"'),
      (html: string) => html.replace(`tracking-result-item-heading-label">${item}`, 'tracking-result-item-heading-label">ZZT0000002001'),
      (html: string) => html.replace('<div><strong>14 Oct 26</strong></div>', '<div><strong>14/10/2026</strong></div>'),
      (html: string) => html.replace('<div><strong>14 Oct 26</strong></div>', '<div><strong>31 Feb 26</strong></div>'),
      (html: string) => html.replace('<div>at 15:33</div>', '<div>at 25:33</div>'),
      (html: string) => html.replace('<div>at 15:33</div>', '<div>3:33 PM</div>'),
      (html: string) => html.replace('<div>at 15:33</div>', ''),
      (html: string) => html.replace('<div>Pickup Requested</div>', '<div></div>'),
      (html: string) => html.replace('<p class="tracking-result-details-small">Weight: 6.0</p>', '<p>Weight: 6.0</p><p>Weight: 7.0</p>'),
      (html: string) => addRow(html, item, entry('19 Oct 26', '07:00', 'In Depot').repeat(2_001)),
    ]) {
      expect(() => parsePbt(change(fixture('in-transit')), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['', '<html><body>PBT</body></html>', fixture('not-found').replace(' has-error', '')]) {
      expect(() => parsePbt(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(missing(UNKNOWN)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(missing(IN_TRANSIT)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply(null, { status: 301, headers: { Location: 'https://www.pbt.nz/tracking/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>PBT</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the redirect for an unknown one, and asks nothing for a number PBT does not issue', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-07T10:05:00' });
    await expect(carrier(missing(UNKNOWN)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another consignment is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('Z0000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers PBT does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '0000000001', 'Z0000000001', 'ZZZZ0000001', 'ZZT000001', 'ZZT000000000001', 'ZZ0000001',
      'ZZ0000000000001', 'ZZT0000001A', '0ZZT000001', `${IN_TRANSIT}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of ['zzt0000001', 'ZZT 000 0001', ' ZZT-0000001 ']) expect(normalizePbtNumber(raw), raw).toBe(IN_TRANSIT);
    for (const number of ['ZZT00000001', 'ZZT0000001001', 'ZZT00000001001', 'ZZ00000001', 'ZZ000000001', 'ZZ00000001001', 'ZZ000000001001']) {
      expect(normalizePbtNumber(number), number).toBe(number);
    }
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number the caller names PBT’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pbt' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pbt', source: 'pbt', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === pbtResultUrl(DELIVERED))).toBe(true);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'pbt', steps: ['direct', 'retry', 'trawl'], recognition: { rank: 623 }, localClocks: true, browser: true });
  });
});

describe('PBT numbers', () => {
  it('leaves PBT’s shapes to the caller’s choice, and reads tracker links', () => {
    // Other carriers print the same shapes, so neither detection nor recognition offers PBT.
    for (const number of [IN_TRANSIT, DELIVERED, `${IN_TRANSIT}001`, 'ZZ00000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('pbt');
      expect(recognitionAskedCarriers(number), number).not.toContain('pbt');
    }
    for (const link of [`https://www.pbt.nz/tracking-result/?consignmentNumber=${IN_TRANSIT}`,
      `https://pbt.nz/tracking-result?consignmentnumber=${IN_TRANSIT}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'pbt', source: 'link' });
    }
  });
});

describe('PBT status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(pbtStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'pbt', providerCode: null, description: 'In Drivers Bay' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'pbt', providerCode: null, description: 'Sample Status' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared rules, else stays without a stage.
    expect(pbtStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(pbtStage('Sample Status')).toBeNull();
  });
});

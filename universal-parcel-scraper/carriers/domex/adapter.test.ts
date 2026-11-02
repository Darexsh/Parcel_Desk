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
import { adapter, DOMEX_TRACKING, domexTrackingUrl, DomexTracker } from './adapter.js';
import { domexLine, normalizeDomexNumber, parseDomex } from './parser.js';
import { domexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '000000001';
const IN_TRANSIT = 'EC000000002';
const RETURNED = 'EC000000003';
const UNKNOWN = '00000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// The tracking table's rows, oldest first, as the page lists them.
const TABLE = /(<tbody id="tracking-table-body">)([\s\S]*?)(\s*<\/tbody>)/;
const withRows = (html: string, change: (rows: string) => string) => html.replace(TABLE, (_, head: string, rows: string, end: string) =>
  `${head}${change(rows)}${end}`);
const row = (when: string, what: string) => `
           <tr>
            <td class=" p-2 border-[1px] border-black  font-[500] ">${when}</td>
            <td class=" p-2 border-[1px] border-black font-[500] text-[16px]">${what}        </td>
    </tr>
`;
const events = (result: ReturnType<typeof parseDomex>) => result.events!.map((event) => [event.time, event.description,
  event.location ?? null, event.stage ?? null]);
// What the page shows of the sender, the receiver and who delivered, none of which is kept.
const PERSONAL = /SAMPLE STORE|EXAMPLE ROAD|SAMPLETOWN|SAMPLE RIDER|TEST RECEIVER|0700000|Riverside|COD/;

describe('Domex HTTP adapter', () => {
  it('asks the tracking page for the whole waybill, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DomexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ec 000-000-002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DOMEX_TRACKING}?wbno=${IN_TRANSIT}`);
    expect(domexTrackingUrl('000 000 001')).toBe(`${DOMEX_TRACKING}?wbno=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'domex', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history newest first, in Colombo time, at the branches that recorded it', () => {
    const result = parseDomex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language', last_status_text: 'Delivered',
      last_update: '2026-03-04T12:05:00+05:30', delivered_at: '2026-03-04T12:05:00+05:30', expected_delivery: null,
    });
    for (const field of ['summary_only', 'last_update_local', 'receiver_name', 'sender_name', 'weight_kg', 'history_truncated']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-03-04T12:05:00+05:30', 'Delivered', 'Lakeside', 'delivered'],
      ['2026-03-04T09:30:00+05:30', 'Out For Delivery', 'Lakeside', 'out_for_delivery'],
      ['2026-03-03T17:30:00+05:30', 'Reschedule', 'Lakeside', 'failed_attempt'],
      ['2026-03-03T09:45:00+05:30', 'Out For Delivery', 'Lakeside', 'out_for_delivery'],
      ['2026-03-03T08:20:00+05:30', 'Parcel Received', 'Lakeside', 'in_transit'],
      ['2026-03-03T02:10:00+05:30', 'In Transit', 'Central Ops Hub', 'in_transit'],
      ['2026-03-02T23:50:00+05:30', 'Arrived at Sort Facility', 'Central Ops Hub', 'in_transit'],
      ['2026-03-02T19:05:00+05:30', 'Parcel Send to Sort Facility', 'Northbay', 'in_transit'],
      ['2026-03-02T16:40:00+05:30', 'Parcel Received', 'Northbay', 'in_transit'],
      ['2026-03-02T10:15:00+05:30', 'Waiting To Pickup By Customer location', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && !('provider_code' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
  });

  it('reads an in-transit history by its newest staged scan', () => {
    const result = parseDomex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'In Transit',
      last_update: '2026-10-11T03:15:00+05:30', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result)).toEqual([
      ['2026-10-11T03:15:00+05:30', 'In Transit', 'Central Ops Hub', 'in_transit'],
      ['2026-10-11T00:35:00+05:30', 'Arrived at Sort Facility', 'Central Ops Hub', 'in_transit'],
      ['2026-10-10T19:02:00+05:30', 'Parcel Received', 'Northbay', 'in_transit'],
      ['2026-10-10T18:45:00+05:30', 'Parcel Send to Sort Facility', 'Northbay', 'in_transit'],
      ['2026-10-10T11:20:00+05:30', 'Waiting To Pickup By Customer location', null, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
    // A line the map does not know is kept without a stage; the newest staged scan decides.
    const unlabelled = parseDomex(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-11 @ (8:00 am)', 'Sample Status By Hilltown')}`), IN_TRANSIT);
    expect(unlabelled).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample Status', last_update: '2026-10-11T08:00:00+05:30' });
    expect(unlabelled.events![0]).toMatchObject({ location: 'Hilltown' });
    expect(unlabelled.events![0]).not.toHaveProperty('stage');
    // A delivery round, then a hold at the branch.
    const out = parseDomex(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-11 @ (9:10 am)', 'Out For Delivery By Hilltown')}`), IN_TRANSIT);
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    const held = parseDomex(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-11 @ (3:40 pm)', 'Hold By Hilltown')}`), IN_TRANSIT);
    expect(held).toMatchObject({ status: 'exception', current_stage: 'exception', last_update: '2026-10-11T15:40:00+05:30' });
  });

  it('reads a return to the sender, past the head office closing the waybill', () => {
    const result = parseDomex(fixture('returned'), RETURNED);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', last_status_text: 'Complete By HO - FINANCE',
      last_update: '2026-05-11T10:25:00+05:30',
    });
    expect(result).not.toHaveProperty('delivered_at');
    // The page lists one hub scan twice; it is kept once.
    expect(result.events).toHaveLength(16);
    expect(events(result).slice(0, 4)).toEqual([
      ['2026-05-11T10:25:00+05:30', 'Complete By HO - FINANCE', null, null],
      ['2026-05-08T11:52:00+05:30', 'Return To Customer Confirmed', 'Northbay', 'returned'],
      ['2026-05-08T11:40:00+05:30', 'Return To Customer', 'Northbay', 'returned'],
      ['2026-05-08T09:00:00+05:30', 'Parcel Received', 'Northbay', 'in_transit'],
    ]);
    expect(events(result).filter(([, description]) => description === 'Return To Next Branch'))
      .toEqual([['2026-05-07T13:30:00+05:30', 'Return To Next Branch', 'Hilltown', 'returned']]);
    expect(events(result).filter(([, description]) => description === 'Hold')).toHaveLength(2);
  });

  it('orders scans by their clocks, keeping the page’s order within a minute', () => {
    const late = parseDomex(withRows(fixture('in-transit'), (rows) => `${row('2026-10-11 @ (6:00 am)', 'Parcel Received By Hilltown')}${rows}`), IN_TRANSIT);
    expect(late.events![0]).toMatchObject({ time: '2026-10-11T06:00:00+05:30', description: 'Parcel Received', location: 'Hilltown' });
    const sameMinute = parseDomex(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-11 @ (3:15 am)', 'Parcel Received By Hilltown')}`), IN_TRANSIT);
    expect(events(sameMinute).slice(0, 2)).toEqual([
      ['2026-10-11T03:15:00+05:30', 'Parcel Received', 'Hilltown', 'in_transit'],
      ['2026-10-11T03:15:00+05:30', 'In Transit', 'Central Ops Hub', 'in_transit'],
    ]);
    // Noon and midnight, as the page writes them.
    const clocks = parseDomex(withRows(fixture('in-transit'), (rows) => `${rows}${row('2026-10-12 @ (12:00 am)', 'In Transit By Central Ops Hub')}${row('2026-10-12 @ (12:30 pm)', 'Parcel Received By Hilltown')}`), IN_TRANSIT);
    expect(clocks.events!.slice(0, 2).map((event) => event.time)).toEqual(['2026-10-12T12:30:00+05:30', '2026-10-12T00:00:00+05:30']);
  });

  it('splits a status line into its wording and the branch that recorded it', () => {
    expect(domexLine('  Parcel Received   By Northbay  ')).toEqual({ description: 'Parcel Received', location: 'Northbay' });
    expect(domexLine('Return To Customer Confirmed By Northbay')).toEqual({ description: 'Return To Customer Confirmed', location: 'Northbay' });
    // The sender's premises and a head office department are no place.
    expect(domexLine('Waiting To Pickup By Customer location')).toEqual({ description: 'Waiting To Pickup By Customer location' });
    expect(domexLine('Complete By HO - FINANCE')).toEqual({ description: 'Complete By HO - FINANCE' });
    expect(domexLine('In Transit')).toEqual({ description: 'In Transit' });
    // A phone number in a line is dropped.
    expect(domexLine('Reschedule 0700000000 By Lakeside')).toEqual({ description: 'Reschedule', location: 'Lakeside' });
  });

  it('reads the page’s notice as not found, and a parcel only when the page names the number asked', () => {
    expect(() => parseDomex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // An answer for another number is no answer, either way.
    expect(() => parseDomex(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Domex answered for another number' }));
    expect(() => parseDomex(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Domex answered for another number' }));
    // The digits without the prefix are another waybill.
    expect(() => parseDomex(fixture('in-transit'), IN_TRANSIT.slice(2)))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDomex(withRows(fixture('in-transit'), () => ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (html: string) => html.replace('<tbody id="tracking-table-body">', '<tbody id="tracking-rows">'),
      (html: string) => html.replace(`id="WayBillNumber">${IN_TRANSIT}<`, 'id="WayBillNumber"><'),
      (html: string) => html.replace(/<td[^>]*id="WayBillNumber">[^<]*<\/td>/, (cell) => `${cell}${cell}`),
      (html: string) => withRows(html, (rows) => `${row('2026-02-30 @ (9:00 am)', 'Hold By Hilltown')}${rows}`),
      (html: string) => withRows(html, (rows) => `${row('2026-10-11 @ (13:00 pm)', 'Hold By Hilltown')}${rows}`),
      (html: string) => withRows(html, (rows) => `${row('2026-10-11 @ (0:30 am)', 'Hold By Hilltown')}${rows}`),
      (html: string) => withRows(html, (rows) => `${row('2026-10-11 09:00', 'Hold By Hilltown')}${rows}`),
      (html: string) => withRows(html, (rows) => `${row('2026-10-11 @ (9:00 am)', '')}${rows}`),
      (html: string) => withRows(html, (rows) => `<tr><td>2026-10-11 @ (9:00 am)</td></tr>${rows}`),
      (html: string) => withRows(html, (rows) => `${rows}${row('2026-10-11 @ (9:00 am)', 'Hold By Hilltown').repeat(501)}`),
    ]) {
      expect(() => parseDomex(change(fixture('in-transit')), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['', '<html><body>Domex</body></html>', fixture('not-found').replace('Record Not Found!', 'Server busy')]) {
      expect(() => parseDomex(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply('<html><title>404 Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://domex.lk/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>Order Details - Domex</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known waybill and the page’s notice, and asks nothing for a number Domex does not issue', async () => {
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T06:35:00.000Z' });
    await expect(carrier(page('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another parcel is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('00000')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Domex does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '00000', '0000000000000', 'ABCD000000001', 'EC', '000000001EC', '00000000/1', `${DELIVERED},${UNKNOWN}`, `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of ['000 000 001', '000-000-001', ' 000000001 ']) expect(normalizeDomexNumber(raw), raw).toBe(DELIVERED);
    expect(normalizeDomexNumber('ec000000002')).toBe(IN_TRANSIT);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
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

  it('routes a number the caller names Domex’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'domex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'domex', source: 'domex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === domexTrackingUrl(DELIVERED))).toBe(true);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toEqual({ mode: 'automatic', adapter: 'domex', steps: ['direct', 'retry'], recognition: { rank: 643 } });
  });
});

describe('Domex numbers', () => {
  it('leaves digit runs to the caller’s choice, and reads tracker links', () => {
    // Many carriers print these shapes, so neither detection nor recognition offers Domex.
    for (const number of [DELIVERED, UNKNOWN, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).carrier).not.toBe('domex');
      expect(recognitionAskedCarriers(number)).not.toContain('domex');
    }
    for (const link of [`https://domex.lk/Order-Details.php?wbno=${DELIVERED}`, `https://www.domex.lk/tracking.php?wbno=${IN_TRANSIT}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ carrier: 'domex', source: 'link' });
    }
  });
});

describe('Domex status vocabulary', () => {
  it('records every line the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(domexStage(entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
    }
    expect(statusMapAnswer({ carrier: 'domex', providerCode: null, description: 'Out For Delivery' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'domex', providerCode: null, description: 'Complete By HO - FINANCE' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'domex', providerCode: null, description: 'Sample Status' })).toEqual({ kind: 'unknown' });
    // Who recorded a line does not change it.
    expect(domexStage('Hold By Hilltown')).toEqual({ stage: 'exception', source: 'carrier_map' });
    // A line the map does not know falls to the shared rules, else stays without a stage.
    expect(domexStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(domexStage('Sample Status')).toBeNull();
  });
});

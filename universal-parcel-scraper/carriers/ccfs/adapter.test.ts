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
import { adapter, CCFS_ENDPOINT, ccfsLookupUrl, CcfsTracker } from './adapter.js';
import { ccfsNotFoundNumber, normalizeCcfsNumber, parseCcfs } from './parser.js';
import { ccfsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '555000111222';
const DELIVERED_BILL = 'K0000042';
const IN_TRANSIT = '555000333444';
const UNKNOWN = '555000999888';

type Row = Record<string, unknown>;
type Shipment = Row & { Locations: Row[] | null; Progress: Record<string, boolean> | null };
type Search = Row & { List: Shipment[] };

const fixture = <T>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const search = (name: string, change: (shipment: Shipment, body: Search) => void = () => {}) => {
  const body = fixture<Search>(name);
  change(body.List[0]!, body);
  return { status: 200, body };
};
const unknown = () => ({ status: 404, body: fixture<unknown>('not-found') });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const shipment = (name: string) => answering(() => reply(fixture(name)));
const missing = () => answering(() => reply(fixture('not-found'), { status: 404 }));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of a reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parseCcfs>) => result.events!.map((event) => [event.local_time, event.description,
  event.stage ?? null, event.location ?? null]);

describe('CCFS HTTP adapter', () => {
  it('asks the shipment page’s lookup for the whole number, through the supplied transport', async () => {
    const fetcher = shipment('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CcfsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 5550-0033-3444 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CCFS_ENDPOINT}?TrackingNum=${IN_TRANSIT}&TrackingNum=${IN_TRANSIT}&Descending=false`);
    expect(ccfsLookupUrl('k0000042')).toBe(`${CCFS_ENDPOINT}?TrackingNum=${DELIVERED_BILL}&TrackingNum=${DELIVERED_BILL}&Descending=false`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ccfs', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history newest first as wall clocks, at towns, without the parties, the signer or the receipt', () => {
    const result = parseCcfs(search('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery completed', last_update: null, last_update_local: '2026-03-12T21:48:09', expected_delivery: null,
    });
    for (const field of ['summary_only', 'delivered_at', 'canonical_tracking_number', 'receiver_name', 'sender_name']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-03-12T21:48:09', 'Delivery completed', 'delivered', 'Example Falls, MT'],
      ['2026-03-12T10:31:07', 'Departed from consignee', null, 'Example Falls, MT'],
      ['2026-03-12T10:12:00', 'Driver arrived at consignee', 'out_for_delivery', 'Example Falls, MT'],
      ['2026-03-11T19:30:22', 'Delivery appointment made', null, 'Example Falls, MT'],
      ['2026-03-11T07:05:51', 'Scanned on dock', 'in_transit', 'Example Falls, MT'],
      // The ZIP code a row's place carries is left out.
      ['2026-03-11T06:40:12', 'Linehaul arrival', 'in_transit', 'Example Falls, MT'],
      ['2026-03-10T02:15:00', 'Linehaul departure', 'in_transit', 'Sampleton, ND'],
      // The repeated row is kept once.
      ['2026-03-09T17:20:05', 'Scanned on dock', 'in_transit', 'Sampleton, ND'],
      ['2026-03-09T15:02:44', 'Pickup completed', 'accepted', 'Sampleton, ND'],
      ['2026-03-09T09:41:18', 'Bill of lading scanned', 'registered', 'Sampleton, ND'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source !== 'none')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLETON|EXAMPLE FALLS|Pat Example|Jordan|dock door|58000|59000|POD|11112222|Billing complete/);
  });

  it('reads the freight bill number as the same shipment, headed by its pro number', () => {
    expect(parseCcfs(search('delivered'), 'k000 0042')).toMatchObject({ current_stage: 'delivered', canonical_tracking_number: DELIVERED });
  });

  it('reads an in-transit history, its newest staged row, and the delivery window’s day', () => {
    const result = parseCcfs(search('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      // The delay notice is the newest row and moves nothing.
      last_status_text: 'Shipment running late', last_update: null, last_update_local: '2026-10-14T20:44:28',
      expected_delivery: '2026-10-16',
    });
    expect(events(result)).toEqual([
      ['2026-10-14T20:44:28', 'Shipment running late', null, 'Sample Junction, CO'],
      ['2026-10-14T14:15:20', 'Scanned on dock', 'in_transit', 'Sample Junction, CO'],
      ['2026-10-14T14:13:41', 'Scanned on dock', 'in_transit', 'Sample Junction, CO'],
      ['2026-10-13T16:02:13', 'Bill of lading scanned', 'registered', 'Sample River, MN'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RIVER|EXAMPLE PEAK|55000|80000|Freight on dock/);
    // A reply that lists its rows newest first is kept in its order.
    const descending = parseCcfs(search('in-transit', (item, body) => { item.Locations!.reverse(); body.Descending = true; }), IN_TRANSIT);
    expect(events(descending)).toEqual(events(result));
  });

  it('takes the further of the newest staged row and the progress rail, and lets a delivery or a problem settle it', () => {
    // The rail ahead of every row is the current state, without a clock.
    const out = parseCcfs(search('in-transit', (item) => { item.Progress!.OutForDelivery = true; }), IN_TRANSIT);
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Out for Delivery', expected_delivery: '2026-10-16' });
    expect(out).not.toHaveProperty('last_update_local');
    // The rail settles a delivery the history does not record.
    const delivered = parseCcfs(search('delivered', (item) => { item.Locations!.pop(); }), DELIVERED);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', expected_delivery: null });
    expect(delivered).not.toHaveProperty('last_update_local');
    expect(delivered.events![0]).toMatchObject({ description: 'Departed from consignee' });
    // A delivery row settles it without the rail.
    expect(parseCcfs(search('delivered', (item) => { item.Progress = null; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivery completed' });
    // A problem in the newest staged row outranks the rail's step.
    const refused = parseCcfs(search('in-transit', (item) => {
      item.Locations!.push({ Date: '2026-10-15T11:02:00', Status: 'Refused by consignee', Location: 'Example Peak, CO' },
        { Date: '2026-10-15T11:30:00.120', Status: 'Refusal notification sent', Location: 'Sample Junction, CO' });
    }), IN_TRANSIT);
    expect(refused).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Refusal notification sent',
      last_update_local: '2026-10-15T11:30:00' });
    // A rail step behind the newest staged row does not step it back.
    expect(parseCcfs(search('in-transit', (item) => { item.Progress = { PickupRequested: true }; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit', last_status_text: 'Shipment running late' });
  });

  it('reads a shipment without a history as a summary from the rail, else its status', () => {
    const transit = parseCcfs(search('in-transit', (item) => { item.Locations = []; }), IN_TRANSIT);
    expect(transit).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit', last_update: null, expected_delivery: '2026-10-16', summary_only: true, events: [] });
    const status = parseCcfs(search('in-transit', (item) => { item.Locations = null; item.Progress = null; }), IN_TRANSIT);
    expect(status).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Freight on dock', summary_only: true });
    const other = parseCcfs(search('in-transit', (item) => { item.Locations = null; item.Progress = null; item.Status = 'Sample Note'; }), IN_TRANSIT);
    expect(other).toMatchObject({ status: 'unknown', last_status_text: 'Sample Note' });
    expect(other).not.toHaveProperty('current_stage');
    expect(() => parseCcfs(search('in-transit', (item) => { item.Locations = []; item.Progress = null; item.Status = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('places a row at its town and state, without a ZIP code or anything holding a digit', () => {
    const at = (location: unknown) => parseCcfs(search('in-transit', (item) => { item.Locations![1]!.Location = location; }), IN_TRANSIT)
      .events![2]!.location ?? null;
    expect(at('Sample Junction, CO 80000-1234')).toBe('Sample Junction, CO');
    expect(at('12 Sample St, Sample Junction, CO')).toBeNull();
    expect(at('')).toBeNull();
    expect(at(null)).toBeNull();
  });

  it('reads the unknown number’s answer as not found, and a shipment only when it carries the number asked', () => {
    expect(() => parseCcfs(unknown(), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(ccfsNotFoundNumber(fixture('not-found'))).toBe(UNKNOWN);
    expect(ccfsNotFoundNumber({ Message: 'No HTTP resource was found that matches the request URI.' })).toBeNull();
    expect(ccfsNotFoundNumber('<html></html>')).toBeNull();
    // An answer for another number is no answer.
    expect(() => parseCcfs(unknown(), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CCFS answered for another number' }));
    expect(() => parseCcfs({ status: 404, body: { Message: 'Not Found' } }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'transport' }));
    // The lookup also matches references: a shipment that carries the number only there is another one.
    for (const change of [
      (item: Shipment) => { item.ProNum = '555000333445'; item.BillNum = 'K0000078'; },
      (item: Shipment) => { item.ProNum = null; item.BillNum = null; },
      (item: Shipment) => { item.ProNum = ` ${IN_TRANSIT}0`; },
    ]) {
      expect(() => parseCcfs(search('in-transit', (item) => { change(item); item.BillNum ??= null; }), IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CCFS answered for another shipment' }));
    }
    expect(() => parseCcfs(search('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The shipment asked is picked out of a search that also found others by their references.
    const other = fixture<Search>('delivered').List[0]!;
    expect(parseCcfs(search('in-transit', (_item, body) => { body.List.unshift(other); }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit', last_status_text: 'Shipment running late' });
    expect(() => parseCcfs(search('in-transit', (item, body) => { body.List.push({ ...item, ConsignmentId: 1 }); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CCFS answered with several shipments for the number' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (item: Shipment) => { item.ProNum = 555000333444; },
      (item: Shipment) => { item.Status = 7; },
      (item: Shipment) => { item.Locations = {} as never; },
      (item: Shipment) => { item.Progress = 'In Transit' as never; },
      (item: Shipment) => { (item.Progress as Row).InTransit = 'yes'; },
      (item: Shipment) => { item.ExpectedAfter = '10/16/2026'; },
      (item: Shipment) => { item.Locations![0]!.Status = null; },
      (item: Shipment) => { item.Locations![0]!.Status = ['Scanned on dock']; },
      (item: Shipment) => { item.Locations![0]!.Date = null; },
      (item: Shipment) => { item.Locations![0]!.Date = '2026-10-13T24:00:00'; },
      (item: Shipment) => { item.Locations![0]!.Date = '2026-02-30T06:00:00'; },
      (item: Shipment) => { item.Locations![0]!.Date = '2026-10-13T16:02:13Z'; },
      (item: Shipment) => { item.Locations![0]!.Date = '2026-10-13T16:02:13-05:00'; },
      (item: Shipment) => { item.Locations![0]!.Location = { City: 'Sample' }; },
      (item: Shipment) => { item.Locations![0] = 'row' as never; },
      (item: Shipment) => { item.Locations!.push(...Array.from({ length: 500 }, () => item.Locations![1]!)); },
    ]) {
      expect(() => parseCcfs(search('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], {}, { List: null }, { List: [] }, { List: ['shipment'] }, { Message: 'An error has occurred.' }]) {
      expect(() => parseCcfs({ status: 200, body }, IN_TRANSIT), JSON.stringify(body)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(missing()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const html = { headers: { 'Content-Type': 'text/html' } };
    await expect(lookup(() => reply('<html><title>404</title></html>', { status: 404, ...html }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply({ Message: 'No HTTP resource was found that matches the request URI.' }, { status: 404 })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://legacy.ccfs.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403, ...html }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, html))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, { status: 404, ...html }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>CrossCountry Freight Solutions</title></html>', html))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply({ Message: 'An error has occurred.' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = answering(() => reply({ Message: 'An error has occurred.' }, { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown answer, and asks nothing for a number CCFS does not issue', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(shipment('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T21:48:09' });
    await expect(carrier(shipment('delivered')).recognize!(DELIVERED_BILL)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T21:48:09' });
    await expect(carrier(missing()).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }))).recognize!(UNKNOWN))
      .rejects.toMatchObject({ kind: 'challenge' });
    // A reply for another shipment is no answer either way.
    await expect(carrier(shipment('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('55500011122')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers CCFS does not issue, references and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '55500011122', '5550001112223', 'K000004', 'K00000420', 'KK0000042', '0000042K', 'PO-55500',
      '55500011122A', `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [raw, number] of [['5550 0011 1222', DELIVERED], ['5550-0011-1222', DELIVERED], ['k0000042', DELIVERED_BILL]]) {
      expect(normalizeCcfsNumber(raw!), raw).toBe(number);
    }
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

  it('routes a number the caller names CCFS’s to the adapter', async () => {
    const fetcher = shipment('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ccfs' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ccfs', source: 'ccfs', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === ccfsLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('CCFS numbers', () => {
  it('leaves pro and freight bill numbers to the caller’s choice, and reads tracker links', () => {
    // Both shapes are shared with other carriers, so neither detection nor recognition offers CCFS.
    for (const number of [DELIVERED, DELIVERED_BILL]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('ccfs');
      expect(recognitionAskedCarriers(number), number).not.toContain('ccfs');
    }
    for (const [link, number] of [[`https://auth.ccfs.com/track/detail/${DELIVERED}`, DELIVERED],
      [`https://auth.ccfs.com/track/detail/${DELIVERED_BILL}/`, DELIVERED_BILL],
      // The search page opens a shipment it picked out of several with its id after the number.
      [`https://auth.ccfs.com/track/detail/${DELIVERED}-11112222`, DELIVERED]]) {
      expect(parseTrackingInput(link!), link).toMatchObject({ trackingNumber: number, carrier: 'ccfs', source: 'link' });
    }
  });
});

describe('CCFS status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, and the wording it leaves out', () => {
    const gaps = new Set(statusMap.gaps.map((gap) => gap.wording));
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(ccfsStage(entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
      // Every published wording either has a stage or is left out on purpose.
      expect(Boolean(entry.stage) !== gaps.has(wording), entry.wording).toBe(true);
    }
    expect(statusMapAnswer({ carrier: 'ccfs', providerCode: null, description: 'Scanned on dock' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'ccfs', providerCode: null, description: 'Sample Note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared rules, else stays without a stage.
    expect(ccfsStage('Out for delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(ccfsStage('Sample Note')).toBeNull();
  });
});

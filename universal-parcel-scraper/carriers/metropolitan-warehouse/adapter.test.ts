import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, METROPOLITAN_WAREHOUSE_CHECK, METROPOLITAN_WAREHOUSE_LINK, MetropolitanWarehouseTracker } from './adapter.js';
import {
  metropolitanWarehouseDetailsPath, metropolitanWarehouseKnows, normalizeMetropolitanWarehouseNumber, parseMetropolitanWarehouse,
} from './parser.js';
import { metropolitanWarehouseStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = '500000000013';
const DELIVERED = '500000000021';
const UNKNOWN = '500000000099';
const PATH = '/Client/GetWixOrderTrackingDetails?eqs=SyntheticKey%2Fabc123';
const DETAILS = `https://main.gomwd.com${PATH}`;
const CHALLENGE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

type Row = Record<string, unknown>;

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const HISTORY = /(var historyTrans = )(\[.*\]);/;
// The order's page, with its history rows or its markup changed.
const page = (name: 'in-transit' | 'delivered', rows: (rows: Row[]) => unknown = (same) => same, html: (html: string) => string = (same) => same) =>
  html(read(`${name}.html`).replace(HISTORY, (_, head: string, list: string) => `${head}${JSON.stringify(rows(JSON.parse(list) as Row[]))};`));
const reply = (body: string, init: ResponseInit = {}) => new Response(body, init);
const json = (body: unknown) => reply(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const html = (body: string, status = 200) => reply(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The check's answer, the link's and the order's page, for one lookup.
const replies = (...bodies: Response[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const body of bodies) fetcher.mockResolvedValueOnce(body);
  return fetcher;
};
const found = (name: 'in-transit' | 'delivered', body = page(name)) => replies(json(read('known.json')), html(PATH), html(body));

describe('Metropolitan Warehouse HTTP adapter', () => {
  it('checks the number, asks for the order’s link and opens the order’s page as the tracker does, through the supplied transport', async () => {
    const fetcher = found('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MetropolitanWarehouseTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 5000 0000 0013 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${METROPOLITAN_WAREHOUSE_CHECK}?trackid=${IN_TRANSIT}`, `${METROPOLITAN_WAREHOUSE_LINK}?trackingid=${IN_TRANSIT}`, DETAILS,
    ]);
    for (const [, init] of fetcher.mock.calls as [string, RequestInit][]) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(init.body).toBeUndefined();
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'metropolitan-warehouse', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an order at the hub with wall clocks, its service and its weight', () => {
    const transit = parseMetropolitanWarehouse(page('in-transit'), IN_TRANSIT);
    expect(transit).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Furniture Received by Metro-Hub', last_update: null, last_update_local: '2026-03-03T01:05:00', expected_delivery: null,
      service_name: 'Room of Choice', weight_kg: 113.398 });
    expect(transit.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.provider_code, event.stage ?? null]))
      .toEqual([
        ['2026-03-03T01:05:00', 'Furniture Received by Metro-Hub', 'Sample Hub, CA', '23', 'in_transit'],
        ['2026-03-03T01:05:00', 'Pickup completed, No exceptions', 'EXAMPLE CITY, CA', '18', 'accepted'],
        ['2026-03-03T01:05:00', 'Pickup scheduled for 03/03/2026', 'EXAMPLE CITY, CA', '10', 'registered'],
        // Paperwork moves nothing.
        ['2026-03-02T04:10:00', 'Pickup document attached', 'EXAMPLE CITY, CA', '92', null],
        ['2026-02-24T15:40:00', 'Order registered', 'EXAMPLE CITY, CA', '1', 'registered'],
      ]);
    expect(transit.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('reads a delivered order: appointments move nothing, a repeated row is kept once and an unknown code takes the wording rules', () => {
    const delivered = parseMetropolitanWarehouse(page('delivered'), DELIVERED);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Completed, No Exceptions', last_update_local: '2026-04-09T11:07:00', service_name: 'Threshold' });
    // A weight of zero is no weight.
    expect(delivered).not.toHaveProperty('weight_kg');
    expect(delivered).not.toHaveProperty('history_truncated');
    expect(delivered.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.provider_code, event.stage ?? null]))
      .toEqual([
        ['2026-04-09T11:07:00', 'Delivery Completed, No Exceptions', 'Sampleville, ZZ', '54', 'delivered'],
        ['2026-04-09T10:43:00', 'Arrived at Delivery Location', 'Sampleville, ZZ', '86', 'out_for_delivery'],
        ['2026-03-30T13:17:00', 'Delivery Scheduled for WEEK OF 04/06/2026', null, '43', null],
        ['2026-03-30T12:56:00', 'Delivery Appointment Canceled', null, '44', null],
        ['2026-03-20T07:48:00', 'Delivery Rescheduled for WEEK OF 03/30/2026', null, '46', null],
        ['2026-03-18T08:10:00', 'Reached Delivery Hub', null, '107', 'in_transit'],
        ['2026-03-18T08:10:00', 'Furniture Received by Metro-Hub', 'Sample Harbor, Georgia', '23', 'in_transit'],
        // A row placed "In Transit" names no place.
        ['2026-03-17T08:17:00', 'Order enroute to Metro-Hub', null, '24', 'in_transit'],
        ['2026-03-16T09:00:00', 'Synthetic hub note', 'Sample Hub, CA', '999', null],
        ['2026-03-16T00:11:00', 'Furniture Received by Metro-Hub', 'Sample Hub, CA', '23', 'in_transit'],
        ['2026-03-15T10:15:00', 'Pickup completed, No exceptions', 'EXAMPLE CITY, CA', '18', 'accepted'],
        ['2026-03-10T13:17:00', 'Pickup scheduled for 03/15/2026', null, '10', 'registered'],
        ['2026-03-08T01:21:00', 'Order registered', null, '1', 'registered'],
      ]);
    // An unknown code with wording the shared rules know gets their stage.
    const worded = parseMetropolitanWarehouse(page('delivered', (rows) => [{ ...rows[8], Event: 'Out for delivery' }, ...rows.slice(9)]), DELIVERED);
    expect(worded).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: expect.stringMatching(/^wording:/) });
    // A history listed oldest first is turned round; a row without a date keeps no clock.
    const reversed = parseMetropolitanWarehouse(page('delivered', (rows) => [...rows].reverse()), DELIVERED);
    expect(reversed.events).toEqual(delivered.events);
    const undated = parseMetropolitanWarehouse(page('in-transit', (rows) => [{ ...rows[0], Date: '' }, ...rows.slice(1)]), IN_TRANSIT);
    expect(undated.events![0]).not.toHaveProperty('local_time');
    expect(undated.last_update_local).toBe('2026-03-03T01:05:00');
    // Only the latest hundred rows are kept.
    const long = parseMetropolitanWarehouse(page('in-transit', (rows) => Array.from({ length: 120 }, (_, index) => ({ ...rows[0],
      Date: `03/${String(28 - Math.floor(index / 5)).padStart(2, '0')}/2026 ${String(12 - (index % 5)).padStart(2, '0')}:00 PM` }))), IN_TRANSIT);
    expect(long).toMatchObject({ history_truncated: true, last_update_local: '2026-03-28T12:00:00' });
    expect(long.events).toHaveLength(100);
  });

  it('keeps the destination, references, order numbers and the page’s key out of the result', async () => {
    for (const [name, number] of [['in-transit', IN_TRANSIT], ['delivered', DELIVERED]] as const) {
      const result = await carrier(found(name)).track({ number });
      expect(JSON.stringify(result)).not.toMatch(/SAMPLEREF|99000\d|\b00000\b|Sampleville ZZ|[78]0000\d\d|\bROC\b|\bTH\b|33 cf|SyntheticKey|eqs/);
    }
  });

  it('reads only the check’s own answer for a number the tracker does not hold as missing', async () => {
    const fetcher = replies(json(read('unknown.json')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(metropolitanWarehouseKnows(read('known.json'))).toBe(true);
    expect(metropolitanWarehouseKnows(read('unknown.json'))).toBe(false);
    expect(metropolitanWarehouseKnows('{"Result":false,"Message":"  Tracking id does not exist. "}')).toBe(false);
    for (const body of ['{"Result":false,"Message":"Error while checking tracking number."}', '{"Result":false,"Message":""}', '{"Result":false}']) {
      expect(() => metropolitanWarehouseKnows(body), body).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
      await expect(carrier(replies(json(body))).track({ number: UNKNOWN }), body).rejects.toMatchObject({ kind: 'indeterminate' });
    }
  });

  it('reads the order’s page failing for a number the check holds as inconclusive', async () => {
    await expect(carrier(replies(json(read('known.json')), html(PATH), html('<html><title>Error</title></html>', 500))).track({ number: IN_TRANSIT }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    // A page without rows is an order without history yet.
    await expect(carrier(found('in-transit', page('in-transit', () => []))).track({ number: IN_TRANSIT }))
      .rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  });

  it('counts the page only when it shows the whole number asked', () => {
    expect(() => parseMetropolitanWarehouse(page('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Metropolitan Warehouse answered for another order' }));
    expect(() => parseMetropolitanWarehouse(page('in-transit', undefined, (body) => body.replace(`'${IN_TRANSIT}'`, `'${IN_TRANSIT.slice(1)}'`)), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMetropolitanWarehouse(page('in-transit', undefined, (body) => body.replace(/var TrackingId = '\d+';/, '')), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the link as text or as a JSON string, and nothing else', () => {
    expect(metropolitanWarehouseDetailsPath(`${PATH}\n`)).toBe(PATH);
    expect(metropolitanWarehouseDetailsPath(JSON.stringify(PATH))).toBe(PATH);
    for (const body of ['', `https://main.gomwd.com${PATH}`, '/Client/GetWixOrderTrackingDetails?eqs=', '/Client/Other?eqs=SyntheticKey1',
      `${PATH}&next=//example.com`, '"unterminated', '<html><title>Track a shipment</title></html>']) {
      expect(() => metropolitanWarehouseDetailsPath(body), body).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => metropolitanWarehouseDetailsPath(CHALLENGE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects a changed page', () => {
    const changes: ((rows: Row[]) => unknown)[] = [
      () => ({ rows: [] }),
      (rows) => ['row', ...rows],
      (rows) => [{ ...rows[0], EventID: '23' }],
      (rows) => [{ ...rows[0], EventID: -1 }],
      (rows) => { const row = { ...rows[0] }; delete row.EventID; return [row]; },
      (rows) => [{ ...rows[0], Event: '' }],
      (rows) => [{ ...rows[0], Event: 23 }],
      (rows) => [{ ...rows[0], Date: '2026-03-03 01:05' }],
      (rows) => [{ ...rows[0], Date: '02/30/2026 01:05 AM' }],
      (rows) => [{ ...rows[0], Date: '03/03/2026 13:05 PM' }],
      (rows) => [{ ...rows[0], Location: ['Sample Hub'] }],
      (rows) => Array.from({ length: 501 }, () => rows[0]),
    ];
    for (const change of changes) {
      expect(() => parseMetropolitanWarehouse(page('in-transit', change), IN_TRANSIT), String(change)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (body: string) => body.replace(HISTORY, ''),
      (body: string) => body.replace(HISTORY, 'var historyTrans = [{"Event":"Order registered"'),
      (body: string) => body.replace(HISTORY, 'var historyTrans = [{Event:1}];'),
    ]) {
      expect(() => parseMetropolitanWarehouse(page('in-transit', undefined, change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a missing order, a moved tracker, a browser check and a broken reply apart', async () => {
    const check = (response: Response) => carrier(replies(response)).track({ number: UNKNOWN });
    await expect(check(reply('', { status: 302, headers: { Location: 'https://www.gomwd.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(check(html('<html><body>Not Found</body></html>', 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(check(html('', 410))).rejects.toMatchObject({ kind: 'transport' });
    await expect(check(html(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(check(html('<html><title>Track a shipment</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(check(json('{"Result":"true","Message":""}'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(check(json('[]'))).rejects.toMatchObject({ kind: 'schema' });
    // The link and the page can be refused, moved or broken too.
    const known = () => json(read('known.json'));
    await expect(carrier(replies(known(), html(CHALLENGE))).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(replies(known(), html('', 404))).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(found('in-transit', CHALLENGE)).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(replies(known(), html(PATH), reply('', { status: 302, headers: { Location: '/Client/Login' } }))).track({ number: IN_TRANSIT }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(found('in-transit', '<html><title>Order Tracking</title></html>')).track({ number: IN_TRANSIT }))
      .rejects.toMatchObject({ kind: 'schema' });
    const large = replies(known(), html(PATH), html('x'.repeat(600_000)));
    await expect(carrier(large).track({ number: IN_TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html('', status));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a lookup that failed to reach Metropolitan once more, from the check', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(read('known.json'))).mockResolvedValueOnce(html(PATH)).mockResolvedValueOnce(html(page('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const second = vi.fn<typeof fetch>().mockResolvedValueOnce(json(read('known.json'))).mockResolvedValueOnce(html(PATH))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(read('known.json'))).mockResolvedValueOnce(html(PATH)).mockResolvedValueOnce(html(page('delivered')));
    await expect(carrier(second).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(second).toHaveBeenCalledTimes(6);
    await expect(carrier(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))).track({ number: DELIVERED }, { budgetMs: 2000 }))
      .rejects.toBeInstanceOf(UpstreamNetworkError);
  });

  it('rejects numbers Metropolitan does not issue and pre-aborted lookups without a request', async () => {
    expect(normalizeMetropolitanWarehouseNumber(' 5000-0000-0013 ')).toBe(IN_TRANSIT);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['50000000001', '5000000000130', 'TRX500000000', 'SAMPLETRACKING', '', '5'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a number the tracker holds from its check alone', async () => {
    const fetcher = replies(json(read('known.json')), json(read('unknown.json')));
    // The check carries no date.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${METROPOLITAN_WAREHOUSE_CHECK}?trackid=${IN_TRANSIT}`, `${METROPOLITAN_WAREHOUSE_CHECK}?trackid=${UNKNOWN}`,
    ]);
    await expect(carrier(replies(json('{"Result":false,"Message":"Error while checking tracking number."}'))).recognize!(UNKNOWN))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(replies(html(CHALLENGE))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(replies(html('<html></html>'))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'schema' });
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(read('known.json')));
    await expect(carrier(flaky).recognize!(IN_TRANSIT, { budgetMs: 2000 })).resolves.toEqual({ known: true, lastActivityAt: null });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under Metropolitan to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(METROPOLITAN_WAREHOUSE_CHECK)
      ? json(read('known.json')) : String(url).startsWith(METROPOLITAN_WAREHOUSE_LINK) ? html(PATH) : html(page('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'metropolitan-warehouse' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'metropolitan-warehouse', source: 'metropolitan-warehouse', result: { current_stage: 'delivered' } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('Metropolitan Warehouse status vocabulary', () => {
  it('records every event code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const wording = entry.wording.replace('{date}', '04/06/2026');
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, wording.toLowerCase()), entry.code).toBeUndefined();
        expect(metropolitanWarehouseStage(entry.code, wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'metropolitan-warehouse', providerCode: entry.code, description: wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(metropolitanWarehouseStage(entry.code, wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'metropolitan-warehouse', providerCode: entry.code, description: wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'metropolitan-warehouse', providerCode: '999', description: 'Synthetic hub note' })).toEqual({ kind: 'unknown' });
    expect(metropolitanWarehouseStage('999', 'Synthetic hub note')).toBeNull();
  });
});

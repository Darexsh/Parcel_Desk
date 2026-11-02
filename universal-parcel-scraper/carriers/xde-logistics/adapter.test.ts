import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, XDE_LOGISTICS_API, XdeLogisticsTracker } from './adapter.js';
import { isXdeLogisticsNotFound, normalizeXdeLogisticsNumber, parseXdeLogistics, xdeLogisticsLocation } from './parser.js';
import { statusMap, xdeLogisticsStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'X0000000001';
const IN_TRANSIT = 'XSO000000000002';
const UNKNOWN = 'X0000000000';

type Row = Record<string, unknown>;
type Reply = Row & { history: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The site's page for a route it does not have.
const MISSING_ROUTE = '<html><head><title>Page Not Found</title></head><body><h1>Page Not Found</h1></body></html>';

describe('XDE Logistics HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new XdeLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' xso 0000-0000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${XDE_LOGISTICS_API}${IN_TRANSIT}/history`);
    expect(String(url)).toBe('https://xdelogistics.com/api/v2/client/public/services/shipment/XSO000000000002/history');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xde-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates each scan on Manila’s clock, newest first, and keeps the delivery without the people the reply names', () => {
    const result = parseXdeLogistics(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery successful', last_update: '2026-03-12T14:05:41+08:00', delivered_at: '2026-03-12T14:05:41+08:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.description, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-12T14:05:41+08:00', 'Delivery successful', 'delivered', null],
      ['2026-03-12T09:30:02+08:00', 'First delivery attempt', 'out_for_delivery', null],
      // The row without a status is left out, as the page does, and the repeated hub scan is kept once.
      ['2026-03-11T20:12:17+08:00', 'Received at hub', 'in_transit', 'Sample Main Warehouse'],
      ['2026-03-11T17:48:33+08:00', 'Picked at warehouse', 'accepted', null],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Consignee|Receiver|City|Province)|00000000-|delivered successfully|sorting/);
  });

  it('keeps a parcel waiting at a hub in transit, without the seller a pickup names', () => {
    const result = parseXdeLogistics(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Received at hub', last_update: '2026-05-04T07:41:09+08:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.description, event.location ?? null])).toEqual([
      ['Received at hub', 'Sample South Hub'],
      ['Picked at warehouse', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Seller|Town|Province)/);
  });

  it('takes the current status’s word for a delivery whose scan is missing, and sorts a history listed oldest first', () => {
    const summary = parseXdeLogistics(changed('delivered', (body) => { body.history.shift(); }), DELIVERED);
    expect(summary).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'First delivery attempt' });
    expect(summary).not.toHaveProperty('delivered_at');
    const reversed = parseXdeLogistics(changed('delivered', (body) => { body.history.reverse(); }), DELIVERED);
    expect(reversed.events!.map((event) => event.description)).toEqual(['Delivery successful', 'First delivery attempt', 'Received at hub', 'Picked at warehouse']);
    // A current status that is not an ending leaves the newest scan's stage.
    expect(parseXdeLogistics(changed('in-transit', (body) => { body.current_status = 'Picked at warehouse'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
    // A status the map does not know falls to the shared wording rules.
    const unmapped = parseXdeLogistics(changed('in-transit', (body) => { body.history[0]!.status = 'Synthetic note'; }), IN_TRANSIT);
    expect(unmapped.events![0]).not.toHaveProperty('stage');
    expect(unmapped).toMatchObject({ current_stage: 'accepted', last_status_text: 'Synthetic note' });
  });

  it('keeps scans of one second in the reply’s order, reversed when it lists them oldest first', () => {
    const tied = parseXdeLogistics(changed('delivered', (body) => {
      body.history[1]!.created_at = body.history[0]!.created_at;
      body.history.reverse();
    }), DELIVERED);
    expect(tied.events!.map((event) => event.description)).toEqual(['Delivery successful', 'First delivery attempt', 'Received at hub', 'Picked at warehouse']);
  });

  it('keeps a hub receipt’s facility as the location, and no other scan’s reference', () => {
    expect(xdeLogisticsLocation('Received at hub', ' Sample North Hub ')).toBe('Sample North Hub');
    expect(xdeLogisticsLocation('Arrived at warehouse', 'Sample Warehouse, 0000 000 0001')).toBe('Sample Warehouse');
    expect(xdeLogisticsLocation('Received at hub', '000000')).toBe('');
    expect(xdeLogisticsLocation('Delivery successful', 'Sample Person')).toBe('');
    expect(xdeLogisticsLocation('Picked at warehouse', 'Sample Seller')).toBe('');
    expect(xdeLogisticsLocation('Received by consignee', 'Sample Person')).toBe('');
  });

  it('reads a shipment without scans as a summary of its current status, and one without either as no history', () => {
    expect(parseXdeLogistics(changed('in-transit', (body) => { body.history = []; }), IN_TRANSIT)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Received at hub',
      last_update: null, expected_delivery: null, summary_only: true, events: [],
    });
    expect(() => parseXdeLogistics(changed('in-transit', (body) => { body.history = []; body.current_status = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseXdeLogistics(changed('in-transit', (body) => { delete (body as Row).history; body.current_status = false; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseXdeLogistics(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'XDE Logistics answered for another shipment' }));
    expect(parseXdeLogistics(changed('in-transit', (body) => { body.tracking_number = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(2);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.tracking_number; },
      (body: Reply) => { body.tracking_number = 0; },
      (body: Reply) => { body.history = 'history' as never; },
      (body: Reply) => { body.history = Array.from({ length: 501 }, () => body.history[0]!); },
      (body: Reply) => { body.history[0] = 'scan' as never; },
      (body: Reply) => { body.history[0]!.status = ['Received at hub']; },
      (body: Reply) => { body.history[0]!.created_at = '04/05/2026 07:41'; },
      (body: Reply) => { body.history[0]!.created_at = '2026-05-04T07:41:09+08:00'; },
      (body: Reply) => { body.history[0]!.created_at = '2026-05-04 24:00:00'; },
      (body: Reply) => { body.history[0]!.created_at = '2026-02-30 07:41:09'; },
      (body: Reply) => { delete body.history[0]!.created_at; },
      (body: Reply) => { body.history[0]!.reference = { name: 'Sample South Hub' }; },
      (body: Reply) => { body.current_status = 7; },
    ]) {
      expect(() => parseXdeLogistics(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseXdeLogistics([fixture('in-transit')], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    expect(isXdeLogisticsNotFound(fixture('not-found'))).toBe(true);
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // The not-found body without its 404 is not the page's not-found answer.
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ code: 404, message: 'Route moved' }, { status: 404 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(MISSING_ROUTE, { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.xde.com.ph/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><div class="cf-turnstile"></div></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>XDE Logistics</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that fails to reach XDE once more within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers XDE does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['X0000', 'SAMPLETRACKING', `X${'0'.repeat(40)}`, 'X000/000000']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeXdeLogisticsNumber('x 000-000-0001')).toBe(DELIVERED);
    expect(carrier(fetcher)).not.toHaveProperty('recognize');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('routes a number filed under XDE Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'xde-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'xde-logistics', source: 'xde-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${XDE_LOGISTICS_API}${DELIVERED}/history`)).toBe(true);
  });
});

describe('XDE Logistics status vocabulary', () => {
  it('records every status name the current lookup gave with the stage the map gives it', () => {
    const current = (statuses.entries as { wording: string; stage: string; confirmedBy: string }[]).filter((entry) => entry.confirmedBy === 'live');
    expect(current.length).toBeGreaterThan(0);
    for (const entry of current) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(xdeLogisticsStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'xde-logistics', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'xde-logistics', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(xdeLogisticsStage('Synthetic note')).toBeNull();
  });
});

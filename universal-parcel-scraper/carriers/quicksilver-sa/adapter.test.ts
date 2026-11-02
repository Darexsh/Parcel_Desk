import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, QUICKSILVER_HISTORY_API, QuicksilverTracker, quicksilverLookupUrl } from './adapter.js';
import { normalizeQuicksilverNumber, parseQuicksilver, quicksilverWording } from './parser.js';
import { quicksilverMappedStage, quicksilverStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'QS000000001';
const IN_TRANSIT = 'QS000000002';
const UNKNOWN = 'QS000000009';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Quicksilver HTTP adapter', () => {
  it('asks the tracking page\'s history lookup with its token, as the page does', async () => {
    const fetcher = replying(() => json(fixture('in-transit.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new QuicksilverTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' qs 000-000-002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${QUICKSILVER_HISTORY_API}?tracking_number=${IN_TRANSIT}`);
    expect(url).toBe(quicksilverLookupUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer \S{20,}$/);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'quicksilver-sa', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered history newest first by clock, once per status, without the photo or the driver\'s number', () => {
    const result = parseQuicksilver(fixture('delivered.json'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-02-11T21:14:05', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2026-02-11T21:14:05', description: 'Delivered', provider_code: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-02-11T18:40:22', description: 'Out For Delivery', provider_code: 'Out For Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-02-11T18:40:21', description: 'Ready For Dispatch', provider_code: 'Ready For Dispatch', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-02-10T22:03:17', description: 'Ready For Dispatch', provider_code: 'Ready For Dispatch', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-02-10T20:51:40', description: 'Received', provider_code: 'Received', stage: 'accepted', stage_source: 'carrier_map' },
      { local_time: '2026-02-09T16:30:12', description: 'Pending Creation', provider_code: 'Pending Creation', stage: 'registered', stage_source: 'carrier_map' },
      { local_time: '2026-02-09T15:12:48', location: 'Sample Collection Station', description: 'Allocating pickers: Pick up task assigned to DA.',
        provider_code: 'Allocating pickers', stage: 'registered', stage_source: 'carrier_map' },
      { local_time: '2026-02-09T15:02:31', description: 'Place an order', provider_code: 'Place an order', stage: 'registered', stage_source: 'carrier_map' },
      { local_time: '2026-02-09T10:25:09', description: 'Picked', provider_code: 'Picked' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/media\.example|SAMPLE-PROOF|\+0{12}|driver/);
  });

  it('reads an in-transit history and puts out-of-order statuses in clock order', () => {
    expect(parseQuicksilver(fixture('in-transit.json'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Ready For Dispatch', last_update_local: '2026-04-02T19:45:10' });
    const payload = fixture('in-transit.json');
    const history = payload.history as Record<string, unknown>[];
    payload.history = [history[4], history[0], history[2], history[1], history[3]];
    expect(parseQuicksilver(payload, IN_TRANSIT).events!.map((event) => event.provider_code))
      .toEqual(['Ready For Dispatch', 'Received', 'Pending Creation', 'Allocating pickers', 'Place an order']);
  });

  it('leaves an unknown status to the shared wording rules, or without a stage', () => {
    const payload = fixture('in-transit.json');
    payload.history = [{ status: 'Sample Status', reason: null, proof_url: null, updated_at: '2026-04-03 08:00:00' }, ...(payload.history as unknown[])];
    const result = parseQuicksilver(payload, IN_TRANSIT);
    expect(result.events![0]).toEqual({ local_time: '2026-04-03T08:00:00', description: 'Sample Status', provider_code: 'Sample Status' });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample Status' });
  });

  it('words a status with its reason, takes the station as the place and drops phone numbers and a delivery\'s reason', () => {
    expect(quicksilverWording('Allocating pickers', '【Sample Station】Pick up task assigned to DA.'))
      .toEqual({ description: 'Allocating pickers: Pick up task assigned to DA.', location: 'Sample Station' });
    expect(quicksilverWording('Sample Attempt', 'Customer unreachable at +000 00 000 0000.'))
      .toEqual({ description: 'Sample Attempt: Customer unreachable at.', location: '' });
    expect(quicksilverWording('Delivered', 'Handed to Sample Person')).toEqual({ description: 'Delivered', location: '' });
    expect(quicksilverWording('Received', 'received')).toEqual({ description: 'Received', location: '' });
  });

  it('reads the service\'s "Shipment not found" as a missing parcel', async () => {
    expect(() => parseQuicksilver(fixture('not-found.json'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => json(fixture('not-found.json'), { status: 404 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps only a reply that names the whole number asked', () => {
    expect(() => parseQuicksilver(fixture('delivered.json'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Quicksilver answered for another shipment' }));
    expect(() => parseQuicksilver({ ...fixture('delivered.json'), tracking_number: `${DELIVERED}0` }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Quicksilver answered for another shipment' }));
    expect(() => parseQuicksilver({ ...fixture('delivered.json'), tracking_number: undefined }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Quicksilver returned a shipment without its number' }));
    expect(parseQuicksilver({ ...fixture('delivered.json'), tracking_number: DELIVERED.toLowerCase() }, DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    const payload = fixture('delivered.json');
    const row = (payload.history as Record<string, unknown>[])[1]!;
    for (const [index, body] of [
      null,
      [],
      { error: 'Sample error' },
      { tracking_number: DELIVERED },
      { ...payload, history: {} },
      { ...payload, history: ['Delivered'] },
      { ...payload, history: [{ ...row, status: '' }] },
      { ...payload, history: [{ ...row, status: 3 }] },
      { ...payload, history: [{ ...row, reason: {} }] },
      { ...payload, history: [{ ...row, updated_at: '2026-02-11T18:40:22Z' }] },
      { ...payload, history: [{ ...row, updated_at: '2026-02-11 24:00:00' }] },
      { ...payload, history: [{ ...row, updated_at: '2026-02-30 18:40:22' }] },
      { ...payload, history: [{ ...row, updated_at: null }] },
      { ...payload, history: Array.from({ length: 501 }, () => row) },
    ].entries()) {
      expect(() => parseQuicksilver(body, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a shipment without statuses', () => {
    expect(() => parseQuicksilver({ ...fixture('delivered.json'), history: [] }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a browser check, a refused token, a moved route and a broken reply apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: DELIVERED });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => json({ error: 'Unauthorized' }, { status: 401 }))).rejects.toMatchObject({ kind: 'challenge', status: 401 });
    await expect(lookup(() => new Response('<html><body>404 Not Found</body></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => json({ error: 'Sample error' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => new Response('', { status: 301, headers: { Location: 'https://quick-silver.express/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 301 });
    await expect(lookup(() => json({ error: 'Sample error' }, { status: 400 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
  });

  it('refuses what the carrier does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['QS00001', 'QSZZZZZZZZZ', `QS${'0'.repeat(29)}`, 'QS000000001,QS000000002', 'QS/000000001', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeQuicksilverNumber(' qs 000 000 001 ')).toBe(DELIVERED);
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

  it('declares no recognition', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Quicksilver to the adapter', async () => {
    const fetcher = replying(() => json(fixture('delivered.json')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'quicksilver-sa' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'quicksilver-sa', source: 'quicksilver-sa', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === quicksilverLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Quicksilver status vocabulary', () => {
  it('records every status name with the stage the map gives it', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      const answer = statusMapAnswer({ carrier: 'quicksilver-sa', providerCode: entry.wording, description: entry.wording });
      if (!entry.stage) {
        expect(answer.kind, entry.wording).toBe('intentional_gap');
        expect(quicksilverStage(entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(quicksilverStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('reads a status name in any case and leaves the rest to the shared rules', () => {
    expect(quicksilverMappedStage('OUT FOR DELIVERY')).toBe('out_for_delivery');
    expect(quicksilverMappedStage('Sample Status')).toBeUndefined();
    expect(quicksilverStage('Sample Status')).toBeNull();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'quicksilver-sa', providerCode: 'Sample Status', description: 'Sample Status' })).toEqual({ kind: 'unknown' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, InpostTracker, parseInpostTrackingResponse } from './adapter.js';
import { needsInpostPickup, parseInpostPickup } from './pickup.js';

const NUMBER = '640000000000000000000001';
const hub = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const shipx = () => JSON.parse(readFileSync(new URL('./fixtures/shipx-collected.json', import.meta.url), 'utf8'));
const HUB_URL = `https://inposteasy.com/api/tracking/${NUMBER}?language=en`;
const SHIPX_URL = `https://api-shipx-pl.easypack24.net/v1/tracking/${NUMBER}`;
const POINT = 'EXA001\nExample Street 1\n00-000 Exampletown';

describe('InPost ShipX pickup enrichment', () => {
  it('projects only the identity-bound target point for a confirmed collection', () => {
    const history = parseInpostTrackingResponse(hub(), NUMBER);
    expect(parseInpostPickup(shipx(), NUMBER, history)).toBe(POINT);
    const readyHub = hub(); readyHub.status = 'LMD.1004'; readyHub.trackingDetails.pop();
    const readyShipx = shipx(); readyShipx.status = 'ready_to_pickup'; readyShipx.tracking_details.shift();
    expect(parseInpostPickup(readyShipx, NUMBER, parseInpostTrackingResponse(readyHub, NUMBER))).toBe(POINT);
    const publicPoint = shipx(); publicPoint.service = 'inpost_locker_customer_service_point'; publicPoint.custom_attributes.target_machine_detail.type = ['pok', 'pop'];
    expect(parseInpostPickup(publicPoint, NUMBER, history)).toBe(POINT);
    expect(JSON.stringify({ pickup_point: parseInpostPickup(shipx(), NUMBER, history) })).not.toContain('PRIVATE');
    expect(history.expected_delivery).toBeNull();
  });

  it('rejects the whole wrong identity and suppresses stale or differently progressed points', () => {
    const history = parseInpostTrackingResponse(hub(), NUMBER);
    for (const returned of [undefined, {}, `${NUMBER}OTHER`, `${NUMBER}${' '.repeat(100)}OTHER`]) {
      const value = shipx(); value.tracking_number = returned;
      expect(() => parseInpostPickup(value, NUMBER, history)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const wrong = shipx(); wrong.status = 'returned_to_sender'; wrong.tracking_details[0].status = 'returned_to_sender';
    expect(parseInpostPickup(wrong, NUMBER, history)).toBeUndefined();
    const stale = shipx(); stale.tracking_details[0].datetime = '2026-05-02T10:00:00+02:00';
    expect(parseInpostPickup(stale, NUMBER, history)).toBeUndefined();
    const noClock = shipx(); noClock.tracking_details[0].datetime = '2026-05-04T10:00:00';
    expect(parseInpostPickup(noClock, NUMBER, history)).toBeUndefined();
    const mismatchedPoint = shipx(); mismatchedPoint.custom_attributes.target_machine_id = 'OTHER';
    expect(parseInpostPickup(mismatchedPoint, NUMBER, history)).toBeUndefined();
  });

  it('excludes door deliveries, returns, future points and uncertain collection histories', () => {
    const history = parseInpostTrackingResponse(hub(), NUMBER);
    for (const stage of ['returned', 'return_started', 'in_transit', 'out_for_delivery', undefined]) {
      expect(needsInpostPickup({ ...history, current_stage: stage })).toBe(false);
      expect(parseInpostPickup(shipx(), NUMBER, { ...history, current_stage: stage })).toBeUndefined();
    }
    const door = { ...history, events: history.events?.map((event, index) => index === 1 ? { ...event, stage: 'out_for_delivery' } : event) };
    expect(needsInpostPickup(door)).toBe(false);
    const unknown = shipx(); unknown.tracking_details[1].status = 'new_unknown';
    expect(parseInpostPickup(unknown, NUMBER, history)).toBeUndefined();
    const courier = shipx(); courier.service = 'inpost_courier_standard';
    expect(parseInpostPickup(courier, NUMBER, history)).toBeUndefined();
    const sentOut = shipx(); sentOut.tracking_details[1].status = 'out_for_delivery';
    expect(parseInpostPickup(sentOut, NUMBER, history)).toBeUndefined();
  });

  it.each(['-99:00', '-02:99', '+14:01', '+24:00'])('rejects malformed offset %s in either freshness clock', offset => {
    const history = parseInpostTrackingResponse(hub(), NUMBER);
    const source = shipx(); source.tracking_details[0].datetime = `2026-05-04T10:00:00${offset}`;
    expect(parseInpostPickup(source, NUMBER, history)).toBeUndefined();
    expect(parseInpostPickup(shipx(), NUMBER, { ...history, last_update: `2026-05-04T10:00:00${offset}` })).toBeUndefined();
    const malformedHub = hub(); malformedHub.trackingDetails.at(-1).datetime = `2026-05-04T10:00:00${offset}`;
    const parsed = parseInpostTrackingResponse(malformedHub, NUMBER);
    expect(parsed.events?.some(event => event.stage === 'delivered')).toBe(false);
    expect(parsed.delivered_at).toBeUndefined();
    expect(needsInpostPickup(parsed)).toBe(false);
  });

  it('retains all hub scans while adding the optional point through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => Response.json(String(input) === HUB_URL ? hub() : shipx()));
    const result = await new InpostTracker({ fetcher, userAgent: 'Synthetic host' }).fetch(NUMBER);
    expect(result).toEqual({ ...parseInpostTrackingResponse(hub(), NUMBER), pickup_point: POINT });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([HUB_URL, SHIPX_URL]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('User-Agent')).toBe('Synthetic host');
    }
  });

  it.each([404, 429, 503])('keeps the complete hub answer when ShipX returns HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => String(input) === HUB_URL ? Response.json(hub()) : new Response('Unavailable', { status }));
    await expect(new InpostTracker({ fetcher }).fetch(NUMBER)).resolves.toEqual(parseInpostTrackingResponse(hub(), NUMBER));
  });

  it('keeps hub history for wrong identity and malformed ShipX bodies', async () => {
    const value = shipx(); value.tracking_number = '640000000000000000000002';
    for (const body of [JSON.stringify(value), '<html>Challenge</html>', '{}']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => String(input) === HUB_URL ? Response.json(hub()) : new Response(body));
      await expect(new InpostTracker({ fetcher }).fetch(NUMBER)).resolves.toEqual(parseInpostTrackingResponse(hub(), NUMBER));
    }
  });

  it('recognizes from hub history alone and skips pickup I/O on a small remaining budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(hub()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(instance.track({ number: NUMBER }, { budgetMs: 200 })).resolves.toEqual(parseInpostTrackingResponse(hub(), NUMBER));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops optional retrieval on caller cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input) === HUB_URL) return Response.json(hub());
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    });
    const task = new InpostTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    controller.abort(new Error('Synthetic cancellation'));
    await expect(task).rejects.toThrow('Synthetic cancellation');
  });

  it('returns hub history within the budget when optional retrieval never answers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input) === HUB_URL) return Response.json(hub());
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    });
    await expect(new InpostTracker({ fetcher }).fetch(NUMBER, { budgetMs: 800 })).resolves.toEqual(parseInpostTrackingResponse(hub(), NUMBER));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

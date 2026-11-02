import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, EkartTracker } from './adapter.js';
import { parseEkart } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import { ekartScan } from './status.js';
const NUMBER = 'FMPP0000000001';
const RETURN = 'BSIC0000000001';
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const fixture = () => load('delivered');

describe('Ekart parser', () => {
  it('binds the map key, preserves dated history and drops the estimate once delivered', () => {
    const result = parseEkart(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-03T16:00:00Z', delivered_at: '2026-01-03T16:00:00Z' });
    expect(result.expected_delivery).toBeUndefined();
    expect(result.events).toHaveLength(3);
    expect(result.events?.[2]).toMatchObject({ stage: 'registered', stage_source: 'carrier_map', description: 'Pickup Requested' });
    const moving = fixture(); moving[NUMBER].shipmentTrackingDetails.pop();
    expect(parseEkart(moving, NUMBER)).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-01-03T16:00:00Z' });
  });
  it('maps scan codes and follows the return leg back to the seller', () => {
    const result = parseEkart(load('return'), RETURN);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'InscannedAtDH - OriginHub_AAA' });
    expect(result.expected_delivery).toBeUndefined();
    const history = [...result.events!].reverse();
    expect(history.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(history.map(event => event.stage)).toEqual([
      'registered', 'registered', 'registered', 'accepted', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit',
      'out_for_delivery', 'failed_attempt', 'failed_attempt', 'exception', 'in_transit', 'in_transit', 'in_transit']);
    expect(history.map(event => event.provider_leg ?? 'outward')).toEqual([...Array(14).fill('outward'), ...Array(4).fill('return')]);
    expect(history[0]).toMatchObject({ provider_code: 'OutForPickupEvent', location: 'Example origin', time: '2026-01-01T00:00:00Z' });
    expect(history[11]).not.toHaveProperty('provider_code');
    expect(history[14]).toMatchObject({ provider_code: 'ShipmentRtoConfirmed', provider_leg: 'return' });
  });
  it('reads a delivery on the return leg as returned and a cancelled pickup as the end of the estimate', () => {
    const value = load('return'); value[RETURN].shipmentTrackingDetails.push({ date: 1767290400000, city: 'Example origin', statusDetails: 'Delivered' });
    const returned = parseEkart(value, RETURN);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(returned.events?.[0]).toMatchObject({ description: 'Delivered', stage: 'returned', provider_leg: 'return' });
    expect(returned.delivered_at).toBeUndefined();
    const cancelled = load('return'); cancelled[RETURN].shipmentTrackingDetails.splice(1);
    cancelled[RETURN].shipmentTrackingDetails.push({ date: 1767229200000, city: 'Example origin', statusDetails: 'PickupCancel - OriginHub_AAA_PL' });
    const result = parseEkart(cancelled, RETURN);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', events: [{ provider_code: 'PickupCancel' }, { stage: 'registered' }] });
    expect(result.expected_delivery).toBeUndefined();
    expect(parseEkart(load('return'), RETURN).events?.at(-1)).not.toHaveProperty('provider_leg');
  });
  it('reads a hub named after "Received at" as transit, not acceptance', () => {
    const value = fixture(); value[NUMBER].shipmentTrackingDetails.splice(1, 2, { date: 1767400000000, city: 'Example hub', statusDetails: 'Received at Example Hub' });
    expect(parseEkart(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', expected_delivery: '2026-01-03T16:00:00Z' });
  });
  it('replays every recorded status through the map', () => {
    for (const entry of statuses.entries) {
      const description = 'code' in entry && entry.code ? `${entry.code} - ExampleHub_AAA` : entry.wording === 'Received at' ? 'Received at ExampleHub' : entry.wording!;
      expect(ekartScan(description).stage, description).toBe(entry.stage);
    }
  });
  it('rejects mixed identities and malformed rows', () => {
    const value = fixture(); value.OTHER0000000001 = value[NUMBER];
    expect(() => parseEkart(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const wrong = fixture(); wrong.FMPP9999999999 = wrong[NUMBER]; delete wrong[NUMBER];
    expect(() => parseEkart(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const row of [null, {}, { date: 1767456000000, statusDetails: {} }]) {
      const value = fixture(); value[NUMBER].shipmentTrackingDetails[0] = row;
      expect(() => parseEkart(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
  it('keeps unknown history and unresolved clocks inconclusive without inventing 1970 dates', () => {
    expect(() => parseEkart({}, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    const value = fixture(); value[NUMBER].shipmentTrackingDetails = [];
    expect(() => parseEkart(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
    value[NUMBER].shipmentTrackingDetails = [{ date: 1767456000, statusDetails: 'New operation', city: 'Example depot' }];
    expect(parseEkart(value, NUMBER)).toMatchObject({ status: 'unknown', last_update: null, events: [{ provider_time_text: '1767456000' }] });
    expect(parseEkart(value, NUMBER).current_stage).toBeUndefined();
  });
  it('retains the provider newest scan when its clock is unresolved', () => {
    const value = fixture(); value[NUMBER].shipmentTrackingDetails.at(-1).date = 'unknown';
    const result = parseEkart(value, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null });
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', provider_time_text: 'unknown' });
    expect(result.delivered_at).toBeUndefined();
  });
  it('deduplicates rows, bounds history and validates every retained input row', () => {
    const value = fixture(); value[NUMBER].shipmentTrackingDetails.push(value[NUMBER].shipmentTrackingDetails[0]);
    expect(parseEkart(value, NUMBER).events).toHaveLength(3);
    value[NUMBER].shipmentTrackingDetails = Array.from({ length: 1001 }, () => value[NUMBER].shipmentTrackingDetails[0]);
    expect(() => parseEkart(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
describe('Ekart retrieval', () => {
  it('bootstraps separate CSRF cookie sessions and forwards host identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes('/shipmenttrack/')) {
        const response = new Response('<meta name="csrf-token" content="synthetic-csrf">', { headers: { 'Set-Cookie': 'session=synthetic-session; Path=/; Secure' } });
        Object.defineProperty(response, 'url', { value: String(url) }); return response;
      }
      expect(new Headers(init?.headers).get('Cookie')).toContain('session=synthetic-session');
      return new Response(JSON.stringify(fixture()));
    });
    await new EkartTracker({ fetcher, userAgent: 'Synthetic tracker' }).fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('https://ekartlogistics.com/ekartlogistics-web-routes-api/ekartlogistics-web-proxy/trackings/v2');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ tracking_ids: NUMBER }), cache: 'no-store', redirect: 'manual' });
    expect(new Headers(init?.headers).get('csrf-token')).toBe('synthetic-csrf');
    expect(new Headers(init?.headers).get('x-user-agent')).toBe('Synthetic tracker EKCL/website/1');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('recognizes a number with history, leaves its empty answer open, and asks nothing for another shape', async () => {
    const replying = (body: unknown) => vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('/shipmenttrack/')
      ? new Response('<meta name="csrf-token" content="synthetic-csrf">') : new Response(JSON.stringify(body)));
    const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(carrier(replying(fixture())).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying({})).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('FMPP123')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });
  it('keeps a session reset separate from unknown parcel history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 205 }));
    await expect(new EkartTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
  it('does no I/O for invalid or aborted input, and bounds bootstrap bodies', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new EkartTracker({ fetcher: unused }).fetch('123')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new EkartTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(500_001)));
    await expect(new EkartTracker({ fetcher: oversized }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});

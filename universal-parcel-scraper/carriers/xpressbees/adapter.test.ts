import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { XpressbeesTracker } from './adapter.js';
import { parseXpressbees } from './parser.js';
const NUMBER = '10000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/returned.json', import.meta.url), 'utf8'));

describe('Xpressbees seller parser', () => {
  it('uses the newest actual scan rather than the stale return summary', () => {
    const result = parseXpressbees(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_update: '2026-01-03T16:00:00Z' });
    expect(result.events?.map(row => row.stage)).toEqual(['returned', 'out_for_delivery', 'in_transit']);
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_leg: 'return', provider_code: 'RTD' });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-ORDER');
  });
  it('distinguishes an unfinished return leg from completed delivery', () => {
    const value = fixture(); value.data.tracking.shift();
    expect(parseXpressbees(value, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    value.data.tracking[0].status = 'Delivered'; value.data.tracking[0].ship_status = 'delivered';
    expect(parseXpressbees(value, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-03T07:00:00Z' });
  });
  it('retains terminal return categories when wording only says Delivered', () => {
    const value = fixture(); value.data.tracking[0].status = 'Delivered';
    const result = parseXpressbees(value, NUMBER);
    expect(result.current_stage).toBe('returned'); expect(result.delivered_at).toBeUndefined();
  });
  it('refines broad return categories with exact scan wording', () => {
    const value = fixture(); value.data.tracking.shift();
    value.data.tracking[0].ship_status = 'rto in transit';
    expect(parseXpressbees(value, NUMBER).current_stage).toBe('out_for_delivery');
    value.data.tracking[0].status = 'Return Undelivered';
    expect(parseXpressbees(value, NUMBER).current_stage).toBe('failed_attempt');
    value.data.tracking[0].status = 'Reached at Origin';
    expect(parseXpressbees(value, NUMBER).current_stage).toBe('in_transit');
  });
  it('rejects mismatched summary or history and other courier attribution', () => {
    const wrong = fixture(); wrong.data.shipment.awb_number = '10000000000002';
    expect(() => parseXpressbees(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const mixed = fixture(); mixed.data.tracking[0].awb_number = '10000000000002';
    expect(() => parseXpressbees(mixed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const other = fixture(); other.data.courier_info.display_name = 'Another courier';
    expect(() => parseXpressbees(other, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('keeps seller absence inconclusive and unknown events unmapped', () => {
    expect(() => parseXpressbees({ status: false, code: 203, message: 'Invalid AWB' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const value = fixture(); value.data.tracking = [];
    expect(() => parseXpressbees(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value.data.tracking = [{ awb_number: NUMBER, status: 'New event', ship_status: 'future-code', event_time: 1767456000000 }];
    const result = parseXpressbees(value, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_update: null, events: [{ provider_time_text: '1767456000000' }] });
    expect(result.current_stage).toBeUndefined();
  });
  it('rejects malformed scans and bounds history', () => {
    for (const row of [null, {}, { awb_number: NUMBER, status: {} }]) {
      const value = fixture(); value.data.tracking[0] = row;
      expect(() => parseXpressbees(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = fixture(); value.data.tracking.push(value.data.tracking[0]);
    expect(parseXpressbees(value, NUMBER).events).toHaveLength(3);
    value.data.tracking = Array.from({ length: 1001 }, () => value.data.tracking[0]);
    expect(() => parseXpressbees(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
describe('Xpressbees seller retrieval', () => {
  it('uses one anonymous AWB request under the caller signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    await new XpressbeesTracker({ fetcher, userAgent: 'Synthetic tracker' }).fetch(NUMBER);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://xb-ucp-wallet-api-uat.xbees.in/api/v1/webhookTracking/find');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ AWBNO: NUMBER }), cache: 'no-store', redirect: 'error' });
    expect(new Headers(init?.headers).get('User-Agent')).toBe('Synthetic tracker');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('does no I/O for invalid or aborted input', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new XpressbeesTracker({ fetcher }).fetch('123')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new XpressbeesTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[404, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s separate from seller absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status: Number(status) }));
    await expect(new XpressbeesTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });
});

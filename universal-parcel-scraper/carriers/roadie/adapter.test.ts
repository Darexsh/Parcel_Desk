import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/detect.js';
import { adapter, RoadieTracker } from './adapter.js';
import { parseRoadie, roadieNumber } from './parser.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const number = `1R${'A'.repeat(26)}`;
const created = '2026-01-01T08:00:00-05:00', delivered = '2026-01-01T10:00:00-05:00';
const record = () => ({ tracking_number: number, state: 'delivered', created_at: created,
  updated_at: '2026-01-01T11:00:00-05:00', sender: { name: 'PRIVATE NAME', phone_number: 'PRIVATE PHONE' },
  recipient: { address: 'PRIVATE ADDRESS' }, events: [
    { event_type: 'delivery_details_added', created_at: '2026-01-01T11:00:00-05:00' },
    { event_type: 'delivery_confirmed', created_at: delivered },
    { event_type: 'pickup_confirmed', created_at: '2026-01-01T09:00:00-05:00' },
  ] });

describe('Roadie guest tracking', () => {
  it('uses the detection layouts and the official casing for each request', () => {
    expect(roadieNumber(number.toLowerCase())).toBe(number);
    expect(roadieNumber('1R1234ABCDEF5678')).toBe('1r1234abcdef5678');
    for (const input of [number, '1R1234ABCDEF5678']) expect(detectCarrierMatch(input).carrier).toBe('roadie');
    expect(() => roadieNumber(`${number}A`)).toThrow();
    expect(() => roadieNumber('1R1234GBCDEF5678')).toThrow();
  });

  it('retains tracking milestones and their offsets without later proof writes or private details', () => {
    const value = parseRoadie([record()], number);
    expect(value).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(Date.parse(value.last_update!)).toBe(Date.parse(delivered));
    expect(value.last_update).toContain('-05:00');
    expect(value.events).toHaveLength(3);
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
    expect(value.events?.map(event => event.provider_code)).toEqual(['delivery_confirmed', 'pickup_confirmed', 'created']);
  });

  it('keeps an identified expired record as a known exception and a transfer as an ongoing delivery', () => {
    const expired = { ...record(), state: 'expired', events: [] };
    expect(parseRoadie([expired], number)).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Expired' });
    expect(parseRoadie([expired], number).events?.[0]).toMatchObject({ provider_code: 'expired', stage: 'exception' });
    const delayed = { ...record(), state: 'cancelled', cancellation_code: 'past_latest_delivery_time' };
    expect(parseRoadie([delayed], number).last_status_text).toBe('Delayed');
    const transfer = { ...record(), events: [{ event_type: 'carrier_transfer', created_at: delivered }] };
    expect(parseRoadie([transfer], number)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('rejects a different delivery, malformed clocks, empty envelopes and unknown response shapes', () => {
    for (const payload of [[], {}, [{ ...record(), tracking_number: `1R${'B'.repeat(26)}` }],
      [{ ...record(), events: [{ event_type: 'pickup_confirmed', created_at: '2026-01-01T09:00:00' }] }]]) {
      expect(() => parseRoadie(payload, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('uses the host transport and keeps geographic blocks and broken endpoint replies distinct from a missing delivery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([record()])));
    const tracker = new RoadieTracker({ fetcher });
    await expect(tracker.fetch(number)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json;version=3' } });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ kind: 'not_found' });
    fetcher.mockResolvedValueOnce(new Response('<html>GEO_IP_BLOCK</html>', { status: 403 }));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ kind: 'challenge' });
    fetcher.mockResolvedValueOnce(new Response('<html>Missing endpoint</html>', { status: 404 }));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ kind: 'transport' });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('recognizes an expired delivery through HTTP and starts no request for unrelated input', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ ...record(), state: 'expired', events: [] }])));
    const provider = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(provider.recognize!(number)).resolves.toMatchObject({ known: true });
    await expect(provider.recognize!('UNRELATED')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

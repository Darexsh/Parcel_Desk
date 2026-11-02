import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CEVA Logistics live retrieval', () => {
  it.skipIf(!process.env.CEVA_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CEVA_LOGISTICS_TRACKING_NUMBER!, carrier: 'ceva-logistics' });
    expect(answer).toMatchObject({ carrier: 'ceva-logistics', source: 'ceva-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ceva-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event keeps its terminal's wall clock, without an offset, except a
    // delivery window's confirmation, whose clock is UTC.
    expect(answer.result.events.every((event) => event.description && (event.provider_code === 'APPSET'
      ? !event.local_time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time))
      : !event.time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CEVA_LOGISTICS_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.CEVA_LOGISTICS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CEVA_LOGISTICS_ORDER_NUMBER)('finds a shipment by its order number and reports its house bill', async () => {
    const result = await direct().track({ number: process.env.CEVA_LOGISTICS_ORDER_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.canonical_tracking_number).toMatch(/^[A-Z0-9]{5,40}$/);
  }, 45_000);

  it.skipIf(!process.env.CEVA_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CEVA_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

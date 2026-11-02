import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shree Maruti live retrieval', () => {
  it.skipIf(!process.env.SHREE_MARUTI_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.SHREE_MARUTI_TRACKING_NUMBER!, carrier: 'shree-maruti' });
    expect(answer).toMatchObject({ carrier: 'shree-maruti', source: 'shree-maruti' });
    expect(answer.attempts[0]).toMatchObject({ source: 'shree-maruti', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A scan is an instant in India's zone, or a copied row's wall clock without an offset.
    expect(answer.result.events.every((event) => event.description && (event.local_time
      ? !event.time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/.test(String(event.time))))).toBe(true);
    expect(answer.result.events.some((event) => event.time)).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SHREE_MARUTI_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.SHREE_MARUTI_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SHREE_MARUTI_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SHREE_MARUTI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

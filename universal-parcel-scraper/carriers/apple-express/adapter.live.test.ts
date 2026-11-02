import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A scan's clock: a wall clock to the second, or an instant where the row names its zone.
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

describe('Apple Express live retrieval', () => {
  it.skipIf(!process.env.APPLE_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.APPLE_EXPRESS_TRACKING_NUMBER!, carrier: 'apple-express' });
    expect(answer).toMatchObject({ carrier: 'apple-express', source: 'apple-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'apple-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description
      && (CLOCK.test(String(event.local_time)) || INSTANT.test(String(event.time))))).toBe(true);
    expect(answer.result.current_stage).toBeTruthy();
  }, 45_000);

  it.skipIf(!process.env.APPLE_EXPRESS_REFERENCE)('opens a shipper’s reference through its order', async () => {
    const result = await direct().track({ number: process.env.APPLE_EXPRESS_REFERENCE! });
    expect(result.canonical_tracking_number).toMatch(/^\d{8,9}$/);
    expect(result.events!.length).toBeGreaterThan(0);
  }, 45_000);

  it.skipIf(!process.env.APPLE_EXPRESS_CAINIAO_REFERENCE)('opens a Cainiao reference through its order', async () => {
    const result = await direct().track({ number: process.env.APPLE_EXPRESS_CAINIAO_REFERENCE! });
    expect(result.canonical_tracking_number).toMatch(/^\d{8,9}$/);
    expect(result.events!.length).toBeGreaterThan(0);
  }, 45_000);

  it.skipIf(!process.env.APPLE_EXPRESS_TRACKING_NUMBER)('recognizes the requested order', async () => {
    await expect(direct().recognize!(process.env.APPLE_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.APPLE_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.APPLE_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

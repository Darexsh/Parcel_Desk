import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('City-Link Express live retrieval', () => {
  it.skipIf(!process.env.CITYLINK_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CITYLINK_EXPRESS_TRACKING_NUMBER!, carrier: 'citylink-express' });
    expect(answer).toMatchObject({ carrier: 'citylink-express', source: 'citylink-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'citylink-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A scan whose country keeps Malaysia's clock is dated at +08:00; any other keeps its wall clock.
    expect(answer.result.events.every((event) => event.description && (event.time
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(event.time) && !event.local_time
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.some((event) => event.time)).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
    // Couriers and signers are not kept.
    expect(answer.result.events.every((event) => !/(?:courier|signed for by)\s*:/i.test(String(event.description)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CITYLINK_EXPRESS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.CITYLINK_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CITYLINK_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CITYLINK_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

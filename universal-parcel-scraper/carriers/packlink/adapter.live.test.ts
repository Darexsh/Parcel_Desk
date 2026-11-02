import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Packlink live retrieval', () => {
  it.skipIf(!process.env.PACKLINK_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PACKLINK_TRACKING_NUMBER!, carrier: 'packlink' });
    expect(answer).toMatchObject({ carrier: 'packlink', source: 'packlink' });
    expect(answer.attempts[0]).toMatchObject({ source: 'packlink', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the wall clock the page shows, without an offset.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => !event.location)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.PACKLINK_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.PACKLINK_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.PACKLINK_UNKNOWN_NUMBER)('reads an unknown reference as not found', async () => {
    await expect(direct().track({ number: process.env.PACKLINK_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

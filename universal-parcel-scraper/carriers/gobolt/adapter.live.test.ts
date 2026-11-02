import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GoBolt live retrieval', () => {
  it.skipIf(!process.env.GOBOLT_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GOBOLT_TRACKING_NUMBER!, carrier: 'gobolt' });
    expect(answer).toMatchObject({ carrier: 'gobolt', source: 'gobolt' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gobolt', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every step is an instant to the second, with its offset and its name.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => /^label_[a-z_]+$/.test(String(event.provider_code)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.GOBOLT_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.GOBOLT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.GOBOLT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GOBOLT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.GOBOLT_EXPIRED_NUMBER)('reads a number whose tracking expired as inconclusive', async () => {
    await expect(direct().track({ number: process.env.GOBOLT_EXPIRED_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
  });
});

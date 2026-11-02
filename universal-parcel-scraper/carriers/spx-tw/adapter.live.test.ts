import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPX Express Taiwan live retrieval', () => {
  it.skipIf(!process.env.SPX_TW_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SPX_TW_TRACKING_NUMBER!, carrier: 'spx-tw' });
    expect(answer).toMatchObject({ carrier: 'spx-tw', source: 'spx-tw' });
    expect(answer.attempts[0]).toMatchObject({ source: 'spx-tw', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant with its status name.
    expect(answer.result.events.every((event) => event.description && event.provider_code && /Z$/.test(String(event.time)))).toBe(true);
  }, 30_000);

  // The feed answers an unknown number as a failure, which proves no missing parcel.
  it.skipIf(!process.env.SPX_TW_UNKNOWN_NUMBER)('reads an unknown number as inconclusive', async () => {
    await expect(direct().track({ number: process.env.SPX_TW_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.skipIf(!process.env.SPX_TW_EXPIRED_NUMBER)('reads a parcel whose history has expired as having no history', async () => {
    await expect(direct().track({ number: process.env.SPX_TW_EXPIRED_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  });
});

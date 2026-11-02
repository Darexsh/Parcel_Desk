import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPX Express Vietnam live retrieval', () => {
  it.skipIf(!process.env.SPX_VN_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SPX_VN_TRACKING_NUMBER!, carrier: 'spx-vn' });
    expect(answer).toMatchObject({ carrier: 'spx-vn', source: 'spx-vn' });
    expect(answer.attempts[0]).toMatchObject({ source: 'spx-vn', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant with its code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && /Z$/.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.SPX_VN_UNKNOWN_NUMBER)('reads an unknown SPX number as not found', async () => {
    await expect(direct().track({ number: process.env.SPX_VN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

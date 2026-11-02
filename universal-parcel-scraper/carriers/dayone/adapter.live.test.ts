import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DayOne live retrieval', () => {
  it.skipIf(!process.env.DAYONE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DAYONE_TRACKING_NUMBER!, carrier: 'dayone' });
    expect(answer).toMatchObject({ carrier: 'dayone', source: 'dayone' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dayone', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan states its place's offset.
    expect(answer.result.events.every((event) => event.description && /[+-]\d{2}:\d{2}$/.test(String(event.time)))).toBe(true);
    expect(answer.result.last_update ?? null).toBe(answer.result.events[0]!.time ?? null);
  }, 45_000);

  it.skipIf(!process.env.DAYONE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DAYONE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

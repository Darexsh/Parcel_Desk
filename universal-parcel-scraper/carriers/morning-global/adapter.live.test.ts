import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Morning Global live retrieval', () => {
  it.skipIf(!process.env.MORNING_GLOBAL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MORNING_GLOBAL_TRACKING_NUMBER!, carrier: 'morning-global' });
    expect(answer).toMatchObject({ carrier: 'morning-global', source: 'morning-global' });
    expect(answer.attempts[0]).toMatchObject({ source: 'morning-global', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A scan has an instant with the offset its location names, or its wall clock to the minute.
    expect(answer.result.events.every((event) => event.description && (event.time
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/.test(String(event.time)) && !event.local_time
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.some((event) => event.time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.MORNING_GLOBAL_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.MORNING_GLOBAL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.MORNING_GLOBAL_NO_HISTORY_NUMBER)('reads a parcel the tracker knows without scans as no history', async () => {
    await expect(direct().track({ number: process.env.MORNING_GLOBAL_NO_HISTORY_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  }, 45_000);

  it.skipIf(!process.env.MORNING_GLOBAL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MORNING_GLOBAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('To-Day live retrieval', () => {
  it.skipIf(!process.env.TODAY_KR_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TODAY_KR_TRACKING_NUMBER!, carrier: 'today-kr' });
    expect(answer).toMatchObject({ carrier: 'today-kr', source: 'today-kr' });
    expect(answer.attempts[0]).toMatchObject({ source: 'today-kr', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant at Korea's offset, to the second.
    expect(answer.result.events.every((event) => event.description && event.stage
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TODAY_KR_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.TODAY_KR_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.TODAY_KR_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TODAY_KR_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.TODAY_KR_EXPIRED_NUMBER)('reads a parcel delivered more than three months ago as expired', async () => {
    await expect(direct().track({ number: process.env.TODAY_KR_EXPIRED_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
  });
});

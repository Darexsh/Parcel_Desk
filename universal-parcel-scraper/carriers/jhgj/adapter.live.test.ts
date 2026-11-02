import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jiuhao International live retrieval', () => {
  it.skipIf(!process.env.JHGJ_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.JHGJ_TRACKING_NUMBER!, carrier: 'jhgj' });
    expect(answer).toMatchObject({ carrier: 'jhgj', source: 'jhgj' });
    expect(answer.attempts[0]).toMatchObject({ source: 'jhgj', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Wall clocks only, and none still ahead on the tracker's own clock.
    const now = DateTime.now().setZone('Asia/Shanghai').toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(answer.result.events.every((event) => event.description && !event.time && event.local_time! <= now)).toBe(true);
    // No postcode survives in a row's text or place.
    expect(answer.result.events.some((event) => /\d{2}-\d{3}|\d{4,}/.test(`${event.description} ${event.location ?? ''}`))).toBe(false);
  });

  it.skipIf(!process.env.JHGJ_TRACKING_NUMBER)('recognizes the parcel by the same lookup', async () => {
    await expect(direct().recognize!(process.env.JHGJ_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.JHGJ_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.JHGJ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

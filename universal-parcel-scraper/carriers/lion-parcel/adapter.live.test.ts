import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Lion Parcel live retrieval', () => {
  it.skipIf(!process.env.LION_PARCEL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LION_PARCEL_TRACKING_NUMBER!, carrier: 'lion-parcel' });
    expect(answer).toMatchObject({ carrier: 'lion-parcel', source: 'lion-parcel' });
    expect(answer.attempts[0]).toMatchObject({ source: 'lion-parcel', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.current_stage).toBeTruthy();
    // Every scan has its moment with an offset.
    expect(answer.result.events.every((event) => event.description && event.time
      && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time) && Date.parse(event.time) <= Date.now())).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.LION_PARCEL_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.LION_PARCEL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.LION_PARCEL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LION_PARCEL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

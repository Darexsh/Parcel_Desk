import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PTS Worldwide Express live retrieval', () => {
  it.skipIf(!process.env.PTS_WORLDWIDE_EXPRESS_TRACKING_NUMBER)('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.PTS_WORLDWIDE_EXPRESS_TRACKING_NUMBER!, carrier: 'pts-worldwide-express' });
    expect(answer).toMatchObject({ carrier: 'pts-worldwide-express', source: 'pts-worldwide-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pts-worldwide-express', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    // A parcel asked by its partner's number can have only PTS's summary.
    if (answer.result.summary_only) expect(answer.result.events).toEqual([]);
    else expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the Istanbul wall clock the page shows, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PTS_WORLDWIDE_EXPRESS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.PTS_WORLDWIDE_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.PTS_WORLDWIDE_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PTS_WORLDWIDE_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SP Express live retrieval', () => {
  it.skipIf(!process.env.SP_EXPRESS_TRACKING_NUMBER)('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SP_EXPRESS_TRACKING_NUMBER!, carrier: 'sp-express' });
    expect(answer).toMatchObject({ carrier: 'sp-express', source: 'sp-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'sp-express', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    // An older parcel's history is archived and only its current status is left.
    if (answer.result.summary_only) expect(answer.result.events).toEqual([]);
    else expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the tracker's wall clock, or its day, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SP_EXPRESS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.SP_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SP_EXPRESS_CAINIAO_NUMBER)('retrieves a Cainiao parcel on its own page', async () => {
    await expect(direct().track({ number: process.env.SP_EXPRESS_CAINIAO_NUMBER! }))
      .resolves.toMatchObject({ current_stage: expect.any(String) });
  }, 45_000);

  it.skipIf(!process.env.SP_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SP_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

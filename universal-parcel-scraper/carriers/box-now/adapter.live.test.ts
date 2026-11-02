import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BOX NOW live retrieval', () => {
  it.skipIf(!process.env.BOX_NOW_TRACKING_NUMBER)('retrieves dated history for the requested parcel with providers disabled', async () => {
    const number = process.env.BOX_NOW_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'box-now' });
    expect(answer).toMatchObject({ carrier: 'box-now', source: 'box-now', attempts: [{ source: 'box-now', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.BOX_NOW_UNKNOWN_NUMBER)('reads the empty list for an unknown parcel id as not found', async () => {
    await expect(direct().track({ number: process.env.BOX_NOW_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.BOX_NOW_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

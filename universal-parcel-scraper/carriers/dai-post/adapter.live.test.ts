import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DAI Post live retrieval', () => {
  it.skipIf(!process.env.DAI_POST_TRACKING_NUMBER)('retrieves history for the requested parcel with providers disabled', async () => {
    const number = process.env.DAI_POST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'dai-post' });
    expect(answer).toMatchObject({ carrier: 'dai-post', source: 'dai-post', attempts: [{ source: 'dai-post', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time || event.local_time)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DAI_POST_UNKNOWN_NUMBER)('reads the unknown-number page as not found', async () => {
    await expect(direct().track({ number: process.env.DAI_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.DAI_POST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

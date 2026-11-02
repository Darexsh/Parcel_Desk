import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Cyprus Post live retrieval', () => {
  it.skipIf(!process.env.CYPRUS_POST_TRACKING_NUMBER)('retrieves dated history for the requested number with providers disabled', async () => {
    const number = process.env.CYPRUS_POST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'cyprus-post' });
    expect(answer).toMatchObject({ carrier: 'cyprus-post', source: 'cyprus-post', attempts: [{ source: 'cyprus-post', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.time ?? event.local_time) && event.description
      && !/\b\d{4}\b/.test(event.location ?? ''))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CYPRUS_POST_UNKNOWN_NUMBER)('reads the no-information notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CYPRUS_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CYPRUS_POST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

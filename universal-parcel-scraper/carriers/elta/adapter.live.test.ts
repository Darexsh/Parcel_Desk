import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ELTA live retrieval', () => {
  it.skipIf(!process.env.ELTA_TRACKING_NUMBER)('retrieves dated history for the requested item with providers disabled', async () => {
    const number = process.env.ELTA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'elta' });
    expect(answer).toMatchObject({ carrier: 'elta', source: 'elta', attempts: [{ source: 'elta', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ELTA_UNKNOWN_NUMBER)('reads the no-history notice for an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.ELTA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ELTA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CDL live retrieval', () => {
  it.skipIf(!process.env.CDL_TRACKING_NUMBER)('retrieves dated history for the requested number with providers disabled', async () => {
    const number = process.env.CDL_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'cdl' });
    expect(answer).toMatchObject({ carrier: 'cdl', source: 'cdl', attempts: [{ source: 'cdl', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CDL_UNKNOWN_NUMBER)('reads the empty reply for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CDL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CDL_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

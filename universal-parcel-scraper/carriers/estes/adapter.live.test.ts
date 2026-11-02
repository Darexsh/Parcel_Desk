import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Estes live retrieval', () => {
  it.skipIf(!process.env.ESTES_TRACKING_NUMBER)('retrieves the history of the requested PRO number with providers disabled', async () => {
    const number = process.env.ESTES_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'estes' });
    expect(answer).toMatchObject({ carrier: 'estes', source: 'estes', attempts: [{ source: 'estes', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every clock carries an offset.
    expect(answer.result.events.every(event => event.time && event.local_time === undefined && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ESTES_UNKNOWN_NUMBER)('reads the service’s not-found for an unknown PRO number as not found', async () => {
    await expect(direct().track({ number: process.env.ESTES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ESTES_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

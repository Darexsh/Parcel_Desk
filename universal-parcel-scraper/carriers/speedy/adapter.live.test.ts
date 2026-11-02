import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Speedy live retrieval', () => {
  it.skipIf(!process.env.SPEEDY_TRACKING_NUMBER)('retrieves dated history for the requested shipment with providers disabled', async () => {
    const number = process.env.SPEEDY_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'speedy' });
    expect(answer).toMatchObject({ carrier: 'speedy', source: 'speedy', attempts: [{ source: 'speedy', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SPEEDY_UNKNOWN_NUMBER)('reads the missing-resource page for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SPEEDY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.SPEEDY_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

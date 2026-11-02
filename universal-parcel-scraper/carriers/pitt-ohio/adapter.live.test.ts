import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pitt Ohio live retrieval', () => {
  it.skipIf(!process.env.PITT_OHIO_TRACKING_NUMBER)('retrieves dated history for the requested PRO number with providers disabled', async () => {
    const number = process.env.PITT_OHIO_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'pitt-ohio' });
    expect(answer).toMatchObject({ carrier: 'pitt-ohio', source: 'pitt-ohio', attempts: [{ source: 'pitt-ohio', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && !event.time)).toBe(true);
    expect(answer.result.events.some(event => event.stage && event.location)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.PITT_OHIO_UNKNOWN_NUMBER)('reads the search form’s notice for an unknown PRO number as not found', async () => {
    await expect(direct().track({ number: process.env.PITT_OHIO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.PITT_OHIO_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});

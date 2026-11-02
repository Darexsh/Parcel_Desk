import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Roadrunner live retrieval', () => {
  it.skipIf(!process.env.ROADRUNNER_TRACKING_NUMBER)('retrieves the travel history of the requested PRO with providers disabled', async () => {
    const number = process.env.ROADRUNNER_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'roadrunner' });
    expect(answer).toMatchObject({ carrier: 'roadrunner', source: 'roadrunner', attempts: [{ source: 'roadrunner', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row is a wall clock, or a day, with its wording; nothing carries an offset.
    expect(answer.result.events.every(event => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/.test(String(event.local_time))
      && event.description && !event.time)).toBe(true);
    expect(answer.result.events.some(event => event.stage)).toBe(true);
    // Nobody is named.
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.ROADRUNNER_UNKNOWN_NUMBER)('reads the portal’s alert for an unknown PRO as not found', async () => {
    await expect(direct().track({ number: process.env.ROADRUNNER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ROADRUNNER_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});

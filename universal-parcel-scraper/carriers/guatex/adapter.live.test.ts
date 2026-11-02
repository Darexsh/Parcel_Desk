import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Guatex live retrieval', () => {
  // The reply names private people, so only its shape is asserted and nothing is printed.
  it.skipIf(!process.env.GUATEX_TRACKING_NUMBER)('retrieves the history of the requested guía with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GUATEX_TRACKING_NUMBER!, carrier: 'guatex' });
    expect(answer.carrier).toBe('guatex');
    expect(answer.source).toBe('guatex');
    expect(answer.attempts[0]?.kind).toBe('ok');
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Every row has its wording, its code and its stage, and a clock read in Guatemala or a day.
    expect(events.every((event) => event.description && event.provider_code && event.stage)).toBe(true);
    expect(events.every((event) => (event.time ? event.time.endsWith('Z') : /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.current_stage).toBeTruthy();
    if (answer.result.current_stage === 'delivered') expect(answer.result.delivered_at).toMatch(/Z$/);
  }, 45_000);

  it.skipIf(!process.env.GUATEX_TRACKING_NUMBER)('recognizes the requested guía', async () => {
    const recognition = await direct().recognize!(process.env.GUATEX_TRACKING_NUMBER!);
    expect(recognition.known).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.GUATEX_UNKNOWN_NUMBER)('reads an unknown guía as not found', async () => {
    await expect(direct().track({ number: process.env.GUATEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.GUATEX_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

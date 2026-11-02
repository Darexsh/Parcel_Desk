import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pos Indonesia live retrieval', () => {
  it.skipIf(!process.env.POS_INDONESIA_TRACKING_NUMBER)('retrieves the history of the requested item with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.POS_INDONESIA_TRACKING_NUMBER!, carrier: 'pos-indonesia' });
    expect(answer).toMatchObject({ carrier: 'pos-indonesia', source: 'pos-indonesia' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pos-indonesia', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its office's wall clock, without an offset, and its state.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
    // Staff and recipients stay out of the wording.
    expect(answer.result.events.some((event) => /\boleh\b/i.test(String(event.description)))).toBe(false);
  }, 75_000);

  it.skipIf(!process.env.POS_INDONESIA_TRACKING_NUMBER)('recognizes the requested item', async () => {
    await expect(direct().recognize!(process.env.POS_INDONESIA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.POS_INDONESIA_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.POS_INDONESIA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Vozovoz live retrieval', () => {
  it.skipIf(!process.env.VOZOVOZ_TRACKING_NUMBER)('retrieves the summary of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.VOZOVOZ_TRACKING_NUMBER!, carrier: 'vozovoz' });
    expect(answer).toMatchObject({ carrier: 'vozovoz', source: 'vozovoz' });
    expect(answer.attempts[0]).toMatchObject({ source: 'vozovoz', kind: 'ok' });
    expect(answer.result).toMatchObject({ summary_only: true });
    expect(answer.result.last_status_text).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone has its wording, its stage and a wall clock without an offset.
    expect(answer.result.events.every((event) => event.description && event.stage && event.local_time && !event.time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.VOZOVOZ_TRACKING_NUMBER)('recognizes the requested order', async () => {
    await expect(direct().recognize!(process.env.VOZOVOZ_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.VOZOVOZ_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.VOZOVOZ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.VOZOVOZ_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

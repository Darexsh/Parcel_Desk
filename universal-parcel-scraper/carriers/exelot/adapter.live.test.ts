import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

describe('Exelot live retrieval', () => {
  it.skipIf(!process.env.EXELOT_TRACKING_NUMBER)('retrieves the history of the requested parcel on the instants Exelot gives', async () => {
    const result = await direct().track({ number: process.env.EXELOT_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && INSTANT.test(String(event.time)) && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
    expect(result.current_stage).toBeTruthy();
  }, 30_000);

  it.skipIf(!process.env.EXELOT_TRACKING_NUMBER)('answers first with providers disabled, and recognizes the number', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EXELOT_TRACKING_NUMBER! });
    expect(answer).toMatchObject({ carrier: 'exelot', source: 'exelot' });
    expect(answer.attempts[0]).toMatchObject({ source: 'exelot', kind: 'ok' });
    await expect(direct().recognize!(process.env.EXELOT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.EXELOT_UNKNOWN_NUMBER)('reads a number the lookup does not have as not found', async () => {
    await expect(direct().track({ number: process.env.EXELOT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.EXELOT_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

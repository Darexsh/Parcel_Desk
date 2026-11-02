import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TK KIT live retrieval', () => {
  it.skipIf(!process.env.KIT_TK_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.KIT_TK_TRACKING_NUMBER!, carrier: 'kit-tk' });
    expect(answer).toMatchObject({ carrier: 'kit-tk', source: 'kit-tk' });
    expect(answer.attempts[0]).toMatchObject({ source: 'kit-tk', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every step has its code, wording and a wall clock without an offset.
    expect(answer.result.events.every((event) => event.provider_code && event.description && event.local_time && !event.time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.KIT_TK_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.KIT_TK_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.KIT_TK_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.KIT_TK_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.KIT_TK_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

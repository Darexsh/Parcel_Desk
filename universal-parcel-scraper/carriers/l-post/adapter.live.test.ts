import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('L-POST live retrieval', () => {
  it.skipIf(!process.env.L_POST_TRACKING_NUMBER)('retrieves the status and history of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.L_POST_TRACKING_NUMBER!, carrier: 'l-post' });
    expect(answer).toMatchObject({ carrier: 'l-post', source: 'l-post' });
    expect(answer.attempts[0]).toMatchObject({ source: 'l-post', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.last_status_text).toBeTruthy();
    // Every status keeps its wall clock, without an offset, and its id.
    expect(answer.result.events.every((event) => event.description && !event.time && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.L_POST_TRACKING_NUMBER)('recognizes the requested order', async () => {
    await expect(direct().recognize!(process.env.L_POST_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.L_POST_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.L_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.L_POST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

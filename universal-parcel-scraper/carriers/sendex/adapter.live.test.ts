import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Sendex live retrieval', () => {
  it.skipIf(!process.env.SENDEX_TRACKING_NUMBER)('retrieves the history of the requested guía with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SENDEX_TRACKING_NUMBER!, carrier: 'sendex' });
    expect(answer).toMatchObject({ carrier: 'sendex', source: 'sendex', attempts: [{ source: 'sendex', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every movement keeps its office's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.receiver_name).toBeUndefined();
  }, 45_000);

  it.skipIf(!process.env.SENDEX_TRACKING_NUMBER)('recognizes the requested guía', async () => {
    await expect(direct().recognize!(process.env.SENDEX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.SENDEX_UNKNOWN_NUMBER)('reads the tracker’s notice for an unknown guía as not found', async () => {
    await expect(direct().track({ number: process.env.SENDEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.SENDEX_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});

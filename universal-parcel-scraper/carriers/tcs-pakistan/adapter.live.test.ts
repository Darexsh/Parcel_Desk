import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TCS live retrieval', () => {
  it.skipIf(!process.env.TCS_PAKISTAN_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TCS_PAKISTAN_TRACKING_NUMBER!, carrier: 'tcs-pakistan' });
    expect(answer).toMatchObject({ carrier: 'tcs-pakistan', source: 'tcs-pakistan' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tcs-pakistan', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every checkpoint has its wording and a clock, in Karachi's time for a domestic consignment.
    expect(answer.result.events.every((event) => event.description && (/\+05:00$/.test(String(event.time)) || event.local_time))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TCS_PAKISTAN_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.TCS_PAKISTAN_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.TCS_PAKISTAN_UNKNOWN_NUMBER)('reads an unknown consignment as not found', async () => {
    await expect(direct().track({ number: process.env.TCS_PAKISTAN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

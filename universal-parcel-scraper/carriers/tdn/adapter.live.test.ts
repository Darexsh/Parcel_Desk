import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TDN live retrieval', () => {
  it.skipIf(!process.env.TDN_TRACKING_NUMBER)('retrieves the status of the requested expedition with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TDN_TRACKING_NUMBER!, carrier: 'tdn' });
    expect(answer).toMatchObject({ carrier: 'tdn', source: 'tdn', result: { summary_only: true } });
    expect(answer.attempts[0]).toMatchObject({ source: 'tdn', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The status is a wall clock to the minute, without a zone.
    expect(answer.result.events.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))
      && event.time === undefined && event.description)).toBe(true);
    await expect(direct().recognize!(process.env.TDN_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.TDN_UNKNOWN_NUMBER)('reads an unregistered expedition as not found', async () => {
    await expect(direct().track({ number: process.env.TDN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.TDN_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

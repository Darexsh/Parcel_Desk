import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('XGS live retrieval', () => {
  it.skipIf(!process.env.XGS_TRACKING_NUMBER)('retrieves the status of the requested probill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.XGS_TRACKING_NUMBER!, carrier: 'xgs' });
    expect(answer).toMatchObject({ carrier: 'xgs', source: 'xgs' });
    expect(answer.attempts[0]).toMatchObject({ source: 'xgs', kind: 'ok' });
    // A summary: the status code and, once it has one, the newest milestone's day or wall clock with no zone.
    expect(answer.result).toMatchObject({ summary_only: true, provider_code: expect.stringMatching(/\S/) });
    expect(String(answer.result.last_update_local ?? '2026-01-01')).toMatch(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/);
  }, 45_000);

  it.skipIf(!process.env.XGS_TRACKING_NUMBER)('recognizes the requested probill', async () => {
    await expect(direct().recognize!(process.env.XGS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.XGS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.XGS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

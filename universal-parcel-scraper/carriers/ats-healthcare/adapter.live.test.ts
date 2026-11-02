import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ATS Healthcare live retrieval', () => {
  it.skipIf(!process.env.ATS_HEALTHCARE_TRACKING_NUMBER)('retrieves the status of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ATS_HEALTHCARE_TRACKING_NUMBER!, carrier: 'ats-healthcare' });
    expect(answer).toMatchObject({ carrier: 'ats-healthcare', source: 'ats-healthcare' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ats-healthcare', kind: 'ok' });
    // A summary: the status, its progress step and, once it has one, the status's wall clock with no zone.
    expect(answer.result).toMatchObject({ summary_only: true, provider_code: expect.stringMatching(/^[0-6]$/) });
    expect(String(answer.result.last_update_local ?? '2026-01-01T00:00:00')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  }, 45_000);

  it.skipIf(!process.env.ATS_HEALTHCARE_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.ATS_HEALTHCARE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.ATS_HEALTHCARE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ATS_HEALTHCARE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

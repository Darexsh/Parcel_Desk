import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Dynalogic live retrieval', () => {
  it.skipIf(!process.env.DYNALOGIC_TRACKING_NUMBER)('retrieves the requested order’s status with providers disabled', async () => {
    const number = process.env.DYNALOGIC_TRACKING_NUMBER!;
    const result = await direct().track({ number });
    expect(result).toMatchObject({ summary_only: true, events: [], provider_code: expect.stringMatching(/^[A-Z]+_[A-Z]+\/[0-4]/) });
    expect(result.last_status_text).toEqual(expect.any(String));
    if (result.current_stage !== 'registered') {
      const answer = await createTracker({ providers: [] }).track({ number, carrier: 'dynalogic' });
      expect(answer).toMatchObject({ carrier: 'dynalogic', source: 'dynalogic', attempts: [{ source: 'dynalogic', kind: 'ok' }] });
    }
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DYNALOGIC_UNKNOWN_NUMBER)('reads the service’s notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DYNALOGIC_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.DYNALOGIC_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

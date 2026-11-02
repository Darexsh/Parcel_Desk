import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Envialia live retrieval', () => {
  it.skipIf(!process.env.ENVIALIA_TRACKING_NUMBER)('retrieves the current state of the requested shipment with providers disabled', async () => {
    const number = process.env.ENVIALIA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'envialia' });
    expect(answer).toMatchObject({ carrier: 'envialia', source: 'envialia', attempts: [{ source: 'envialia', kind: 'ok' }],
      result: { summary_only: true } });
    expect(answer.result.provider_code).toMatch(/^\d{1,3}$/);
    expect(answer.result.last_status_text).toBeTruthy();
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ENVIALIA_UNKNOWN_NUMBER)('reads the empty reply for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ENVIALIA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ENVIALIA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Cargus live retrieval', () => {
  it.skipIf(!process.env.CARGUS_TRACKING_NUMBER)('reads offset-less local history for the requested AWB with providers disabled', async () => {
    const number = process.env.CARGUS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'cargus' });
    expect(answer).toMatchObject({ carrier: 'cargus', source: 'cargus', attempts: [{ source: 'cargus', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time === undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))
      .toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/confirmedBy|responseCode|PIN:/);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CARGUS_UNKNOWN_NUMBER)('reads the empty reply for an unknown AWB as not found', async () => {
    await expect(direct().track({ number: process.env.CARGUS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CARGUS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

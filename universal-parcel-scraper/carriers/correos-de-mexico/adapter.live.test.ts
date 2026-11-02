import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Correos de México live retrieval', () => {
  it.skipIf(!process.env.CORREOS_DE_MEXICO_TRACKING_NUMBER)('retrieves the history for the requested number with providers disabled', async () => {
    const number = process.env.CORREOS_DE_MEXICO_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'correos-de-mexico' });
    expect(answer).toMatchObject({ carrier: 'correos-de-mexico', source: 'correos-de-mexico',
      attempts: [{ source: 'correos-de-mexico', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.time ?? event.local_time) && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CORREOS_DE_MEXICO_UNKNOWN_NUMBER)('reads a number no offered year has information on as not found', async () => {
    await expect(direct().track({ number: process.env.CORREOS_DE_MEXICO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CORREOS_DE_MEXICO_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Coordinadora live retrieval', () => {
  it.skipIf(!process.env.COORDINADORA_TRACKING_NUMBER)('retrieves the history of the requested guide with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.COORDINADORA_TRACKING_NUMBER!, carrier: 'coordinadora' });
    expect(answer).toMatchObject({ carrier: 'coordinadora', source: 'coordinadora' });
    expect(answer.attempts[0]).toMatchObject({ source: 'coordinadora', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its code and wording, and a clock in Bogotá's time or a date alone.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && (/-05:00$/.test(String(event.time)) || /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.COORDINADORA_TRACKING_NUMBER)('recognizes the requested guide', async () => {
    await expect(direct().recognize!(process.env.COORDINADORA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.COORDINADORA_UNKNOWN_NUMBER)('reads an unknown guide as not found', async () => {
    await expect(direct().track({ number: process.env.COORDINADORA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

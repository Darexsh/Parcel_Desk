import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

describe('Raben live retrieval', () => {
  it.skipIf(!process.env.RABEN_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const number = process.env.RABEN_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'raben' });
    expect(answer).toMatchObject({ carrier: 'raben', source: 'raben', attempts: [{ source: 'raben', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row is an instant with its offset, a caption and the code of its status.
    expect(answer.result.events.every(event => event.description && INSTANT.test(String(event.time))
      && /^E\d{2}$/.test(String(event.provider_code)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.RABEN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.RABEN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.RABEN_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

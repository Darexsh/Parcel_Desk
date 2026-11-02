import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Omniva live retrieval', () => {
  it.skipIf(!process.env.OMNIVA_TRACKING_NUMBER)('retrieves the requested item with providers disabled', async () => {
    const number = process.env.OMNIVA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'omniva' });
    expect(answer).toMatchObject({ carrier: 'omniva', source: 'omniva', attempts: [{ source: 'omniva', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.every(event => event.time && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.OMNIVA_UNKNOWN_NUMBER)('reads the empty reply for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.OMNIVA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.OMNIVA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

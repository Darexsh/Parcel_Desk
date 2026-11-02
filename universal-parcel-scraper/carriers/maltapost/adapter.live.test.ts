import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('MaltaPost live retrieval', () => {
  it.skipIf(!process.env.MALTAPOST_TRACKING_NUMBER)('retrieves dated history for the requested item with providers disabled', async () => {
    const number = process.env.MALTAPOST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'maltapost' });
    expect(answer).toMatchObject({ carrier: 'maltapost', source: 'maltapost', attempts: [{ source: 'maltapost', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.MALTAPOST_UNKNOWN_NUMBER)('reads the reply without a barcode for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MALTAPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.MALTAPOST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

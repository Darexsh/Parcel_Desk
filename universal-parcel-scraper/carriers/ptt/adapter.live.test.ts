import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PTT live retrieval', () => {
  it.skipIf(!process.env.PTT_TRACKING_NUMBER)('retrieves dated history for the requested barcode with providers disabled', async () => {
    const number = process.env.PTT_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'ptt' });
    expect(answer).toMatchObject({ carrier: 'ptt', source: 'ptt', attempts: [{ source: 'ptt', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && !event.description.includes('*'))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.PTT_UNKNOWN_NUMBER)('reads the no-movement notice for an unknown barcode as not found', async () => {
    await expect(direct().track({ number: process.env.PTT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.PTT_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

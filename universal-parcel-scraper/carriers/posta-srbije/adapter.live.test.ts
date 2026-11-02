import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pošta Srbije live retrieval', () => {
  it.skipIf(!process.env.POSTA_SRBIJE_TRACKING_NUMBER)('retrieves the requested item with providers disabled', async () => {
    const number = process.env.POSTA_SRBIJE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'posta-srbije' });
    expect(answer).toMatchObject({ carrier: 'posta-srbije', source: 'posta-srbije', attempts: [{ source: 'posta-srbije', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.provider_code && event.description)).toBe(true);
    // Serbian offices' scans carry Belgrade's offset.
    expect(answer.result.events.some(event => /\+0[12]:00$/.test(event.time ?? ''))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.POSTA_SRBIJE_UNKNOWN_NUMBER)('reads the not-found notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.POSTA_SRBIJE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.POSTA_SRBIJE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

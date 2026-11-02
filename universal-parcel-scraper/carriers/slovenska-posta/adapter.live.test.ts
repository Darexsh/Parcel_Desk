import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Slovenská pošta live retrieval', () => {
  it.skipIf(!process.env.SLOVENSKA_POSTA_TRACKING_NUMBER)('retrieves the requested item with providers disabled', async () => {
    const number = process.env.SLOVENSKA_POSTA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'slovenska-posta' });
    expect(answer).toMatchObject({ carrier: 'slovenska-posta', source: 'slovenska-posta', attempts: [{ source: 'slovenska-posta', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.provider_code && event.description)).toBe(true);
    // Slovak scans carry Bratislava's offset.
    expect(answer.result.events.some(event => /\+0[12]:00$/.test(event.time ?? ''))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SLOVENSKA_POSTA_UNKNOWN_NUMBER)('reads the not-found answer for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SLOVENSKA_POSTA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.SLOVENSKA_POSTA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

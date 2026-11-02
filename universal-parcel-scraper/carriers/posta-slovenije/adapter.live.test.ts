import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pošta Slovenije live retrieval', () => {
  it.skipIf(!process.env.POSTA_SLOVENIJE_TRACKING_NUMBER)('retrieves the requested item with providers disabled', async () => {
    const number = process.env.POSTA_SLOVENIJE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'posta-slovenije' });
    expect(answer).toMatchObject({ carrier: 'posta-slovenije', source: 'posta-slovenije', attempts: [{ source: 'posta-slovenije', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.POSTA_SLOVENIJE_UNKNOWN_NUMBER)('reads the not-found notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.POSTA_SLOVENIJE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.POSTA_SLOVENIJE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

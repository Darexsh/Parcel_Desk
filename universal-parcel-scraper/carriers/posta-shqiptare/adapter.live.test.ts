import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Posta Shqiptare live retrieval', () => {
  it.skipIf(!process.env.POSTA_SHQIPTARE_TRACKING_NUMBER)('retrieves dated history for the requested item with providers disabled', async () => {
    const number = process.env.POSTA_SHQIPTARE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'posta-shqiptare' });
    expect(answer).toMatchObject({ carrier: 'posta-shqiptare', source: 'posta-shqiptare', attempts: [{ source: 'posta-shqiptare', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    for (const event of answer.result.events) {
      expect(event.description, JSON.stringify(event)).toBeTruthy();
      // Its own scans carry Tirana's offset; relayed ones keep their wall clock.
      if (event.time) expect(event.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/);
      else expect(event.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.POSTA_SHQIPTARE_UNKNOWN_NUMBER)('reads the empty list for an unknown item as not found', async () => {
    await expect(direct().track({ number: process.env.POSTA_SHQIPTARE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.POSTA_SHQIPTARE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

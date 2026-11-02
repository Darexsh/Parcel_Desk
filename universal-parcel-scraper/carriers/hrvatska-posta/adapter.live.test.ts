import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Hrvatska pošta live retrieval', () => {
  it.skipIf(!process.env.HRVATSKA_POSTA_TRACKING_NUMBER)('retrieves dated history for the requested number with providers disabled', async () => {
    const number = process.env.HRVATSKA_POSTA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number, carrier: 'hrvatska-posta' });
    expect(answer).toMatchObject({ carrier: 'hrvatska-posta', source: 'hrvatska-posta', attempts: [{ source: 'hrvatska-posta', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.description && !/^\d{5}\s/.test(event.location ?? ''))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.HRVATSKA_POSTA_UNKNOWN_NUMBER)('reads the no-data notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HRVATSKA_POSTA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.HRVATSKA_POSTA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

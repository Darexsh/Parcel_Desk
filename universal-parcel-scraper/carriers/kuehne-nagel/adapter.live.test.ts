import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Kuehne+Nagel live retrieval', () => {
  it.skipIf(!process.env.KUEHNE_NAGEL_TRACKING_NUMBER)('retrieves dated history for the requested shipment with providers disabled', async () => {
    const number = process.env.KUEHNE_NAGEL_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'kuehne-nagel' });
    expect(answer).toMatchObject({ carrier: 'kuehne-nagel', source: 'kuehne-nagel', attempts: [{ source: 'kuehne-nagel', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.description && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.KUEHNE_NAGEL_UNKNOWN_NUMBER)('reads a search without results as not found', async () => {
    await expect(direct().track({ number: process.env.KUEHNE_NAGEL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.KUEHNE_NAGEL_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

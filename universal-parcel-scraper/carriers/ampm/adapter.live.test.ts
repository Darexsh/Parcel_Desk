import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Grupo ampm live retrieval', () => {
  it.skipIf(!process.env.AMPM_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AMPM_TRACKING_NUMBER!, carrier: 'ampm' });
    expect(answer).toMatchObject({ carrier: 'ampm', source: 'ampm' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ampm', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every movement keeps the page's wall clock to the second, without an offset, and its type.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.AMPM_UNKNOWN_NUMBER)('reads a number the tracker has nothing for as inconclusive', async () => {
    await expect(direct().track({ number: process.env.AMPM_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 45_000);
});

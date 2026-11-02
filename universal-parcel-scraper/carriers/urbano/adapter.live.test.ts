import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Urbano live retrieval', () => {
  it.skipIf(!process.env.URBANO_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.URBANO_TRACKING_NUMBER!, carrier: 'urbano' });
    expect(answer).toMatchObject({ carrier: 'urbano', source: 'urbano' });
    expect(answer.attempts[0]).toMatchObject({ source: 'urbano', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps Urbano's wall clock, without an offset, its code and its wording.
    expect(answer.result.events.every((event) => event.description && !event.time && event.provider_code
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.URBANO_UNKNOWN_NUMBER)('reads a number the tracker holds nothing for as inconclusive', async () => {
    await expect(direct().track({ number: process.env.URBANO_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});

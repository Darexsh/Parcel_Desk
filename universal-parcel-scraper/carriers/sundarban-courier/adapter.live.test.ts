import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Sundarban Courier live retrieval', () => {
  it.skipIf(!process.env.SUNDARBAN_COURIER_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SUNDARBAN_COURIER_TRACKING_NUMBER!, carrier: 'sundarban-courier' });
    expect(answer).toMatchObject({ carrier: 'sundarban-courier', source: 'sundarban-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'sundarban-courier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status keeps Sundarban's day, without an offset, and its wording.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SUNDARBAN_COURIER_UNKNOWN_NUMBER)('reads a number the tracker holds nothing for as inconclusive', async () => {
    await expect(direct().track({ number: process.env.SUNDARBAN_COURIER_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});

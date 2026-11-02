import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('YYpost live retrieval', () => {
  it.skipIf(!process.env.YYPOST_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.YYPOST_TRACKING_NUMBER!, carrier: 'yypost' });
    expect(answer).toMatchObject({ carrier: 'yypost', source: 'yypost' });
    expect(answer.attempts[0]).toMatchObject({ source: 'yypost', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // YYpost's scans keep their wall clocks; an onward network's row it relays can carry an instant instead.
    expect(answer.result.events.every((event) => event.description && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(String(event.time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.YYPOST_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.YYPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

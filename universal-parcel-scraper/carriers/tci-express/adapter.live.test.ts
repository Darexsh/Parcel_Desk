import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TCI Express live retrieval', () => {
  it.skipIf(!process.env.TCI_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested docket with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.TCI_EXPRESS_TRACKING_NUMBER!, carrier: 'tci-express' });
    expect(answer).toMatchObject({ carrier: 'tci-express', source: 'tci-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tci-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Transhipment scans are Indian wall clocks kept with their instant; booking and delivery rows keep their day alone.
    for (const event of answer.result.events) {
      expect(event.description).toBeTruthy();
      if (event.time) expect(String(event.local_time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
      else expect(String(event.local_time)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 60_000);

  it.skipIf(!process.env.TCI_EXPRESS_UNKNOWN_NUMBER)('reads an unknown docket as not found', async () => {
    await expect(direct().track({ number: process.env.TCI_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

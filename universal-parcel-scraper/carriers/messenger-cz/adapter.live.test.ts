import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Messenger live retrieval', () => {
  it.skipIf(!process.env.MESSENGER_CZ_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MESSENGER_CZ_TRACKING_NUMBER!, carrier: 'messenger-cz' });
    expect(answer).toMatchObject({ carrier: 'messenger-cz', source: 'messenger-cz' });
    expect(answer.attempts[0]).toMatchObject({ source: 'messenger-cz', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is dated, with the offset the reply gives or Czech time's.
    expect(answer.result.events.every((event) => event.description && /(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.MESSENGER_CZ_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MESSENGER_CZ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

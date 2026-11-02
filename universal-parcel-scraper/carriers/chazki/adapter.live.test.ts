import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Chazki live retrieval', () => {
  it.skipIf(!process.env.CHAZKI_TRACKING_NUMBER)('retrieves the history of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CHAZKI_TRACKING_NUMBER!, carrier: 'chazki' });
    expect(answer).toMatchObject({ carrier: 'chazki', source: 'chazki', attempts: [{ source: 'chazki', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps the reply's wall clock to the minute, without an offset.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.CHAZKI_UNKNOWN_NUMBER)('reads an unknown trackcode as not found', async () => {
    await expect(direct().track({ number: process.env.CHAZKI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

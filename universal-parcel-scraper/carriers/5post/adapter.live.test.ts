import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('5Post live retrieval', () => {
  it.skipIf(!process.env.FIVEPOST_TRACKING_NUMBER)('retrieves the history of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.FIVEPOST_TRACKING_NUMBER!, carrier: '5post' });
    expect(answer).toMatchObject({ carrier: '5post', source: '5post' });
    expect(answer.attempts[0]).toMatchObject({ source: '5post', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every status is an instant with its offset, and carries 5Post's code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.FIVEPOST_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FIVEPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Quiqup live retrieval', () => {
  it.skipIf(!process.env.QUIQUP_TRACKING_NUMBER)('retrieves the history of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.QUIQUP_TRACKING_NUMBER!, carrier: 'quiqup' });
    expect(answer).toMatchObject({ carrier: 'quiqup', source: 'quiqup' });
    expect(answer.attempts[0]).toMatchObject({ source: 'quiqup', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every state change is an instant with its offset, and has a state the map knows.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.stage
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time))
      && Date.parse(String(event.time)) <= Date.now())).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.QUIQUP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.QUIQUP_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

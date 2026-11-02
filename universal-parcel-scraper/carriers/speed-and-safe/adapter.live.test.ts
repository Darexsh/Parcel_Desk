import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Gokulam Speed & Safe live retrieval', () => {
  it.skipIf(!process.env.SPEED_AND_SAFE_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SPEED_AND_SAFE_TRACKING_NUMBER!, carrier: 'speed-and-safe' });
    expect(answer).toMatchObject({ carrier: 'speed-and-safe', source: 'speed-and-safe' });
    expect(answer.attempts[0]).toMatchObject({ source: 'speed-and-safe', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the ERP's instant with its offset, and a one-letter code.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time))
      && /^[A-Z]$/.test(String(event.provider_code)))).toBe(true);
    // No status keeps its dash or what follows it.
    expect(answer.result.events.every((event) => !/-\s|-$/.test(String(event.description).replace(/(?:to|at) \S.*$/, '')))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SPEED_AND_SAFE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SPEED_AND_SAFE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

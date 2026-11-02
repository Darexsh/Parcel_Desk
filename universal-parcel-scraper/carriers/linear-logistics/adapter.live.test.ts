import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Linear Logistics live retrieval', () => {
  it.skipIf(!process.env.LINEAR_LOGISTICS_TRACKING_NUMBER)('retrieves dated history through the direct adapter', async () => {
    const result = await direct().track({ number: process.env.LINEAR_LOGISTICS_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(1);
    expect(result.events!.every((event) => event.description && event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/received by (?!DX\b)|https?:\/\//i);
  });

  it.skipIf(!process.env.LINEAR_LOGISTICS_TRACKING_NUMBER)('retrieves dated history through the facade with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LINEAR_LOGISTICS_TRACKING_NUMBER!, carrier: 'linear-logistics' });
    expect(answer).toMatchObject({ carrier: 'linear-logistics', source: 'linear-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'linear-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(1);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/received by (?!DX\b)|https?:\/\//i);
  }, 45_000);

  it.skipIf(!process.env.LINEAR_LOGISTICS_UNKNOWN_NUMBER)('reads the carrier’s explicit unknown-number answer', async () => {
    await expect(direct().track({ number: process.env.LINEAR_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

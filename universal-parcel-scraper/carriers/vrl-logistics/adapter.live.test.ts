import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('VRL Logistics live retrieval', () => {
  it.skipIf(!process.env.VRL_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested LR number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.VRL_LOGISTICS_TRACKING_NUMBER!, carrier: 'vrl-logistics' });
    expect(answer).toMatchObject({ carrier: 'vrl-logistics', source: 'vrl-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'vrl-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps its day alone, with its wording and branch; the oldest is the booking.
    expect(answer.result.events.every((event) => event.description && event.location && !event.time
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.at(-1)).toMatchObject({ description: 'Booked', stage: 'accepted' });
  }, 45_000);

  it.skipIf(!process.env.VRL_LOGISTICS_TRACKING_NUMBER)('recognizes the requested LR number', async () => {
    await expect(direct().recognize!(process.env.VRL_LOGISTICS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.VRL_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown LR number as not found', async () => {
    await expect(direct().track({ number: process.env.VRL_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('Day & Ross live retrieval', () => {
  it.skipIf(!process.env.DAY_ROSS_TRACKING_NUMBER)('retrieves the requested shipment without a provider', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DAY_ROSS_TRACKING_NUMBER!, carrier: 'day-ross' });
    expect(answer).toMatchObject({ carrier: 'day-ross', source: 'day-ross', result: { last_update: null } });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && event.local_time && !event.time)).toBe(true);
  });
});

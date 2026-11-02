import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('ZTO live retrieval', () => {
  it.skipIf(!process.env.ZTO_TRACKING_NUMBER || !process.env.FLARESOLVERR_URL)('retrieves matching history after verification', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.ZTO_TRACKING_NUMBER!, carrier: 'zto' }, { budgetMs: 55000 });
    expect(answer).toMatchObject({ carrier: 'zto', source: 'zto', result: { history_truncated: true } });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && event.time)).toBe(true);
  });
});

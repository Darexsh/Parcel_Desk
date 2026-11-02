import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('Instabox live notifications', () => {
  it.skipIf(!process.env.INSTABOX_TRACKING_NUMBER || !process.env.INSTABOX_TRACKING_URL)('retrieves the journey from the supplied notification', async () => {
    const answer = await createTracker({ providers: [] }).track({ carrier: 'instabox', number: process.env.INSTABOX_TRACKING_NUMBER!, trackingUrl: process.env.INSTABOX_TRACKING_URL! });
    expect(answer).toMatchObject({ carrier: 'instabox', source: 'instabox' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.time && event.description)).toBe(true);
  });
});

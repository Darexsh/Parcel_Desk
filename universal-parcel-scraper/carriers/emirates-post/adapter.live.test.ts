import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { EmiratesPostTracker } from './adapter.js';

const trawl = TrawlClient.fromEnvironment();
const number = process.env.EMIRATES_POST_TRACKING_NUMBER;
const unknown = process.env.EMIRATES_POST_UNKNOWN_NUMBER;

describe('Emirates Post live public tracking', () => {
  it.skipIf(!trawl || !number)('reads the tracking page’s bound history without party details', async () => {
    const result = await new EmiratesPostTracker({ trawl }).fetch(number!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time || event.time)).toBe(true);
    expect(result.events?.every(event => typeof event.provider_code === 'string')).toBe(true);
    expect(result).not.toHaveProperty('sender_name');
    expect(result).not.toHaveProperty('receiver_name');
  }, 60_000);

  it.skipIf(!trawl || !unknown)('keeps the page’s explicit not-found separate from verification', async () => {
    await expect(new EmiratesPostTracker({ trawl }).fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

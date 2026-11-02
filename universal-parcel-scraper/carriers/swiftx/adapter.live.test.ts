import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/index.js';
import { SwiftxTracker } from './adapter.js';

const trawl = TrawlClient.fromEnvironment();
const number = process.env.SWIFTX_TRACKING_NUMBER;
const unknown = process.env.SWIFTX_UNKNOWN_NUMBER;

describe('SwiftX live public tracking', () => {
  it.skipIf(!trawl || !number)('returns the parcel\'s history on its sites\' offsets through the browser service', async () => {
    const result = await new SwiftxTracker({ trawl }).fetch(number!, { budgetMs: 45_000 });
    expect(result.last_status_text).toEqual(expect.any(String));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(String(event.time)))).toBe(true);
    expect(result.events?.every((event) => /^[A-Z][A-Z0-9_]+$/.test(String(event.provider_code)))).toBe(true);
    expect(result.events?.filter((event) => ['DELIVERED', 'DELIVERY_FAILED'].includes(String(event.provider_code))).every((event) => !event.location)).toBe(true);
  }, 60_000);

  it.skipIf(!trawl || !unknown)('reports a number the tracker does not know as not found', async () => {
    await expect(new SwiftxTracker({ trawl }).fetch(unknown!, { budgetMs: 45_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

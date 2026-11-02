import { describe, expect, it } from 'vitest';
import { MagyarPostaTracker } from './adapter.js';
import { TrawlClient } from '../../core/transport/index.js';

const trawl = TrawlClient.fromEnvironment();
const number = process.env.MAGYAR_POSTA_TRACKING_NUMBER;
const unknown = process.env.MAGYAR_POSTA_UNKNOWN_NUMBER;

describe('Magyar Posta live app tracking', () => {
  it.skipIf(!trawl || !number)('adds the item through the browser service, then reads its history again without it', async () => {
    let scrapes = 0;
    const counted = { scrape: (...args: Parameters<TrawlClient['scrape']>) => { scrapes++; return trawl!.scrape(...args); } } as unknown as TrawlClient;
    const tracker = new MagyarPostaTracker({ trawl: counted });
    const result = await tracker.fetch(number!, { budgetMs: 60_000 });
    expect(result.last_status_text).toEqual(expect.any(String));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)) && !event.local_time)).toBe(true);
    expect(result.events?.some((event) => /^[1-5]$/.test(String(event.provider_code)))).toBe(true);
    // The application id now holds the number, which it reads without the browser.
    expect((await tracker.fetch(number!, { budgetMs: 15_000 })).events).toEqual(result.events);
    expect(scrapes).toBe(1);
  }, 90_000);

  it.skipIf(!trawl || !unknown)('reports a number the app does not add as indeterminate', async () => {
    await expect(new MagyarPostaTracker({ trawl }).fetch(unknown!, { budgetMs: 60_000 })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 70_000);
});

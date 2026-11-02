import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/index.js';
import { LoggiTracker } from './adapter.js';

const trawl = TrawlClient.fromEnvironment();
const number = process.env.LOGGI_TRACKING_NUMBER;
const unknown = process.env.LOGGI_UNKNOWN_NUMBER;

describe('Loggi live public tracking', () => {
  it.skipIf(!trawl || !number)('reads the requested history with calendar days', async () => {
    const result = await new LoggiTracker({ trawl }).fetch(number!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)) && !event.time)).toBe(true);
  }, 60_000);
  it.skipIf(!trawl || !unknown)('reports an unknown tracking code', async () => {
    await expect(new LoggiTracker({ trawl }).fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

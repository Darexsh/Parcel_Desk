import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pack-Man live retrieval', () => {
  it.skipIf(!process.env.PACK_MAN_TRACKING_NUMBER)('retrieves the history of the requested voucher with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PACK_MAN_TRACKING_NUMBER!, carrier: 'pack-man' });
    expect(answer).toMatchObject({ carrier: 'pack-man', source: 'pack-man' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pack-man', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an Athens clock kept as an instant.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/Μαζική Αλλαγή|[Ττ]ιμολ|pack-man\.gr\/t\//);
  }, 45_000);

  it.skipIf(!process.env.PACK_MAN_TRACKING_NUMBER)('recognizes the requested voucher, without its hyphen too', async () => {
    const voucher = process.env.PACK_MAN_TRACKING_NUMBER!;
    await expect(direct().recognize!(voucher)).resolves.toMatchObject({ known: true });
    await expect(direct().recognize!(voucher.replace('-', ''))).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.PACK_MAN_UNKNOWN_NUMBER)('reads an unknown voucher as not found', async () => {
    await expect(direct().track({ number: process.env.PACK_MAN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

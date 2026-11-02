import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const ITALY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/;

describe('Liccardi live retrieval', () => {
  it.skipIf(!process.env.LICCARDI_TRACKING_NUMBER)('retrieves dated scans for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LICCARDI_TRACKING_NUMBER!, carrier: 'liccardi' });
    expect(answer).toMatchObject({ carrier: 'liccardi', source: 'liccardi', attempts: [{ source: 'liccardi', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && ITALY.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.LICCARDI_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LICCARDI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

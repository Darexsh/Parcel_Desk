import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('Kyrgyz Post live retrieval', () => {
  it.skipIf(!process.env.KYRGYZ_POST_TRACKING_NUMBER)('retrieves the requested item’s scans with providers disabled', async () => {
    const number = process.env.KYRGYZ_POST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'kyrgyz-post' });
    expect(answer).toMatchObject({ carrier: 'kyrgyz-post', source: 'kyrgyz-post', attempts: [{ source: 'kyrgyz-post', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.KYRGYZ_POST_OUTBOUND_NUMBER)('retrieves an item posted in Kyrgyzstan', async () => {
    const result = await direct().track({ number: process.env.KYRGYZ_POST_OUTBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.stage)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.KYRGYZ_POST_UNKNOWN_NUMBER)('reads a code the tracker does not hold as not found', async () => {
    await expect(direct().track({ number: process.env.KYRGYZ_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.KYRGYZ_POST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

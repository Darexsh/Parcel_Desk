import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const SOFIA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/;

describe('Bulgarian Posts live retrieval', () => {
  it.skipIf(!process.env.BULGARIAN_POSTS_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.BULGARIAN_POSTS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'bulgarian-posts' });
    expect(answer).toMatchObject({ carrier: 'bulgarian-posts', source: 'bulgarian-posts', attempts: [{ source: 'bulgarian-posts', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && (SOFIA.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time)))))
      .toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.BULGARIAN_POSTS_INBOUND_NUMBER)('retrieves mail from abroad, with Bulgarian scans dated in Sofia', async () => {
    const result = await direct().track({ number: process.env.BULGARIAN_POSTS_INBOUND_NUMBER! });
    expect(result.events!.some(event => event.location?.endsWith('Bulgaria') && SOFIA.test(String(event.time)))).toBe(true);
    expect(result.events!.every(event => event.stage)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.BULGARIAN_POSTS_OUTBOUND_NUMBER)('retrieves an item posted in Bulgaria', async () => {
    const result = await direct().track({ number: process.env.BULGARIAN_POSTS_OUTBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.stage)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.BULGARIAN_POSTS_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.BULGARIAN_POSTS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.BULGARIAN_POSTS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

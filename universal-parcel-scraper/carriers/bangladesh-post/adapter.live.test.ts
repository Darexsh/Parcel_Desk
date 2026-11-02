import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DHAKA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+06:00$/;

describe('Bangladesh Post live retrieval', () => {
  it.skipIf(!process.env.BANGLADESH_POST_TRACKING_NUMBER)('retrieves the international tracker’s scans for the requested item with providers disabled', async () => {
    const number = process.env.BANGLADESH_POST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'bangladesh-post' });
    expect(answer).toMatchObject({ carrier: 'bangladesh-post', source: 'bangladesh-post', attempts: [{ source: 'bangladesh-post', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.BANGLADESH_POST_DOMESTIC_NUMBER)('retrieves the domestic tracker’s scans on Dhaka time', async () => {
    const result = await direct().track({ number: process.env.BANGLADESH_POST_DOMESTIC_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.provider_code && DHAKA.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BANGLADESH_POST_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.BANGLADESH_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.BANGLADESH_POST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});

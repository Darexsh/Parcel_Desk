import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:00$/;
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('Uzbekistan Post live retrieval', () => {
  it.skipIf(!process.env.UZBEKISTAN_POST_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.UZBEKISTAN_POST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'uzbekistan-post' });
    expect(answer).toMatchObject({ carrier: 'uzbekistan-post', source: 'uzbekistan-post', attempts: [{ source: 'uzbekistan-post', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && event.provider_code && INSTANT.test(String(event.time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.UZBEKISTAN_POST_INBOUND_NUMBER)('retrieves the scans of mail from abroad', async () => {
    const result = await direct().track({ number: process.env.UZBEKISTAN_POST_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => INSTANT.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.UZBEKISTAN_POST_EMS_NUMBER)('retrieves an EMS item’s scans from IPS', async () => {
    const result = await direct().track({ number: process.env.UZBEKISTAN_POST_EMS_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => OFFSET.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    expect(result.events!.some(event => event.time)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.UZBEKISTAN_POST_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.UZBEKISTAN_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.UZBEKISTAN_POST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

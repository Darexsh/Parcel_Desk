import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/;

describe('Mainfreight live retrieval', () => {
  it.skipIf(!process.env.MAINFREIGHT_TRACKING_NUMBER)('retrieves a transport consignment’s scans with providers disabled', async () => {
    const number = process.env.MAINFREIGHT_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'mainfreight' });
    expect(answer).toMatchObject({ carrier: 'mainfreight', source: 'mainfreight', attempts: [{ source: 'mainfreight', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && (INSTANT.test(String(event.time)) || WALL_CLOCK.test(String(event.local_time)))))
      .toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.MAINFREIGHT_JOB_NUMBER)('retrieves an air and ocean job’s milestones on the port’s wall clock', async () => {
    const result = await direct().track({ number: process.env.MAINFREIGHT_JOB_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time === undefined && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.MAINFREIGHT_MASTER_BILL_NUMBER)('retrieves an air and ocean job by its master bill', async () => {
    const result = await direct().track({ number: process.env.MAINFREIGHT_MASTER_BILL_NUMBER! });
    expect(result.canonical_tracking_number).toMatch(/^S\d{8}$/);
    expect(result.events!.length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!process.env.MAINFREIGHT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MAINFREIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.MAINFREIGHT_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});

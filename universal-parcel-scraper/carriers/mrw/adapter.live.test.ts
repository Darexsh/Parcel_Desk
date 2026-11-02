import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:[+-]\d{2}:\d{2}|Z)$/;
const instance = () => adapter({ fetcher: fetch, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

describe('MRW live anonymous tracking', () => {
  it.skipIf(!process.env.MRW_TRACKING_NUMBER)('retrieves bound native history through the full factory', async () => {
    const result = await instance().track({ number: process.env.MRW_TRACKING_NUMBER! });
    expect(result.events?.length).toBeGreaterThan(1);
    // An instant where the row's office settles its clock, else the wall clock; the newest row's instant is the last update.
    expect(result.events?.every(event => (event.time
      ? !event.local_time && MINUTE.test(event.time) && Date.parse(event.time) <= Date.now() : WALL.test(String(event.local_time))))).toBe(true);
    expect(result.summary_only).not.toBe(true);
    expect(result.last_update).toBe(result.events![0]!.time ?? null);
    if (result.status === 'delivered') expect(result.delivered_at ?? null).toBe(result.events![0]!.time ?? null);
    expect(JSON.stringify(result)).not.toMatch(/openMap|pickup_point_address|PRIVATE_SYNTHETIC/);
  });

  it.skipIf(!process.env.MRW_SUMMARY_ONLY_NUMBER)('retains a bound status without inventing history', async () => {
    const result = await instance().track({ number: process.env.MRW_SUMMARY_ONLY_NUMBER! });
    expect(result.status).not.toBe('unknown');
    expect(result.summary_only).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.last_update).toBeNull();
  });

  it.skipIf(!process.env.MRW_UNKNOWN_NUMBER)('reads unknown tracking as no history', async () => {
    await expect(instance().track({ number: process.env.MRW_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  });
});

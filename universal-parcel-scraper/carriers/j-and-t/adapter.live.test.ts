import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

describe('J&T Express Indonesia live app router', () => {
  it('answers a well-formed unknown waybill with a clean not-found', async () => {
    await expect(instance().track({ number: 'JX0000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.J_AND_T_TRACKING_NUMBER)('reads and recognizes a real waybill on local clocks without names or phone numbers', async () => {
    const result = await instance().track({ number: process.env.J_AND_T_TRACKING_NUMBER! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/delivered to \S|processed at [^"]* by \S|\d{9,}|https?:/);
    await expect(instance().recognize!(process.env.J_AND_T_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });
});

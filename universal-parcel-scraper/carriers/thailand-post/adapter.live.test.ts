import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

describe('Thailand Post live tracking service', () => {
  it('answers a well-formed unknown number with a clean not-found', async () => {
    await expect(instance().track({ number: 'EE900000005TH' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.THAILAND_POST_TRACKING_NUMBER)('reads a real number with its clocks and without recipient details', async () => {
    const result = await instance().track({ number: process.env.THAILAND_POST_TRACKING_NUMBER! });
    expect(result.events?.length).toBeGreaterThan(0);
    // Thai scans are instants on Bangkok time; foreign posts' scans keep only their wall clock.
    expect(result.events?.every((event) => /T\d{2}:\d{2}:\d{2}\+07:00$/.test(event.time ?? '')
      || (event.time === undefined && typeof event.local_time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(event.local_time)))).toBe(true);
    expect(result.events?.every((event) => event.provider_code && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/\*{3}|recipientName|signatureUrl|podImgUrl|latlng|delivery_officer|addressTelephone/);
  });
});

import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

describe('SpeedX live tracking page', () => {
  it('answers a well-formed unknown number with a clean not-found', async () => {
    await expect(instance().track({ number: 'SPXLAX000000000000000001' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.SPEEDX_TRACKING_NUMBER)('reads a real number as instants without recipient details', async () => {
    const result = await instance().track({ number: process.env.SPEEDX_TRACKING_NUMBER! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(event.time ?? ''))).toBe(true);
    expect(result.events?.every((event) => Object.keys(event).every((key) =>
      ['time', 'description', 'location', 'provider_code', 'stage', 'stage_source'].includes(key)))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|recipient|customer|zipCode|podUrl|labelDetails/i);
  });
});

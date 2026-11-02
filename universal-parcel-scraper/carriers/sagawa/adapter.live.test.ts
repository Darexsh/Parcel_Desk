import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

describe('Sagawa Express live widget', () => {
  it('answers a well-formed unknown waybill with a clean not-found', async () => {
    await expect(instance().track({ number: '300000000005' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.SAGAWA_TRACKING_NUMBER)('reads the current state of a real waybill without history or times', async () => {
    const result = await instance().track({ number: process.env.SAGAWA_TRACKING_NUMBER! });
    expect(result).toMatchObject({ summary_only: true, events: [], last_update: null, expected_delivery: null, timezone: 'Asia/Tokyo' });
    expect(result.provider_code).toMatch(/^\d{4}$/);
    expect(typeof result.last_status_text === 'string' || result.last_status_text === null).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

describe('STO signed live trace', () => {
  it('answers well-formed unknown waybills with a clean not-found', async () => {
    await expect(instance().track({ number: '773000000000000' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(instance().recognize!('400000000000')).resolves.toEqual({ known: false });
  }, 30_000);

  it.skipIf(!process.env.STO_TRACKING_NUMBER)('reads a real waybill on China time without courier details', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.STO_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.timezone).toBe('Asia/Shanghai');
    expect(result.events?.some(event => event.time?.endsWith('+08:00'))).toBe(true);
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/1[3-9]\d{9}|快递员|电话|签收人/);
  }, 30_000);
});

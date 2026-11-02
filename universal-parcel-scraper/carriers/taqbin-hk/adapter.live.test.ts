import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TA-Q-BIN Hong Kong live retrieval', () => {
  it.skipIf(!process.env.TAQBIN_HK_WAYBILL_NUMBER)('retrieves dated Hong Kong waybill history without universal providers', async () => {
    const result = await direct().track({ number: process.env.TAQBIN_HK_WAYBILL_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.TAQBIN_HK_UNKNOWN_WAYBILL)('leaves absent or expired waybill history inconclusive', async () => {
    await expect(direct().track({ number: process.env.TAQBIN_HK_UNKNOWN_WAYBILL! })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 30_000);
});

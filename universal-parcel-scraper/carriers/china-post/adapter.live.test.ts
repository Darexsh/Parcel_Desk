import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

describe('China Post app trace live', () => {
  it.skipIf(!process.env.CHINA_POST_WEB_NUMBER || !process.env.FLARESOLVERR_URL)('reads the identity-bound anonymous web preview', async () => {
    const carrier = adapter({ fetcher: fetch, env: process.env, recorder: NOOP_RECORDER,
      trawl: TrawlClient.fromEnvironment(process.env), browserExecutablePath: null });
    const result = await carrier.track({ number: process.env.CHINA_POST_WEB_NUMBER! }, { budgetMs: 60_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.history_truncated).toBe(true);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/电话|手机|快递员|投递员|签收人|\d{7,}/);
  });
  it('signs accepted requests and keeps an unused well-formed number inconclusive', async () => {
    // A refused signature would answer as a challenge instead.
    await expect(instance().track({ number: 'LZ000000005CN' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.skipIf(!process.env.CHINA_POST_GATED_NUMBER)('reports the phone request for a number the service opens only with it', async () => {
    await expect(instance().track({ number: process.env.CHINA_POST_GATED_NUMBER! }))
      .rejects.toMatchObject({ kind: 'input_required', field: 'recipient verification' });
  });

  it.skipIf(!process.env.CHINA_POST_TRACKING_NUMBER)('returns the newest bound scans on local clocks without contact details', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.CHINA_POST_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
    // Three guest scans, plus the dated acceptance when the history is cut.
    const scans = result.events!.filter((event) => event.provider_code);
    expect(scans.length).toBeLessThanOrEqual(3);
    if (result.events!.length > scans.length) {
      expect(result.history_truncated).toBe(true);
      expect(result.events!.at(-1)).toMatchObject({ description: '已揽收', stage: 'accepted' });
    }
    expect(result.events?.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && !event.time)).toBe(true);
    expect(result.last_update).toBeNull();
    expect(result.current_stage).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toMatch(/电话|手机|快递员|投递员|签收人|\d{7,}/);
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';

describe('Track718 Juxi guest tracking', () => {
  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.TRACK718_JUXI_TRACKING_NUMBER)('reads a supplied Juxi reference', async () => {
    const provider = adapter({ env: {}, trawl: TrawlClient.fromEnvironment(), recorder: NOOP_RECORDER, browserExecutablePath: null });
    const answer = await provider.track({ number: process.env.TRACK718_JUXI_TRACKING_NUMBER!, carrier: 'juxi-express' }, { budgetMs: 35000 });
    expect(answer.tracking_provider).toBe('Track718');
    expect(answer.events!.length).toBeGreaterThan(0);
  }, 45000);
});

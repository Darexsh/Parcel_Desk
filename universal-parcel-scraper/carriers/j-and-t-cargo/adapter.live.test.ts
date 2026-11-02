import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

describe('J&T Cargo live retrieval', () => {
  for (const variable of ['J_AND_T_CARGO_TRACKING_NUMBER', 'J_AND_T_CARGO_PIECE_NUMBER'] as const) {
    it.skipIf(!process.env[variable])(`retrieves exact ${variable === 'J_AND_T_CARGO_PIECE_NUMBER' ? 'piece' : 'master'} history with providers disabled`, async () => {
      const answer = await createTracker({ providers: [] }).track({ number: process.env[variable]!, carrier: 'j-and-t-cargo' });
      expect(answer.carrier).toBe('j-and-t-cargo');
      expect(answer.source).toBe('j-and-t-cargo');
      expect(answer.result.events.length).toBeGreaterThan(0);
      expect(answer.result.events.every(event => typeof event.local_time === 'string' && !event.time && !event.instant)).toBe(true);
      expect(answer.attempts).toMatchObject([{ source: 'j-and-t-cargo', kind: 'ok' }]);
    });
  }

  it.skipIf(!process.env.J_AND_T_CARGO_TRACKING_NUMBER)('confirms master identity with plain HTTP', async () => {
    const direct = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(direct.recognize!(process.env.J_AND_T_CARGO_TRACKING_NUMBER!)).resolves.toEqual({ known: true, lastActivityAt: null });
  });

  it.skipIf(!process.env.J_AND_T_CARGO_UNKNOWN_NUMBER)('retains an unknown placeholder as inconclusive', async () => {
    const direct = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(direct.track({ number: process.env.J_AND_T_CARGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

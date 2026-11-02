import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
describe('REX Indonesia live retrieval', () => {
  for (const variable of ['REX_INDONESIA_TRACKING_NUMBER', 'REX_INDONESIA_SECOND_TRACKING_NUMBER']) {
    it.skipIf(!process.env[variable])('reads a bound dated milestone view', async () => {
      const result = await direct().track({ number: process.env[variable]! });
      expect(result.events!.length).toBeGreaterThan(0);
      expect(result.history_truncated).toBe(true);
      expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
    });
  }
  it.skipIf(!process.env.REX_INDONESIA_UNKNOWN_NUMBER)('reads the whole-number absence notice', async () => {
    await expect(direct().track({ number: process.env.REX_INDONESIA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

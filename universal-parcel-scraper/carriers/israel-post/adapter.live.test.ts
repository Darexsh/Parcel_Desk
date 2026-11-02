import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

describe('Israel Post live guest tracking', () => {
  for (const variable of ['ISRAEL_POST_TRACKING_NUMBER', 'ISRAEL_POST_SECOND_TRACKING_NUMBER']) {
    it.skipIf(!process.env[variable])(`retrieves dated history with providers disabled (${variable})`, async () => {
      const answer = await createTracker({ providers: [] }).track({ number: process.env[variable]!, carrier: 'israel-post' }, { budgetMs: 20_000 });
      expect(answer).toMatchObject({ carrier: 'israel-post', source: 'israel-post', result: { history_truncated: true } });
      expect(answer.result.events.length).toBeGreaterThan(0);
      expect(answer.result.events.every(e => e.description && /^\d{4}-\d{2}-\d{2}$/.test(String(e.local_time)))).toBe(true);
    }, 45_000);
  }
  it.skipIf(!process.env.ISRAEL_POST_UNKNOWN_NUMBER)('does not confirm an echoed empty item', async () => {
    const direct = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(direct.recognize!(process.env.ISRAEL_POST_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 30_000);
});

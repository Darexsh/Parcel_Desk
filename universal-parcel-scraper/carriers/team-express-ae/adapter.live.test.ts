import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Team Express live retrieval', () => {
  it.skipIf(!process.env.TEAM_EXPRESS_AE_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TEAM_EXPRESS_AE_TRACKING_NUMBER!, carrier: 'team-express-ae' });
    expect(answer).toMatchObject({ carrier: 'team-express-ae', source: 'team-express-ae', attempts: [{ source: 'team-express-ae', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.receiver_name).toBeUndefined();
    expect(answer.result.sender_name).toBeUndefined();
    expect(answer.result.delivered_at).toBeUndefined();
  }, 30_000);

  it.skipIf(!process.env.TEAM_EXPRESS_AE_UNKNOWN_NUMBER)('reads the form alone for an unknown airwaybill as inconclusive', async () => {
    await expect(direct().track({ number: process.env.TEAM_EXPRESS_AE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 30_000);
});

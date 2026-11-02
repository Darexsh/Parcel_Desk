import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Kun Express live retrieval', () => {
  it.skipIf(!process.env.KUN_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.KUN_EXPRESS_TRACKING_NUMBER!, carrier: 'kun-express' });
    expect(answer).toMatchObject({ carrier: 'kun-express', source: 'kun-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'kun-express', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    // The forwarder's own rows on its Beijing clock, none still ahead of the lookup.
    expect(events.filter((event) => event.time).every((event) => event.time!.endsWith('+08:00') && Date.parse(event.time!) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.KUN_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.KUN_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

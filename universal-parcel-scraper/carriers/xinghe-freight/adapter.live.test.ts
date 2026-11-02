import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Xinghe Freight live retrieval', () => {
  it.skipIf(!process.env.XINGHE_FREIGHT_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.XINGHE_FREIGHT_TRACKING_NUMBER!, carrier: 'xinghe-freight' });
    expect(answer).toMatchObject({ carrier: 'xinghe-freight', source: 'xinghe-freight' });
    expect(answer.attempts[0]).toMatchObject({ source: 'xinghe-freight', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.XINGHE_FREIGHT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.XINGHE_FREIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

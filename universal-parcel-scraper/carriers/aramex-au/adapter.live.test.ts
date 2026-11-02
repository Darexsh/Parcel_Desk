import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Aramex Australia live retrieval', () => {
  it.skipIf(!process.env.ARAMEX_AU_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const number = process.env.ARAMEX_AU_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'aramex-au' });
    expect(answer).toMatchObject({ carrier: 'aramex-au', source: 'aramex-au' });
    expect(answer.attempts[0]).toMatchObject({ source: 'aramex-au', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && !event.time && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.ARAMEX_AU_UNKNOWN_NUMBER)('reads the tracker’s unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ARAMEX_AU_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.ARAMEX_AU_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

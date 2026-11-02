import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Oak Harbor live retrieval', () => {
  it.skipIf(!process.env.OAK_HARBOR_TRACKING_NUMBER)('retrieves dated history for the requested PRO with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.OAK_HARBOR_TRACKING_NUMBER!, carrier: 'oak-harbor' });
    expect(answer).toMatchObject({ carrier: 'oak-harbor', source: 'oak-harbor', attempts: [{ source: 'oak-harbor', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every(event => event.local_time && event.description && !event.time)).toBe(true);
    expect(answer.result.events.some(event => event.stage && event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.OAK_HARBOR_UNKNOWN_NUMBER)('reads the tracker’s answer for an unknown PRO as inconclusive or not found, never as history', async () => {
    const error = await direct().track({ number: process.env.OAK_HARBOR_UNKNOWN_NUMBER! }).then(() => null, (failure: unknown) => failure);
    expect(error).toMatchObject({ kind: expect.stringMatching(/^(?:not_found|indeterminate)$/) });
    if ((error as { kind: string }).kind === 'indeterminate') expect(error).toMatchObject({ reason: 'portal_not_found' });
  }, 45_000);
});

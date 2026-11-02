import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Wiio live retrieval', () => {
  it.skipIf(!process.env.WIIO_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.WIIO_TRACKING_NUMBER!, carrier: 'wiio' });
    expect(answer).toMatchObject({ carrier: 'wiio', source: 'wiio' });
    expect(answer.attempts[0]).toMatchObject({ source: 'wiio', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    // The line's own rows on its Beijing clock, none still ahead of the lookup; the others keep their wall clocks.
    expect(events.filter((event) => !event.local_time).every((event) => event.time!.endsWith('+08:00') && Date.parse(event.time!) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.WIIO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.WIIO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

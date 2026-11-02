import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('EMS Vietnam live retrieval', () => {
  it.skipIf(!process.env.EMS_VIETNAM_TRACKING_NUMBER)('retrieves the history of the requested item with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EMS_VIETNAM_TRACKING_NUMBER!, carrier: 'ems-vietnam' });
    expect(answer).toMatchObject({ carrier: 'ems-vietnam', source: 'ems-vietnam' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ems-vietnam', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Scans at Vietnamese offices are on Vietnam's clock.
    expect(answer.result.events.every((event) => event.description
      && (/\+07:00$/.test(String(event.time)) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.events.some((event) => event.location)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.EMS_VIETNAM_TRACKING_NUMBER)('recognizes the requested item', async () => {
    await expect(direct().recognize!(process.env.EMS_VIETNAM_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.EMS_VIETNAM_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.EMS_VIETNAM_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('WINIT live retrieval', () => {
  it.skipIf(!process.env.WINIT_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.WINIT_TRACKING_NUMBER!, carrier: 'winit' });
    expect(answer).toMatchObject({ carrier: 'winit', source: 'winit' });
    expect(answer.attempts[0]).toMatchObject({ source: 'winit', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has wording and either an instant with its offset or a wall clock without one.
    expect(answer.result.events.every((event) => event.description && (event.time
      ? /[+-]\d{2}:\d{2}$/.test(String(event.time)) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    // WINIT's own warehouse scans carry its codes.
    expect(answer.result.events.some((event) => event.provider_code)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.WINIT_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.WINIT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.WINIT_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.WINIT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

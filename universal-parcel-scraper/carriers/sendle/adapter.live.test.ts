import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Sendle live retrieval', () => {
  it.skipIf(!process.env.SENDLE_TRACKING_NUMBER)('answers the security check and retrieves the requested parcel', async () => {
    const result = await direct().track({ number: process.env.SENDLE_TRACKING_NUMBER! });
    expect(result.current_stage).toBeTruthy();
    expect(result.events!.length).toBeGreaterThan(0);
    // The tracker's clocks carry no offset; they stay its wall clocks.
    expect(result.events!.every((event) => event.description && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(result.last_update_local).toBe(result.events![0]!.local_time);
  }, 45_000);

  it.skipIf(!process.env.SENDLE_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.SENDLE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.SENDLE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SENDLE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

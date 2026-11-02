import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CCFS live retrieval', () => {
  it.skipIf(!process.env.CCFS_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CCFS_TRACKING_NUMBER!, carrier: 'ccfs' });
    expect(answer).toMatchObject({ carrier: 'ccfs', source: 'ccfs' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ccfs', kind: 'ok' });
    expect(answer.result).toMatchObject({ last_update: null });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event has its wording and a wall clock, never an invented offset.
    expect(answer.result.events.every((event) => event.description && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    // No place keeps a ZIP code, and nobody is named.
    expect(answer.result.events.every((event) => !/\d/.test(event.location ?? ''))).toBe(true);
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.CCFS_TRACKING_NUMBER)('recognizes the requested number', async () => {
    await expect(direct().recognize!(process.env.CCFS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CCFS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CCFS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CCFS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

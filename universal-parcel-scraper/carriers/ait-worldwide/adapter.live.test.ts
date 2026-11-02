import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('AIT Worldwide Logistics live retrieval', () => {
  it.skipIf(!process.env.AIT_WORLDWIDE_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.AIT_WORLDWIDE_TRACKING_NUMBER!, carrier: 'ait-worldwide' });
    expect(answer).toMatchObject({ carrier: 'ait-worldwide', source: 'ait-worldwide' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ait-worldwide', kind: 'ok' });
    expect(answer.result).toMatchObject({ last_update: null });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event has its code, its wording and a wall clock, never an invented offset or a place.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.time === undefined
      && event.location === undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    // Appointments are estimates, and nobody is named.
    expect(answer.result.events.some((event) => /APPOINTMENT/i.test(event.description ?? ''))).toBe(false);
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 75_000);

  it.skipIf(!process.env.AIT_WORLDWIDE_TRACKING_NUMBER)('recognizes the requested number', async () => {
    await expect(direct().recognize!(process.env.AIT_WORLDWIDE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.AIT_WORLDWIDE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.AIT_WORLDWIDE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.AIT_WORLDWIDE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

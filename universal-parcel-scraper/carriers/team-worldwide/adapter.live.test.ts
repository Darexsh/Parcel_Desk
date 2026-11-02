import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Team Worldwide live retrieval', () => {
  it.skipIf(!process.env.TEAM_WORLDWIDE_TRACKING_NUMBER)('retrieves the history of the requested bill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TEAM_WORLDWIDE_TRACKING_NUMBER!, carrier: 'team-worldwide' });
    expect(answer).toMatchObject({ carrier: 'team-worldwide', source: 'team-worldwide' });
    expect(answer.attempts[0]).toMatchObject({ source: 'team-worldwide', kind: 'ok' });
    expect(answer.result).toMatchObject({ last_update: null });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event has its code, its wording and a wall clock, never an invented offset.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    // Nobody who signed or booked is named, and remarks are left out.
    expect(answer.result.events.some((event) => /SIGNED FOR BY|APPT FOR \w+ SCHED .|\bFRE\b|\bCMT\b/.test(`${event.description} ${event.provider_code}`))).toBe(false);
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.TEAM_WORLDWIDE_TRACKING_NUMBER)('recognizes the requested bill', async () => {
    await expect(direct().recognize!(process.env.TEAM_WORLDWIDE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.TEAM_WORLDWIDE_UNKNOWN_NUMBER)('reads an unknown bill as not found', async () => {
    await expect(direct().track({ number: process.env.TEAM_WORLDWIDE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.TEAM_WORLDWIDE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

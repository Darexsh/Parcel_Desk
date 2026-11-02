import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Team Global Express live retrieval', () => {
  it.skipIf(!process.env.TEAM_GLOBAL_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.TEAM_GLOBAL_EXPRESS_TRACKING_NUMBER!, carrier: 'team-global-express' });
    expect(answer).toMatchObject({ carrier: 'team-global-express', source: 'team-global-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'team-global-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the clock the page shows, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.TEAM_GLOBAL_EXPRESS_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.TEAM_GLOBAL_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.TEAM_GLOBAL_EXPRESS_NZ_TRACKING_NUMBER)('retrieves a New Zealand consignment from Fast Tracker on New Zealand time', async () => {
    const result = await direct().track({ number: process.env.TEAM_GLOBAL_EXPRESS_NZ_TRACKING_NUMBER! });
    expect(result).toMatchObject({ timezone: 'Pacific/Auckland', destination_country: 'NZ' });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+1[23]:00$/.test(String(event.time)) && event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TEAM_GLOBAL_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TEAM_GLOBAL_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

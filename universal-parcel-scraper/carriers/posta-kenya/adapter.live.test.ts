import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A scan placed in Kenya on Nairobi's clock, or another place's wall clock, to the minute.
const CLOCK = (event: { time?: unknown; local_time?: unknown }) => typeof event.time === 'string'
  ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+03:00$/.test(event.time) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time));

describe('Posta Kenya live retrieval', () => {
  it.skipIf(!process.env.POSTA_KENYA_TRACKING_NUMBER)('retrieves the requested item’s scans with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.POSTA_KENYA_TRACKING_NUMBER!, carrier: 'posta-kenya' });
    expect(answer).toMatchObject({ carrier: 'posta-kenya', source: 'posta-kenya' });
    // The destination's post can be asked after it, about an item delivered abroad.
    expect(answer.attempts[0]).toMatchObject({ source: 'posta-kenya', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && CLOCK(event))).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.POSTA_KENYA_INBOUND_NUMBER)('retrieves the scans of mail from abroad', async () => {
    const result = await direct().track({ number: process.env.POSTA_KENYA_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.destination_country).toBe('KE');
  }, 45_000);

  it.skipIf(!process.env.POSTA_KENYA_UNKNOWN_NUMBER)('reads a code the tracker has no information for as not found', async () => {
    await expect(direct().track({ number: process.env.POSTA_KENYA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

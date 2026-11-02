import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shree Tirupati Courier live retrieval', () => {
  it.skipIf(!process.env.TIRUPATI_COURIER_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.TIRUPATI_COURIER_TRACKING_NUMBER!, carrier: 'tirupati-courier' });
    expect(answer).toMatchObject({ carrier: 'tirupati-courier', source: 'tirupati-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tirupati-courier', kind: 'ok' });
    const events = answer.result.events;
    expect(events.length).toBeGreaterThan(0);
    // The booking is an instant read in Indian time; the jobs and the status line keep their day.
    expect(events.at(-1)).toMatchObject({ description: 'Booked', stage: 'accepted' });
    expect(String(events.at(-1)!.time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(events.slice(0, -1).every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    // The offices' phone numbers to call stay out.
    expect(JSON.stringify(answer.result)).not.toMatch(/Contact To|For Any Query/);
  }, 45_000);

  it.skipIf(!process.env.TIRUPATI_COURIER_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.TIRUPATI_COURIER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.TIRUPATI_COURIER_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TIRUPATI_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

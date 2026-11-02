import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('A&B Courier live retrieval', () => {
  it.skipIf(!process.env.AB_COURIER_TRACKING_NUMBER)('retrieves the status of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AB_COURIER_TRACKING_NUMBER!, carrier: 'ab-courier' });
    expect(answer).toMatchObject({ carrier: 'ab-courier', source: 'ab-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ab-courier', kind: 'ok' });
    expect(answer.result).toMatchObject({ summary_only: true });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.last_status_text).toBeTruthy();
    // Every event is the pickup or the delivery, with an instant in Toronto time or a wall clock, never an invented offset.
    expect(answer.result.events.every((event) => ['Picked Up', 'Delivered'].includes(String(event.description))
      && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-0[45]:00$/.test(String(event.time))
        || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))).toBe(true);
    // Nobody is named.
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.AB_COURIER_TRACKING_NUMBER)('recognizes the requested order', async () => {
    await expect(direct().recognize!(process.env.AB_COURIER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.AB_COURIER_UNKNOWN_NUMBER)('reads an unknown order as not found', async () => {
    await expect(direct().track({ number: process.env.AB_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

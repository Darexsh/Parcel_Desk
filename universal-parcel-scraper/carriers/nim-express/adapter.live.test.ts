import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Nim Express live retrieval', () => {
  it.skipIf(!process.env.NIM_EXPRESS_TRACKING_NUMBER)('retrieves the timeline of the requested bill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.NIM_EXPRESS_TRACKING_NUMBER!, carrier: 'nim-express' });
    expect(answer).toMatchObject({ carrier: 'nim-express', source: 'nim-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'nim-express', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and an instant at Bangkok's offset.
    expect(answer.result.events.every((event) => event.description && event.local_time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.last_update).toBe(answer.result.events[0]!.time);
    // A branch is named without its code, and nobody is named.
    expect(answer.result.events.every((event) => !/^\d/.test(event.location ?? ''))).toBe(true);
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.NIM_EXPRESS_TRACKING_NUMBER)('recognizes the requested bill', async () => {
    await expect(direct().recognize!(process.env.NIM_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.NIM_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.NIM_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.NIM_EXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

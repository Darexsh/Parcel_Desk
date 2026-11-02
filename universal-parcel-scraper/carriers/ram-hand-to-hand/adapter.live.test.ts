import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('RAM live retrieval', () => {
  it.skipIf(!process.env.RAM_HAND_TO_HAND_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.RAM_HAND_TO_HAND_TRACKING_NUMBER!, carrier: 'ram-hand-to-hand' });
    expect(answer).toMatchObject({ carrier: 'ram-hand-to-hand', source: 'ram-hand-to-hand' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ram-hand-to-hand', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset, and no receiver.
    expect(answer.result.events.every((event) => event.description && !event.time && !/RECEIVED BY|#/i.test(event.description)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.RAM_HAND_TO_HAND_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.RAM_HAND_TO_HAND_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.RAM_HAND_TO_HAND_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.RAM_HAND_TO_HAND_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Paperfly live retrieval', () => {
  it.skipIf(!process.env.PAPERFLY_TRACKING_NUMBER)('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PAPERFLY_TRACKING_NUMBER!, carrier: 'paperfly' });
    expect(answer).toMatchObject({ carrier: 'paperfly', source: 'paperfly' });
    expect(answer.attempts[0]).toMatchObject({ source: 'paperfly', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    // Every line is Dhaka's wall clock, given at Bangladesh's offset, without the rider's phone.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+06:00$/.test(String(event.time))
      && !/\d{9}|Call\s*:/i.test(event.description))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PAPERFLY_TRACKING_NUMBER)('recognizes the requested order', async () => {
    await expect(direct().recognize!(process.env.PAPERFLY_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.PAPERFLY_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PAPERFLY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

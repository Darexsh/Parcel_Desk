import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Micro Express live retrieval', () => {
  it.skipIf(!process.env.MICRO_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.MICRO_EXPRESS_TRACKING_NUMBER!, carrier: 'micro-express' });
    expect(answer).toMatchObject({ carrier: 'micro-express', source: 'micro-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'micro-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has an instant at Melbourne's offset.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+1[01]:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
    expect(answer.result.events.some((event) => event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.MICRO_EXPRESS_TRACKING_NUMBER)('recognizes the requested number', async () => {
    await expect(direct().recognize!(process.env.MICRO_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.MICRO_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MICRO_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

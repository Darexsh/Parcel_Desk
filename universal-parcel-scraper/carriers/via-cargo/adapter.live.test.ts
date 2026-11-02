import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Via Cargo live retrieval', () => {
  it.skipIf(!process.env.VIA_CARGO_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.VIA_CARGO_TRACKING_NUMBER!, carrier: 'via-cargo' });
    expect(answer).toMatchObject({ carrier: 'via-cargo', source: 'via-cargo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'via-cargo', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is Argentina's wall clock read in Buenos Aires time, with its type and branch.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.location
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-03:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.at(-1)).toMatchObject({ provider_code: 'ALTA', stage: 'accepted' });
  }, 45_000);

  it.skipIf(!process.env.VIA_CARGO_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.VIA_CARGO_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.VIA_CARGO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.VIA_CARGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

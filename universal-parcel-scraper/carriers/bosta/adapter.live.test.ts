import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// The service allows ten lookups per address in five minutes, so this file makes three.
describe('Bosta live retrieval', () => {
  it.skipIf(!process.env.BOSTA_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BOSTA_TRACKING_NUMBER!, carrier: 'bosta' });
    expect(answer).toMatchObject({ carrier: 'bosta', source: 'bosta' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bosta', kind: 'ok' });
    if (answer.result.destination_country) expect(answer.result.destination_country).toMatch(/^(?:EG|SA)$/);
    // An older shipment can keep only its current state.
    if (!answer.result.summary_only) expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(event.time))
      && Date.parse(String(event.time)) <= Date.now())).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BOSTA_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.BOSTA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.BOSTA_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BOSTA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

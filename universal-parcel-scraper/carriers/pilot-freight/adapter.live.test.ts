import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pilot Freight Services live retrieval', () => {
  it.skipIf(!process.env.PILOT_FREIGHT_TRACKING_NUMBER)('retrieves the history of the requested pro number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PILOT_FREIGHT_TRACKING_NUMBER!, carrier: 'pilot-freight' });
    expect(answer).toMatchObject({ carrier: 'pilot-freight', source: 'pilot-freight' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pilot-freight', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event has its wording, code and clock: an instant with its offset, or a wall clock.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(String(event.time))
        || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    // Nobody is named, and no masked party or document link is kept.
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(JSON.stringify(answer.result)).not.toMatch(/\*\*\*\*|SignedForByName|PilotDocumentView|imaging\./);
  }, 45_000);

  it.skipIf(!process.env.PILOT_FREIGHT_TRACKING_NUMBER)('recognizes the requested pro number', async () => {
    await expect(direct().recognize!(process.env.PILOT_FREIGHT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.PILOT_FREIGHT_UNKNOWN_NUMBER)('reads an unknown pro number as not found', async () => {
    await expect(direct().track({ number: process.env.PILOT_FREIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

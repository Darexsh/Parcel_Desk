import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('AllcargoGATI live retrieval', () => {
  it.skipIf(!process.env.GATI_TRACKING_NUMBER)('retrieves the history of the requested docket with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GATI_TRACKING_NUMBER!, carrier: 'gati' });
    expect(answer).toMatchObject({ carrier: 'gati', source: 'gati' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gati', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is read in Indian time and kept as an instant.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.GATI_TRACKING_NUMBER)('recognizes the requested docket', async () => {
    await expect(direct().recognize!(process.env.GATI_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.GATI_UNKNOWN_NUMBER)('reads an unknown docket as not found', async () => {
    await expect(direct().track({ number: process.env.GATI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

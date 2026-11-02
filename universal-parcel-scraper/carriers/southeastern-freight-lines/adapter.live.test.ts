import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Southeastern Freight Lines live retrieval', () => {
  it.skipIf(!process.env.SOUTHEASTERN_FREIGHT_LINES_TRACKING_NUMBER)('retrieves the history of the requested PRO with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.SOUTHEASTERN_FREIGHT_LINES_TRACKING_NUMBER!, carrier: 'southeastern-freight-lines' });
    expect(answer).toMatchObject({ carrier: 'southeastern-freight-lines', source: 'southeastern-freight-lines' });
    expect(answer.attempts[0]).toMatchObject({ source: 'southeastern-freight-lines', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant with its service center's offset, a place and a code.
    expect(answer.result.events.every((event) => event.description && event.location && event.provider_code && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.stage)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.SOUTHEASTERN_FREIGHT_LINES_TRACKING_NUMBER)('recognizes the requested PRO', async () => {
    await expect(direct().recognize!(process.env.SOUTHEASTERN_FREIGHT_LINES_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.SOUTHEASTERN_FREIGHT_LINES_UNKNOWN_NUMBER)('reads an unknown PRO as not found', async () => {
    await expect(direct().track({ number: process.env.SOUTHEASTERN_FREIGHT_LINES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Rivigo live retrieval', () => {
  it.skipIf(!process.env.RIVIGO_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.RIVIGO_TRACKING_NUMBER!, carrier: 'rivigo' });
    expect(answer).toMatchObject({ carrier: 'rivigo', source: 'rivigo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'rivigo', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant in UTC with its wording.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.RIVIGO_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.RIVIGO_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.RIVIGO_WITHHELD_NUMBER)('reads a consignment whose tracking Rivigo withholds as inconclusive', async () => {
    await expect(direct().track({ number: process.env.RIVIGO_WITHHELD_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'tracking_withheld' });
  });

  it.skipIf(!process.env.RIVIGO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.RIVIGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.RIVIGO_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

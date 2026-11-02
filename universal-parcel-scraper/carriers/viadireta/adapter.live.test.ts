import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ViaDireta live retrieval', () => {
  it.skipIf(!process.env.VIADIRETA_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const number = process.env.VIADIRETA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'viadireta' });
    expect(answer).toMatchObject({ carrier: 'viadireta', source: 'viadireta', attempts: [{ source: 'viadireta', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every movement has wording and a wall clock to the second.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))
      .toBe(true);
  }, 45_000);

  it.skipIf(!process.env.VIADIRETA_TRACKING_NUMBER)('recognizes the requested shipment', async () => {
    await expect(direct().recognize!(process.env.VIADIRETA_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  // The page gives a number it cannot show the notice a failing lookup gets, so the answer stays open.
  it.skipIf(!process.env.VIADIRETA_UNKNOWN_NUMBER)('leaves a number the page cannot show inconclusive', async () => {
    await expect(direct().track({ number: process.env.VIADIRETA_UNKNOWN_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'ViaDireta could not show the shipment' });
  }, 45_000);
});

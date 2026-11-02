import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Inter Rapidísimo live retrieval', () => {
  it.skipIf(!process.env.INTERRAPIDISIMO_TRACKING_NUMBER)('retrieves the milestones of the requested guide with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.INTERRAPIDISIMO_TRACKING_NUMBER!, carrier: 'interrapidisimo' });
    expect(answer).toMatchObject({ carrier: 'interrapidisimo', source: 'interrapidisimo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'interrapidisimo', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone is read on Colombia's clock.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-05:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.at(-1)).toMatchObject({ description: 'Recibimos tu envío', stage: 'accepted' });
  }, 45_000);

  it.skipIf(!process.env.INTERRAPIDISIMO_TRACKING_NUMBER)('recognizes the requested guide', async () => {
    await expect(direct().recognize!(process.env.INTERRAPIDISIMO_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.INTERRAPIDISIMO_UNKNOWN_NUMBER)('reads an unknown guide as not found', async () => {
    await expect(direct().track({ number: process.env.INTERRAPIDISIMO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

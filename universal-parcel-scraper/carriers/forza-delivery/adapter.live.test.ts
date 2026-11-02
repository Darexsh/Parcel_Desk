import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const env = { FORZA_DELIVERY_BROWSER_WS_ENDPOINT: process.env.FORZA_DELIVERY_BROWSER_WS_ENDPOINT };

describe('Forza Delivery live retrieval', () => {
  it.skipIf(!process.env.FORZA_DELIVERY_TRACKING_NUMBER)('retrieves the history of the requested guía with providers disabled', async () => {
    const answer = await createTracker({ providers: [], env }).track({ number: process.env.FORZA_DELIVERY_TRACKING_NUMBER!, carrier: 'forza-delivery' });
    expect(answer).toMatchObject({ carrier: 'forza-delivery', source: 'forza-delivery' });
    expect(answer.attempts[0]).toMatchObject({ source: 'forza-delivery', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock to the second, without an offset, and its stage id.
    expect(answer.result.events.every((event) => event.description && !event.time && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.FORZA_DELIVERY_TRACKING_NUMBER || env.FORZA_DELIVERY_BROWSER_WS_ENDPOINT)('recognizes the requested guía over HTTP', async () => {
    await expect(direct().recognize!(process.env.FORZA_DELIVERY_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.FORZA_DELIVERY_UNKNOWN_NUMBER)('reads an unknown guía as not found', async () => {
    const configured = adapter({ recorder: NOOP_RECORDER, env, trawl: null, browserExecutablePath: null });
    await expect(configured.track({ number: process.env.FORZA_DELIVERY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

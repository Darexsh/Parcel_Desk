import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Serpost live retrieval', () => {
  it.skipIf(!process.env.SERPOST_TRACKING_NUMBER)('retrieves the history of the requested item with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SERPOST_TRACKING_NUMBER!, carrier: 'serpost' });
    expect(answer).toMatchObject({ carrier: 'serpost', source: 'serpost' });
    expect(answer.attempts[0]).toMatchObject({ source: 'serpost', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is a Peruvian office's clock, read on Lima time.
    expect(answer.result.events.every((event) => event.description && /-05:00$/.test(String(event.time)) && event.provider_code)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.SERPOST_TRACKING_NUMBER)('recognizes the requested item', async () => {
    await expect(direct().recognize!(process.env.SERPOST_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.SERPOST_INBOUND_NUMBER)('retrieves mail from abroad that Serpost delivers in Peru', async () => {
    const result = await direct().track({ number: process.env.SERPOST_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => /-05:00$/.test(String(event.time)))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.SERPOST_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.SERPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pullman Cargo live retrieval', () => {
  it.skipIf(!process.env.PULLMAN_CARGO_TRACKING_NUMBER)('retrieves the history of the requested ODT with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PULLMAN_CARGO_TRACKING_NUMBER!, carrier: 'pullman-cargo' });
    expect(answer).toMatchObject({ carrier: 'pullman-cargo', source: 'pullman-cargo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pullman-cargo', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant in UTC.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.at(-1)).toMatchObject({ description: 'Venta Creada', stage: 'accepted' });
  }, 30_000);

  it.skipIf(!process.env.PULLMAN_CARGO_TRACKING_NUMBER)('recognizes the requested ODT', async () => {
    await expect(direct().recognize!(process.env.PULLMAN_CARGO_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.PULLMAN_CARGO_UNKNOWN_NUMBER)('reads an unknown ODT as not found', async () => {
    await expect(direct().track({ number: process.env.PULLMAN_CARGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

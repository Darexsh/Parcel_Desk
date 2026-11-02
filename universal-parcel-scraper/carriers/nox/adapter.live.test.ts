import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('nox live retrieval', () => {
  it.skipIf(!process.env.NOX_TRACKING_NUMBER)('retrieves the history of the requested barcode with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.NOX_TRACKING_NUMBER!, carrier: 'nox' });
    expect(answer).toMatchObject({ carrier: 'nox', source: 'nox' });
    expect(answer.attempts[0]).toMatchObject({ source: 'nox', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is dated in Germany.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/.test(String(event.time)))).toBe(true);
    await expect(direct().recognize!(process.env.NOX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.NOX_UNKNOWN_NUMBER)('reads an unknown barcode as not found', async () => {
    await expect(direct().track({ number: process.env.NOX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.NOX_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Poșta Română live retrieval', () => {
  it.skipIf(!process.env.POSTA_ROMANA_TRACKING_NUMBER)('retrieves dated history for the requested item with providers disabled', async () => {
    const number = process.env.POSTA_ROMANA_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'posta-romana' });
    expect(answer).toMatchObject({ carrier: 'posta-romana', source: 'posta-romana', attempts: [{ source: 'posta-romana', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => /[+-]0[23]:00$/.test(event.time ?? '') && event.description)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.POSTA_ROMANA_INBOUND_NUMBER)('retrieves the Romanian scans of mail from abroad', async () => {
    const result = await direct().track({ number: process.env.POSTA_ROMANA_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.POSTA_ROMANA_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.POSTA_ROMANA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.POSTA_ROMANA_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

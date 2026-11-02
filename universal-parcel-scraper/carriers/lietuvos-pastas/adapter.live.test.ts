import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Lietuvos paštas live retrieval', () => {
  it.skipIf(!process.env.LIETUVOS_PASTAS_TRACKING_NUMBER)('retrieves the requested parcel with providers disabled', async () => {
    const number = process.env.LIETUVOS_PASTAS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'lietuvos-pastas' });
    expect(answer).toMatchObject({ carrier: 'lietuvos-pastas', source: 'lietuvos-pastas', attempts: [{ source: 'lietuvos-pastas', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.provider_code)).toBe(true);
    // English wording, whatever language the client would ask for by default.
    expect(answer.result.events.some(event => /parcel|label/i.test(event.description ?? ''))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.LIETUVOS_PASTAS_UNKNOWN_NUMBER)('reads the empty mail for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LIETUVOS_PASTAS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.LIETUVOS_PASTAS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});

import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';

const { GLS_PL_TRACKING_NUMBER: number, GLS_PL_POSTCODE: postcode, GLS_PL_UNKNOWN_NUMBER: unknown } = process.env;
const direct = () => new AdapterRegistry(REGISTRY, { recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null }).for('gls-pl')!;

describe('GLS Poland live retrieval', () => {
  it.skipIf(!number)('finds the requested parcel in the overview, without its postcode', async () => {
    await expect(direct().recognize!(number!)).resolves.toEqual({ known: true });
  });

  it.skipIf(!number || !postcode)('retrieves the history with the delivery postcode, providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'gls-pl', postcode: postcode! });
    expect(answer).toMatchObject({ carrier: 'gls-pl', source: 'gls-pl' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && /[+-]\d{2}:\d{2}$/.test(String(event.time)))).toBe(true);
  }, 75_000);

  it.skipIf(!unknown)('reads an unknown number as not found before any postcode is sent', async () => {
    await expect(direct().track({ number: unknown!, postcode: '00-001' })).rejects.toMatchObject({ kind: 'not_found', status: 404 });
  });
});

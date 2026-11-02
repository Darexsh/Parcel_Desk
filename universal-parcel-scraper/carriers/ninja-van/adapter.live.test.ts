import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const countries = ['SG', 'MY', 'ID', 'PH', 'TH', 'VN'] as const;

describe('Ninja Van live tracking', () => {
  it.skipIf(!process.env.NINJA_VAN_TRACKING_NUMBER)('returns identity-bound public history', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.NINJA_VAN_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.NINJA_VAN_UNKNOWN_NUMBER)('identifies an explicitly absent parcel', async () => {
    await expect(instance().track({ number: process.env.NINJA_VAN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.NINJA_VAN_INDETERMINATE_NUMBER)('keeps unavailable retained history inconclusive', async () => {
    await expect(instance().track({ number: process.env.NINJA_VAN_INDETERMINATE_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(instance().recognize!(process.env.NINJA_VAN_INDETERMINATE_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  for (const country of countries) {
    const positive = process.env[`NINJA_VAN_${country}_TRACKING_NUMBER`];
    const unknown = process.env[`NINJA_VAN_${country}_UNKNOWN_NUMBER`];
    it.skipIf(!positive)(`returns ${country} identity-bound public history`, async () => {
      const result = normalizeCarrierResult(await instance().track({ number: positive! }));
      expect(result.events?.length).toBeGreaterThan(0);
      await expect(instance().recognize!(positive!)).resolves.toMatchObject({ known: true });
    });
    it.skipIf(!unknown)(`identifies an explicitly absent ${country} parcel`, async () => {
      await expect(instance().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
    });
  }
});

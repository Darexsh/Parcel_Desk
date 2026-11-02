import { describe, expect, it } from 'vitest';
import { DPDTracker } from '../dpd/adapter.js';
import { DpdDeAppClient } from './app.js';

const number = (process.env.DPD_DE_TRACKING_NUMBER ?? '').trim();
const postcode = (process.env.DPD_DE_POSTCODE ?? '').trim();

describe('DPD Germany live guest tracking', () => {

  it.runIf(Boolean(number))('returns caller-supplied German shipment history', async () => {
    const result = await new DPDTracker({ country: 'DE', timeoutMs: 15_000, budgetMs: 20_000 }).fetch(number);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.status).not.toBe('unknown');
    expect(result).not.toHaveProperty('receiver');
  }, 25_000);

  it.runIf(Boolean(number))('returns the same parcel from the app service and reuses its session', async () => {
    const app = new DpdDeAppClient();
    const first = await app.track(number, { signal: AbortSignal.timeout(110_000), timeoutMs: 110_000 });
    expect(first.events?.length).toBeGreaterThan(0);
    expect(first.status).not.toBe('unknown');
    expect(JSON.stringify(first)).not.toMatch(/receiver|recipient|street|phone/i);
    const started = performance.now();
    const again = await app.track(number, { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 });
    expect(again.events).toEqual(first.events);
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 130_000);

  it.runIf(Boolean(number && postcode))('verifies the recipient postcode through the app service', async () => {
    const result = await new DpdDeAppClient().track(number, { signal: AbortSignal.timeout(110_000), timeoutMs: 110_000, postcode });
    expect(result.dpd_postcode_verified).toBe(true);
    expect(result.events?.length).toBeGreaterThan(0);
  }, 130_000);

  it.runIf(Boolean(number))('recognizes the German parcel from the guest API', async () => {
    await expect(new DPDTracker({ country: 'DE', timeoutMs: 15_000, budgetMs: 20_000 }).recognizes(number)).resolves.toBe(true);
  }, 25_000);
});

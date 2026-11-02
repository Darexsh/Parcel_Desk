import { describe, expect, it } from 'vitest';
import { fetchCainiao } from './adapter.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { createTracker } from '../../facade/index.js';

// A validly shaped number that was never issued: the endpoint answers with an
// empty external module, which is Cainiao's "unknown shipment".
const CAINIAO_WRONG_NUMBER = 'LP00000000000000';

describe('Cainiao live wrong-number handling', () => {
  it('maps the official empty external result to a clean 404', async () => {
    await expect(fetchCainiao(CAINIAO_WRONG_NUMBER)).rejects.toMatchObject({
      name: 'NotFoundError',
      status: 404,
      message: 'Cainiao could not locate the shipment',
    });
  });

  it('reads a home-delivery number neither Cainiao tracker knows as inconclusive', async () => {
    await expect(fetchCainiao('DOFR0000000000000HD')).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});

describe('Cainiao Express live lookup', () => {
  it.skipIf(!process.env.CAINIAO_EXPRESS_TRACKING_NUMBER)('reads a partner\'s home-delivery parcel from Cainiao Express', async () => {
    const result = await fetchCainiao(process.env.CAINIAO_EXPRESS_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => /[+-]\d{2}:\d{2}$|Z$/.test(event.time ?? ''))).toBe(true);
  });
});

describe('Cainiao live handoff evidence', () => {
  it.skipIf(!process.env.CAINIAO_TRACKING_NUMBER)('detects a Cainiao shipment and uses its direct adapter', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CAINIAO_TRACKING_NUMBER! });
    expect(answer.carrier).toBe('aliexpress');
    expect(answer.source).toBe('aliexpress');
    expect(answer.result.events.length).toBeGreaterThan(0);
  });

  // Public shipment reports already recorded with provenance in numbers.json.
  it('retains the partner reference from a public corpus example through normalization', async () => {
    // Cainiao names the partner number it handed this parcel over with.
    const result = normalizeCarrierResult(await fetchCainiao('AP00821064969338'));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.delivery_tracking_number).toMatch(/^[A-Z0-9]{8,30}$/);
    expect(result.delivery_tracking_number).not.toBe('AP00821064969338');
    expect(result.destination_country_name).toBeTypeOf('string');
  });

  it('names no partner for the public corpus example Cainiao renumbers under a number of its own', async () => {
    // Its latest number is another CNG number, which names no partner.
    const result = normalizeCarrierResult(await fetchCainiao('CNG00798678939847'));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.destination_country_name).toBeTypeOf('string');
  });
});

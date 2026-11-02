import { afterEach, expect, it, vi } from 'vitest';
import { amazonShippingEligibility } from './eligibility.js';
import { AmazonShippingTracker, AmazonShippingHistoryExpiredError, AmazonShippingNotFoundError } from './adapter.js';

afterEach(() => vi.restoreAllMocks());

it('distinguishes a missing parcel from expired history through stable error reasons', async () => {
  const fetch = vi.spyOn(AmazonShippingTracker.prototype, 'fetch');
  fetch.mockResolvedValueOnce({ status: 'in_transit' })
    .mockRejectedValueOnce(new AmazonShippingHistoryExpiredError())
    .mockRejectedValueOnce(new AmazonShippingNotFoundError())
    .mockRejectedValueOnce(new Error('Transport failed'));
  await expect(amazonShippingEligibility('FR0000000001')).resolves.toBe('available');
  await expect(amazonShippingEligibility('FR0000000001')).resolves.toBe('expired');
  await expect(amazonShippingEligibility('FR0000000001')).resolves.toBe('not-found');
  await expect(amazonShippingEligibility('FR0000000001')).rejects.toThrow('Transport failed');
  expect(new AmazonShippingHistoryExpiredError()).toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
  expect(new AmazonShippingNotFoundError()).toMatchObject({ kind: 'not_found', reason: 'shipment_not_found' });
});

it('refuses a placeholder number without asking Amazon', async () => {
  const fetch = vi.spyOn(AmazonShippingTracker.prototype, 'fetch');
  for (const number of ['UK1234567890', 'uk 123 456 7890', 'FR0000000000', 'TBA000000000000']) {
    await expect(amazonShippingEligibility(number), number).rejects.toMatchObject({
      kind: 'invalid_input', provider: 'amazon-shipping', reason: 'placeholder_number',
    });
  }
  expect(fetch).not.toHaveBeenCalled();
});

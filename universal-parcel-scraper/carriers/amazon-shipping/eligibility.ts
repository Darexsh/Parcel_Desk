import { AmazonShippingTracker, type AmazonShippingOptions } from './adapter.js';
import type { TrackingContext } from '../../core/adapter/index.js';
import { isPlaceholderNumber } from '../../core/detection/index.js';
import { CarrierError, InvalidInputError } from '../../core/errors/index.js';

/**
 * A public eligibility check; transport errors remain errors for the consumer to report. It asks
 * Amazon's tracker without the adapter registry, so it refuses placeholder numbers itself, as the
 * registry does: trackers show other people's shipments under them.
 */
export async function amazonShippingEligibility(
  number: string, options: AmazonShippingOptions = {}, context: TrackingContext = {},
): Promise<'available' | 'expired' | 'not-found'> {
  if (isPlaceholderNumber(number)) {
    throw new InvalidInputError('amazon-shipping', 'A placeholder number is not looked up', { reason: 'placeholder_number' });
  }
  try {
    await new AmazonShippingTracker({ ...options, timeoutMs: options.timeoutMs ?? 5_000 }).fetch(number, context);
    return 'available';
  } catch (error) {
    if (error instanceof CarrierError && error.reason === 'history_expired') return 'expired';
    if (error instanceof CarrierError && error.reason === 'shipment_not_found') return 'not-found';
    throw error;
  }
}

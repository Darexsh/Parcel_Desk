import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { placedWording } from './place.js';
import { cainiaoActionCode, cainiaoActionStage } from './status.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/**
 * A scan stored with Cainiao's placeholder wording, "Carrier update", and now
 * worded as its step: the same action code and place.
 */
export function replacesCainiaoPlaceholder(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const code = cainiaoActionCode(incoming.providerCode);
  return code !== '' && code === cainiaoActionCode(stored.providerCode)
    && normalized(stored.description) === 'carrier update'
    && !['', 'carrier update'].includes(normalized(incoming.description))
    && normalized(incoming.location) === normalized(stored.location);
}

// A scan stored while its town was still part of the wording, "[Bordeaux] Out for
// delivery" or "[USA,Example City] Arrived" without a location, is the same scan as
// "Out for delivery" in Bordeaux or "Arrived" at "Example City, USA", and one stored
// with the placeholder is the same scan worded as its step.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'aliexpress', storedSources: ['aliexpress'], requireProviderCode: false,
  matchEachScan: true,
  matches(incoming, stored) {
    const wording = normalized(incoming.description);
    const location = normalized(incoming.location);
    const moved = placedWording(stored.description, new Set());
    const movedLocation = Boolean(location) && !normalized(stored.location)
      && (normalized(stored.description) === `[${location}] ${wording}`
        || (normalized(moved.location) === location && normalized(moved.description) === wording));
    if (replacesCainiaoPlaceholder(incoming, stored)) return true;
    if (!wording || ['', 'unknown'].includes(incoming.stage)) return false;
    if (incoming.stage === stored.stage) return movedLocation;

    // Correct only the old adapter's coarse stages, with the same action,
    // wording and place. The consumer also requires a unique same-time match.
    const code = cainiaoActionCode(incoming.providerCode);
    if (!code || code !== cainiaoActionCode(stored.providerCode)
      || incoming.stage !== cainiaoActionStage(code)) return false;
    const correction = (['customs', 'accepted'].includes(incoming.stage) && stored.stage === 'in_transit')
      || (incoming.stage === 'ready_for_pickup' && stored.stage === 'out_for_delivery')
      || (incoming.stage === 'out_for_delivery' && stored.stage === 'ready_for_pickup');
    return correction && (movedLocation || (wording === normalized(stored.description)
      && location === normalized(stored.location)));
  },
};

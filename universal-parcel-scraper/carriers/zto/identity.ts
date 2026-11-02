import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { ztoEnglish } from './status.js';

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** A trace stored in its Chinese label before the adapter showed its English: the same type and place. */
function sameInEnglish(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const english = ztoEnglish(stored.providerCode, stored.description);
  return english !== undefined && normalized(english) === normalized(incoming.description)
    && incoming.providerCode === stored.providerCode && incoming.location.trim() === stored.location.trim();
}

// Rows stored in ZTO's Chinese labels are taken over by the English row at the same instant.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'zto', storedSources: ['zto'], requireProviderCode: false, matchEachScan: true, matches: sameInEnglish,
};

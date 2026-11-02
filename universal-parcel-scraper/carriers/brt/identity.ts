import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';
import { isBrtCarrierDepot } from './depot.js';
import { brtEnglishLabel } from './status.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/** One scan labelled on BRT's Italian page and on its English one, at the same place. */
function translated(italian: SameInstantScan, english: SameInstantScan): boolean {
  return brtEnglishLabel(italian.description)?.toLowerCase() === wording(english)
    && italian.location.trim() === english.location.trim() && !italian.providerCode && !english.providerCode;
}

/**
 * A scan stored at a depot named by carriers alone loses that place and keeps
 * its row. BRT's collection there, stored as the acceptance, is now its
 * hand-over from the partner, in transit. A scan labelled in Italian takes
 * over the row stored with its English label, and the reverse.
 */
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'brt', storedSources: ['brt'], requireProviderCode: false, matchEachScan: true,
  matches: (incoming, stored) => sameScan(incoming, stored) || translated(incoming, stored) || translated(stored, incoming)
    || matchesDroppedLocation(incoming,
      stored.stage === 'accepted' && incoming.stage === 'in_transit' ? { ...stored, stage: 'in_transit' } : stored, isBrtCarrierDepot),
};

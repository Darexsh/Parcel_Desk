import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';

// Offices that name a system or a unit with no address, not where the scan
// happened: the transshipment terminal of a scan in transport, in English and
// Polish, the sender platform that sends item data, and the international
// postal system that relays a partner's scans.
const SYSTEMS = new Set(['transshipment', 'terminal przeładunkowy', 'elektroniczny nadawca', 'international postal system']);

/** Whether an office name names one of Poczta Polska's systems rather than a place. */
export function isPocztaPolskaSystemOffice(name: string): boolean {
  return SYSTEMS.has(name.replace(/\s+/g, ' ').trim().toLocaleLowerCase('pl-PL'));
}

/**
 * The service words a scan in Polish or English, as its reader reads: with the same
 * code at the same office, it is the scan stored in the other language.
 */
function reworded(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return incoming.providerCode !== '' && incoming.providerCode === stored.providerCode
    && incoming.location.trim() === stored.location.trim();
}

// Scans stored with a system as their location lose it and keep their row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'poczta-polska', storedSources: ['poczta-polska'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => reworded(incoming, stored)
    || matchesDroppedLocation(incoming, stored, isPocztaPolskaSystemOffice),
};

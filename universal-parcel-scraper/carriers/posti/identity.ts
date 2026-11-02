import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';

const label = (location: string) => location.replace(/\s+/g, ' ').trim().toLocaleUpperCase('fi-FI');

/**
 * Whether a scan's town is Posti's "ULKOMAILLA" ("abroad"), which it gives,
 * untranslated, to scans outside Finland. It names no place, and the public
 * reply carries no country to put in its stead.
 */
export function isPostiAbroadLabel(location: string): boolean {
  return label(location) === 'ULKOMAILLA';
}

/** Whether a scan's town names no place: the abroad label, or "Posti kuljetus" ("Posti transport") on a scan between two sites. */
export function isPostiPlacelessLabel(location: string): boolean {
  return isPostiAbroadLabel(location) || label(location) === 'POSTI KULJETUS';
}

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('fi-FI');

/** The stored wording with the full stop the adapter now ends a status with before its explanation. */
function stoppedStatus(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const [wording, saved] = [normalized(incoming.description), normalized(stored.description)];
  if (wording.length !== saved.length + 1 || incoming.stage !== stored.stage
    || normalized(incoming.location) !== normalized(stored.location)) return false;
  for (let stop = wording.indexOf('. '); stop > 0; stop = wording.indexOf('. ', stop + 1)) {
    if (wording.slice(0, stop) + wording.slice(stop + 1) === saved) return true;
  }
  return false;
}

// Scans stored with such a label as their location lose it and keep their row,
// as do scans stored with a status run into its explanation. A copy of an
// origin post's scan, once stored on Helsinki's clock, keeps its row on that
// post's.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'posti', storedSources: ['posti'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, isPostiPlacelessLabel) || stoppedStatus(incoming, stored),
  relabelledFrom: 'Europe/Helsinki',
};

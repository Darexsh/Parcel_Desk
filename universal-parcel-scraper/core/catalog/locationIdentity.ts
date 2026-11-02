import type { SameInstantScan } from './eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/** The same wording and the same known stage. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  return Boolean(wording) && !['', 'unknown'].includes(incoming.stage)
    && incoming.stage === stored.stage && wording === normalized(stored.description);
}

/** Adding a place must keep the scan's wording and known stage; conflicting places do not match. */
export function matchesLocationEnrichment(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const location = normalized(incoming.location);
  const savedLocation = normalized(stored.location);
  return Boolean(location) && sameScan(incoming, stored) && (!savedLocation || location === savedLocation);
}

/**
 * A scan whose adapter now drops the text it once gave as the location, a
 * service's name or a status that is no place, must keep its wording and
 * known stage. Only a stored location `dropped` names matches.
 */
export function matchesDroppedLocation(
  incoming: SameInstantScan,
  stored: SameInstantScan,
  dropped: (location: string) => boolean,
): boolean {
  const savedLocation = stored.location.trim();
  return !normalized(incoming.location) && Boolean(savedLocation) && dropped(savedLocation) && sameScan(incoming, stored);
}

/**
 * A scan whose adapter now writes the location it once stored another way, a
 * country no longer repeated, a label dropped or a town recased, must keep its
 * wording and known stage. `reread` gives a stored location in the new way;
 * only a stored location it changes, if only in case, matches, and only the
 * location it gives.
 */
export function matchesRereadLocation(
  incoming: SameInstantScan,
  stored: SameInstantScan,
  reread: (location: string) => string,
): boolean {
  const savedLocation = stored.location.trim();
  const location = reread(savedLocation).trim();
  return Boolean(savedLocation) && location !== savedLocation
    && normalized(location) === normalized(incoming.location) && sameScan(incoming, stored);
}

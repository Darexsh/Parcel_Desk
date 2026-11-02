import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { dpdUkWording, withoutDriverName } from './wording.js';

// DPD UK rewords a depot scan as the parcel moves on: it has arrived at the depot, it is there
// ready for delivery, then it is at the depot. The three are one scan.
const DEPOT = /^your parcel (?:has arrived at|is at) our depot(?: ready for delivery)?$/;

function wording(scan: SameInstantScan): string {
  const text = dpdUkWording(withoutDriverName(scan.description));
  return DEPOT.test(text) ? 'your parcel is at our depot' : text;
}

/** One scan, by its wording and place. DPD UK's scans have no code. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored) && incoming.location.trim() === stored.location.trim();
}

// The round's notice drops the hour it gave for the delivery once the round is over, a depot
// scan is reworded, and earlier releases kept the driver's name a scan gives. The scan keeps its row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dpd-uk', storedSources: ['dpd-uk'], requireProviderCode: false, matchEachScan: true, matches: sameScan,
};

import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { countryCode } from '../../core/time/index.js';
import { dhlinkEnglish } from './status.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/** The row's own clock at the end of a node's wording ("Shipment has delivered at 2026-01-02 03:04:05"). */
const STATED_CLOCK = / at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// DHLink's wall clocks state no zone, so a scan a better deduced zone re-dates
// takes over its row by wall clock. A node stored with its row's clock at the
// end of its wording keeps its row once worded without it, and one stored in
// Chinese once shown in English. A row stored with the destination country as
// its place keeps its row once shown without a place.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dhlink', storedSources: ['dhlink'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => sameScan(incoming, stored)
    || (STATED_CLOCK.test(wording(stored)) && sameScan(incoming, { ...stored, description: wording(stored).replace(STATED_CLOCK, '') }))
    || sameScan(incoming, { ...stored, description: dhlinkEnglish(stored.description) ?? '' })
    || (!incoming.location.trim() && countryCode(stored.location.trim()) !== null && sameScan(incoming, { ...stored, location: '' })),
  matchWallClock: true,
};

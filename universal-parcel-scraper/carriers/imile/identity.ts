import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { replacesCainiaoPlaceholder } from '../aliexpress/app.js';
import { imileDisplayWording } from './wording.js';

// A row stored with iMile's brackets in its wording is the scan shown without them.
const wording = (scan: SameInstantScan) => imileDisplayWording(scan.description, scan.location).replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// iMile's wall clocks state no zone, so a scan a better deduced zone re-dates
// takes over its row by wall clock. A Cainiao scan stored with Cainiao's
// placeholder wording keeps its row once worded as its step.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'imile', storedSources: ['imile'], requireProviderCode: false,
  matchEachScan: true, matches: (incoming, stored) => sameScan(incoming, stored) || replacesCainiaoPlaceholder(incoming, stored),
  matchWallClock: true,
};

import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One record as both feeds give it: the mobile API's has no code, the global portal's has DHL's. */
function sameRecord(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// The mobile API reads every wall clock on the facility's zone; the global
// portal gives the offset of the system that wrote the record, another one for
// some customs and shipment-data records. Either feed can answer a lookup, so a
// record takes over the row the other feed stored by its wall clock. Apps that
// predate `matchWallClock` compare records at one instant by the same evidence,
// and apps that cannot compare evidence leave the policy out.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dhl-express', storedSources: ['dhl-express'], requireProviderCode: false,
  matchEachScan: true, matches: sameRecord, matchWallClock: true,
};

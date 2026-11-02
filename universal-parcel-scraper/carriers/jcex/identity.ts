import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored) && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// JCEX lists a scan it relays a second time on Beijing's wall clock, and that
// copy goes once the scan it copies is listed. A copy stored before then under
// another offset shows, on Beijing's clock, the instant of the scan that comes
// later, which takes its row over.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'jcex', storedSources: ['jcex'], requireProviderCode: false, matchEachScan: true, matches: sameScan,
  relabelledFrom: 'Asia/Shanghai',
};

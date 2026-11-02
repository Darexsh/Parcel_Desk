import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';

// Office labels that name a Chronopost service, not where the scan happened:
// the shipper's labelling system on preparation scans, the notification
// service on SMS and e-mail notices, and the partner network abroad.
const SERVICES = new Set(['web services', "service d'avisage", 'chronopost networks']);

/** Whether an office label names one of Chronopost's services rather than a place. */
export function isChronopostService(label: string): boolean {
  return SERVICES.has(label.replace(/\s+/g, ' ').trim().replace(/’/g, "'").toLocaleLowerCase('fr-FR'));
}

// La Poste's event codes (ET1, MD1): Chronopost's own carry no digit after two letters.
const LA_POSTE_CODE = /^[A-Z]{2}\d$/;
const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr-FR');

// Earlier releases read Chronopost's scans from La Poste's feed, which dates them to the
// minute under its own codes and names no office. Chronopost dates the same scan to the
// second, in the same words, and either map can stage it apart: a notice or an instruction
// keeps the stage before it. Only such a row, in the scan's words, matches.
function matchesLaPosteCopy(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return LA_POSTE_CODE.test(stored.providerCode) && !stored.location.trim() && !LA_POSTE_CODE.test(incoming.providerCode)
    && wording(incoming) !== '' && wording(incoming) === wording(stored);
}

// A scan takes over, at its instant or less than a minute away, the row stored with a
// service as its location or the row stored from La Poste's feed.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'chronopost', storedSources: ['chronopost'], requireProviderCode: false,
  matchEachScan: true, matchWithinMinute: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, isChronopostService) || matchesLaPosteCopy(incoming, stored),
};

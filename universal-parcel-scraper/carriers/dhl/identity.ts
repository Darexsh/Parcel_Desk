import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { countryCode } from '../../core/time/index.js';

/** DHL's arrival notice ends with the delivery operator's page, at times with no link. */
const PARTNER_LINK = /\s*\(Homepage \/ online shipment tracking:[^()]*\)$/i;

export const withoutPartnerLink = (text: string): string => text.replace(PARTNER_LINK, '');

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// An arrival notice stored with the partner's link keeps its row once shown
// without it: the same place, and the same wording up to the link.
function linkDropped(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  return wording !== '' && normalized(stored.description) !== wording
    && normalized(withoutPartnerLink(stored.description)) === wording
    && normalized(incoming.location) === normalized(stored.location);
}

/** DHL's German scans name the shipment, its recipient or the delivery; its English ones never do in German. */
const GERMAN = /\b(?:sendung|auslandssendung|empfänger|zustellung)\b/i;

/** A place DHL names, a country in English or German ("France", "Frankreich") read as its code. */
const place = (value: string) => countryCode(value) ?? normalized(value);

/**
 * Scans DHL dates at one instant with the same stage and place, such as a parcel's arrival
 * abroad, told apart by what they say in either language.
 */
const KINDS: readonly RegExp[] = [
  /arrived in the destination country|im zielland\/zielgebiet eingetroffen/,
  /left the import parcel center|das import-paketzentrum im zielland\/zielgebiet verlassen/,
  /^the shipment has arrived at the parcel center\.?$|^die sendung ist im paketzentrum eingetroffen\.?$/,
  /^the shipment has been processed at terminal\.?$|^die sendung wurde im paketzentrum bearbeitet\.?$/,
  /processed in the parcel center of origin|^die sendung wurde von dhl bearbeitet und wird für den weitertransport/,
];
const kind = (scan: SameInstantScan) => KINDS.findIndex((pattern) => pattern.test(normalized(scan.description)));

// DHL words a scan in English or German, as its reader reads. At one instant, a
// scan in the other language with the same stage and place is the stored one,
// unless the two say different things.
function reworded(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const [shown, saved] = [kind(incoming), kind(stored)];
  return incoming.stage !== '' && incoming.stage === stored.stage
    && GERMAN.test(incoming.description) !== GERMAN.test(stored.description)
    && place(incoming.location) === place(stored.location)
    && (shown < 0 || saved < 0 || shown === saved);
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dhl', storedSources: ['dhl'], requireProviderCode: false,
  matchEachScan: true, matches: (incoming, stored) => linkDropped(incoming, stored) || reworded(incoming, stored),
};

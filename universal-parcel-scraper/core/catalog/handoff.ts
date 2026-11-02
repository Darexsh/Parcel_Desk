import type { CarrierResult } from '../result/index.js';
import type { CarrierId } from '../../generated/catalog.js';
import { activeRequirements, AUTOMATIC_CARRIER_IDS, carrierAdapter, requiredRequirements } from './index.js';
import { CARRIER_DEFINITIONS } from './definitions.js';
import { carrierIdsFromPartnerLinks, nationalPostCandidate } from './hints.js';
import { followsPartnerNumbers } from './partners.js';
import { dhlExpressPieceId } from '../detection/dhlExpress.js';
import { detectCarrierMatch, isValidDhlExpressWaybill, isValidS10TrackingNumber, supportsSwissPostHandoff } from '../detection/index.js';
import { isAcsVoucherNumber } from '../detection/acsCourier.js';
import { isAnotherPostItemAtChronopost } from '../detection/chronopost.js';
import { isCorreosChileLookup } from '../detection/correosChile.js';
import { isPosteItalianeLookup } from '../detection/posteItaliane.js';
import { countryCode } from '../time/index.js';

export interface DeliveryHandoff {
  carrier: string;
  number: string;
  basis: 'partner' | 'destination' | 'reference';
}

// Adapters that refuse every other reference before a request: asking them
// about a partner's number only fails, however often the hand-off is retried.
const REFERENCES_LOOKED_UP: Readonly<Record<string, (number: string) => boolean>> = {
  'poste-italiane': isPosteItalianeLookup,
  // DHL Express tracks its waybills and the piece identifiers on its labels.
  'dhl-express': (number) => isValidDhlExpressWaybill(number) || dhlExpressPieceId(number) !== null,
  // Blue Dart's waybills have eleven digits; ICC Worldwide can link it to other references.
  'blue-dart': (number) => /^\d{11}$/.test(number),
  // Speedy and DPD Romania name ACS for the leg it delivers, by whatever reference they hold.
  'acs-courier': isAcsVoucherNumber,
  'correos-chile': isCorreosChileLookup,
};

// DHL Paket's international parcels, its `C` postal numbers, go to the partner
// DHL names for their destination, not always that country's post: DHL Express
// in Poland and Switzerland, PostNord in Finland, Itella in Lithuania and
// Latvia, Meest in Ukraine. Null where the partner does not look up DHL's
// number, or where DHL's arrival scans link another partner than its country
// page names: DHL Parcel Spain rather than Correos, DHL Express in Italy rather
// than SDA. DHL's arrival scan then links the one that delivers.
const DHL_PARCEL_PARTNERS: Readonly<Record<string, CarrierId | null>> = {
  CH: null, ES: null, FI: 'postnord', IT: null, LT: null, LV: null, PL: null, UA: 'meest',
};

// Waybills that take the S10 layout without being postal items: Morning Global's carry
// Madagascar's code, and one in ten passes the check digit. M-ONE's carry Serbia's
// code, and M-ONE delivers them itself.
const OWN_S10_LAYOUTS: Readonly<Record<string, RegExp>> = { 'morning-global': /^BR\d{9}MG$/, 'm-one': /^[A-Z]{2}\d{9}RS$/ };

export function hasDirectHandoffAdapter(carrier: string, number: string): boolean {
  if (!AUTOMATIC_CARRIER_IDS.has(carrier) || carrierAdapter(carrier) === 'universal') return false;
  if (REFERENCES_LOOKED_UP[carrier]?.(number) === false) return false;
  // Another carrier's inputs are never borrowed, so a required one rules the carrier out.
  if (requiredRequirements(carrier, number).length > 0) return false;
  // A carrier with only an optional input (DPD's postcode) looks parcels up by
  // its own number: hand it a reference of its own shape, never a postal one.
  return activeRequirements(carrier, number).length === 0
    || detectCarrierMatch(number).candidates.includes(carrier as CarrierId);
}

/**
 * Propose one confirmation lookup; a candidate never changes the carrier by itself.
 * `countryHint` is the country the parcel is looked up from, which names a
 * postal item's destination for this proposal only when nothing else does.
 */
export function deliveryHandoff(carrier: string, number: string, result: CarrierResult, countryHint?: string | null): DeliveryHandoff | null {
  if (result.delivery_tracking_number != null && (typeof result.delivery_tracking_number !== 'string'
    || !/^[A-Z0-9]{4,40}$/.test(result.delivery_tracking_number))) return null;
  const linked = carrierIdsFromPartnerLinks(
    [result.last_status_text, ...(result.events ?? []).map((event) => event.description)], carrier,
  );
  if (!result.delivery_carrier && linked.length > 1) return null;
  let target: string | undefined = result.delivery_carrier ?? linked[0];
  let basis: DeliveryHandoff['basis'] = 'partner';
  const reference = result.delivery_tracking_number || number;
  const destination = typeof result.destination_country === 'string' ? result.destination_country
    : typeof result.destination_country_name === 'string' ? result.destination_country_name : undefined;
  // S10 binds the postal identity across borders. Its issuer suffix does not
  // identify the destination operator; try that country's post only when no
  // partner is named, and let the shared progress/freshness checks confirm it.
  // Japan Post and Chunghwa Post do not track `U`-prefixed customs labels.
  // Chronopost names La Poste itself for the other posts' items it scans; it
  // delivers the rest.
  if (!target && isValidS10TrackingNumber(reference) && !OWN_S10_LAYOUTS[carrier]?.test(reference)
    && (carrier !== 'chronopost' || isAnotherPostItemAtChronopost(reference))) {
    // Origins such as An Post name no destination. The recipient of an item
    // from abroad is likely the one looking it up; in the issuer's own
    // country it is more likely the sender.
    const hint = countryHint?.trim().toUpperCase();
    const looked = destination === undefined && hint && /^[A-Z]{2}$/.test(hint) && hint !== reference.slice(-2) ? hint : undefined;
    const country = countryCode(destination ?? looked);
    target = carrier === 'dhl' && /^C[A-Z]\d{9}DE$/.test(reference) && country && Object.hasOwn(DHL_PARCEL_PARTNERS, country)
      ? DHL_PARCEL_PARTNERS[country] ?? undefined : nationalPostCandidate(destination ?? looked);
    if ((target === 'japan-post' || target === 'chunghwa-post') && reference.startsWith('U')) target = undefined;
    // Parcelforce is the United Kingdom's EMS operator (https://www.ems.post/en/global-network/ems-operators/ems-uk):
    // EMS from abroad is its to deliver, not Royal Mail's.
    if (target === 'royal-mail' && reference.startsWith('E')) target = 'parcelforce';
    if (target) basis = 'destination';
  }
  // A downstream reference binds the two identities, but does not prove its
  // operator. Only a unique high-confidence catalog match may propose a probe.
  if (!target && result.delivery_tracking_number) {
    const detected = detectCarrierMatch(reference);
    if (detected.confidence === 'high') { target = detected.carrier; basis = 'reference'; }
  }
  // Compatibility with the common AliExpress Swiss letter-post journey. This
  // remains a bounded confirmation lookup, never an automatic carrier choice.
  if (!target && !result.delivery_tracking_number && ['aliexpress', 'intl-post'].includes(carrier)
    && supportsSwissPostHandoff(number) && (!destination || ['ch', 'switzerland'].includes(destination.trim().toLowerCase()))) {
    target = 'swiss-post';
    basis = 'reference';
  }
  // An origin that follows the parcel under its delivery carrier's number has
  // no second reference to name. That carrier delivers where the parcel goes:
  // the one carrier that issues the shape (an S10's issuer does not deliver
  // it), else the only one at home there that the catalog lists beside the
  // origin for the shape.
  if (!target && !result.delivery_tracking_number && followsPartnerNumbers(carrier)) {
    const detected = detectCarrierMatch(number);
    const country = countryCode(destination);
    const issuer = detected.confidence === 'high' && detected.carrier !== carrier && !isValidS10TrackingNumber(number)
      ? detected.carrier : null;
    const local = !country ? []
      : issuer ? [issuer].filter((candidate) => CARRIER_DEFINITIONS[candidate]?.countries?.includes(country))
      : detected.candidates.includes(carrier as CarrierId) ? detected.candidates.filter((candidate) => candidate !== carrier
        && CARRIER_DEFINITIONS[candidate]?.countries?.[0] === country) : [];
    if (local.length === 1) { target = local[0]; basis = 'reference'; }
  }
  if (!target || target === carrier || !/^[A-Z0-9]{4,40}$/.test(reference)
    || !hasDirectHandoffAdapter(target, reference)) return null;
  return { carrier: target, number: reference, basis };
}

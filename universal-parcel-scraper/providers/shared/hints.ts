/**
 * Carrier names a universal provider reports for a shipment, mapped to catalog
 * ids when the mapping is unambiguous.
 *
 * The names are discovery hints: routing may use one to try a dedicated
 * adapter, but only that adapter confirming the shipment adopts the carrier.
 * Nothing here decides a carrier on its own.
 */
import type { CarrierId } from '../../generated/catalog.js';
import { carrierTimezone } from '../../core/catalog/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { followsPartnerNumbers, partnerNumberOwner, tracksPartnerNumbers } from '../../core/catalog/partners.js';
import { brandCarrierIds, brandTimeZones, carrierBrand, carrierIdFromName, carrierNameCountryZone } from '../../core/catalog/hints.js';
import { checksumFailures } from '../../core/detection/detect.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { sharedClockZone } from '../../core/time/index.js';

export { isKnownCarrierName } from '../../core/catalog/hints.js';

/**
 * A bare brand ("DPD Group") names several catalog networks; the number can
 * still pick one. Keep the networks whose detection rules match it, then the
 * one a preferred rule backs, such as a DPD depot range. Anything else stays
 * unresolved rather than guessed. `leg` keeps only the networks that can be
 * the one named.
 */
export function brandCarrierForNumber(name: string, trackingNumber: string, leg?: (network: string) => boolean): string | undefined {
  const networks = brandCarrierIds(name).filter((id) => !leg || leg(id));
  if (!networks.length) return undefined;
  const detected = detectCarrierMatch(trackingNumber);
  const matching = networks.filter((id) => detected.candidates.includes(id as CarrierId));
  if (matching.length === 1) return matching[0];
  const preferred = matching.filter((id) => detected.preferred.includes(id as CarrierId));
  return preferred.length === 1 ? preferred[0] : undefined;
}

/** A courier name's clock: its catalog carrier's, the country it names, or its brand's shared one. */
export function courierZone(name: string, number: string, wall: string): string | null {
  const carrier = carrierIdFromName(name) ?? brandCarrierForNumber(name, number);
  const zone = carrier ? carrierTimezone(carrier) : 'UTC';
  if (zone !== 'UTC') return zone;
  return carrierNameCountryZone(name) ?? sharedClockZone(brandTimeZones(name), wall);
}

/**
 * Detection rules whose check digit the carrier's own adapter verifies before
 * any request: it refuses a number that fits the rule but fails the check as
 * invalid input, whatever other carriers' rules make of the number. Other
 * rules are left out, because their carrier may still know such a number.
 */
export const ADAPTER_CHECKED_RULES: ReadonlySet<string> = new Set([
  'dhl-express-waybill', 'gls-fr-4', 'mondial-relay-1',
  // FedEx label barcodes, tracked by the number they carry.
  'fedex-3', 'fedex-label-barcode', 'fedex-4',
  // S10 postal items.
  'an-post-1', 'austrian-post-2', 'bpost-3', 'bring-posten-1', 'canada-post-2', 'china-post-1', 'correios-br-1',
  'correos-chile-2', 'ctt-1', 'hongkong-post-1', 'india-post-1', 'japan-post-1', 'nz-post-1', 'poczta-polska-s10', 'postnord-2',
  'thailand-post-1', 'ukrposhta-s10', 'usps-s10',
]);

/**
 * Rules whose failed check digit rules out a provider naming their carrier,
 * though its adapter still tracks the number. Every public 12-digit FedEx
 * number passes FedEx's, and providers name FedEx for DHL Paket numbers that
 * fail it.
 */
const NAME_CHECKED_RULES: ReadonlySet<string> = new Set(['fedex-1']);

/**
 * Names are hints only. A direct adapter must confirm the shipment before
 * adoption. The looked-up number resolves a bare brand name, and rules out a
 * carrier whose adapter would refuse it for a failed check digit, or whose
 * numbers all pass a check it fails. A tracker
 * that also finds parcels by their delivery partner's number ("Global Eco",
 * Evri International's tracker) names the partner whose rule claims it.
 * Several names that all map to the catalog can be one journey's legs; see
 * `journeyOwner`. Beside Cainiao, a bare brand names its network that
 * delivers at home. A bare brand none of whose networks fits the number names
 * a group, such as "DPD Group" beside BRT, its network in Italy: beside a
 * carrier whose rule fits the number, it leaves that carrier's hint.
 */
export function universalCarrierHints(raw: unknown[], trackingNumber?: string): { reported_carriers: string[]; discovered_carrier?: string } {
  const names = [...new Set(raw.filter((value): value is string => typeof value === 'string'
    && value.length <= 80 && /^[\p{L}\p{N} .&'()-]+$/u.test(value)).map((value) => value.trim()))].filter(Boolean).slice(0, 10);
  const refused = new Set(trackingNumber ? checksumFailures(trackingNumber)
    .filter(({ rule }) => ADAPTER_CHECKED_RULES.has(rule) || NAME_CHECKED_RULES.has(rule)).map(({ carrier }) => carrier as string) : []);
  const fitting = trackingNumber ? detectCarrierMatch(trackingNumber).candidates as readonly string[] : [];
  const detected = new Set<string>();
  const inFull = new Set<string>();
  // Cainiao follows a parcel from abroad under its delivery carrier's number,
  // so a brand named beside it delivers at home: Evri UK, not Evri
  // International, which hands parcels to partners abroad.
  const inbound = names.some((name) => followsPartnerNumbers(carrierIdFromName(name) ?? ''));
  const leg = inbound ? (network: string) => !tracksPartnerNumbers(network) : undefined;
  let unmapped = false;
  let group = false;
  for (const name of names) {
    const own = carrierIdFromName(name);
    const named = own ?? (trackingNumber ? brandCarrierForNumber(name, trackingNumber, leg) : undefined);
    const partner = named && trackingNumber ? partnerNumberOwner(named, trackingNumber) : undefined;
    // A brand's network none of whose rules fits the number names the network of the
    // brand the number points to: ParcelsApp files DPD UK's depot numbers under DPD France.
    const brand = own ? carrierBrand(own) : undefined;
    const sibling = !partner && brand && trackingNumber && !fitting.includes(own!)
      ? brandCarrierForNumber(brand, trackingNumber, leg) : undefined;
    const carrier = partner ?? sibling ?? named;
    const networks = carrier || !trackingNumber ? [] : brandCarrierIds(name);
    if (networks.length && !networks.some((id) => fitting.includes(id))) group = true;
    else if (!carrier) unmapped = true;
    else if (!refused.has(carrier)) {
      detected.add(carrier);
      if (own && !sibling) inFull.add(carrier);
    }
  }
  // A name outside the catalog may be the number's owner, so it leaves no hint.
  if (group && ![...detected].some((carrier) => fitting.includes(carrier))) unmapped = true;
  const discovered = unmapped ? undefined : detected.size === 1 ? [...detected][0]
    : detected.size > 1 && trackingNumber ? journeyOwner([...detected], trackingNumber, inFull) : undefined;
  return { reported_carriers: names, ...(discovered ? { discovered_carrier: discovered } : {}) };
}

/**
 * A provider can name an origin and the carrier it hands the parcel to, such
 * as DHLink and SwiftX. The number is the one carrier's whose rules fit it,
 * or that a preferred rule backs among several, else the one named in full
 * beside networks a bare brand left to the number's shape. When none fits, Cainiao, which
 * follows a parcel under its delivery carrier's number, leaves the one carrier
 * named beside it. Otherwise a carrier whose numbers all have a layout of their own
 * (only high-confidence rules, SwiftX's SWX and eighteen digits) is named for
 * its own leg, and the one carrier left is the hint.
 */
function journeyOwner(carriers: readonly string[], trackingNumber: string, inFull: ReadonlySet<string>): string | undefined {
  const { candidates, preferred } = detectCarrierMatch(trackingNumber);
  const fitting = carriers.filter((carrier) => candidates.includes(carrier as CarrierId));
  if (fitting.length === 1) return fitting[0];
  if (fitting.length > 1) {
    const backed = fitting.filter((carrier) => preferred.includes(carrier as CarrierId));
    if (backed.length === 1) return backed[0];
    const named = (backed.length ? backed : fitting).filter((carrier) => inFull.has(carrier));
    return named.length === 1 && named.length < fitting.length ? named[0] : undefined;
  }
  const delivering = carriers.filter((carrier) => !followsPartnerNumbers(carrier));
  if (delivering.length === 1 && delivering.length < carriers.length) return delivering[0];
  const open = carriers.filter((carrier) => {
    const rules = CARRIER_DEFINITIONS[carrier as CarrierId]?.detectionRules ?? [];
    return rules.length === 0 || rules.some((rule) => rule.confidence !== 'high');
  });
  return open.length === 1 ? open[0] : undefined;
}

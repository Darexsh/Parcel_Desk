/**
 * The carrier catalog, as a consumer reads it.
 *
 * What it is: the `CARRIERS` record derived from the generated catalog, the
 * per-carrier lookups, and the tracking links that follow from catalog data
 * alone (carrier portals, localized URLs).
 * What it is not: no provider I/O, no HTTP, no application or framework code.
 * Everything here is a pure function of the catalog and its arguments.
 */
import { borderExpressBarcodeConsignment } from '../../carriers/border-express/number.js';
import { cdlRequestNumber } from '../../carriers/cdl/number.js';
import { ecoscootingReference } from '../../carriers/ecoscooting/number.js';
import { FLIPPOST_ONE_LAYOUT, flippostWaybills } from '../../carriers/flippost/number.js';
import { normalizeGogoXpressNumber } from '../../carriers/gogo-xpress/number.js';
import { inpostUkTrackingUrl } from '../../carriers/inpost/number.js';
import { MHI_LAYOUT, mhiPrintedNumber } from '../../carriers/mhi/number.js';
import { NOEST_LAYOUT, noestRequestNumber } from '../../carriers/noest/number.js';
import { ozonPosting } from '../../carriers/ozon-logistics/number.js';
import { normalizePackManNumber } from '../../carriers/pack-man/number.js';
import { PAPERFLY_LAYOUT, paperflyRequestNumber } from '../../carriers/paperfly/number.js';
import { normalizeCourierGuyNumber } from '../../carriers/the-courier-guy/number.js';
import { tforceParsPro } from '../../carriers/tforce-freight/number.js';
import { normalizeTntItalyNumber } from '../../carriers/tnt-it/number.js';
import { ZR_EXPRESS_LAYOUT, zrExpressRequestNumber } from '../../carriers/zr-express/number.js';
import { postlogisticsIdentifier } from '../../carriers/postlogistics/number.js';
import { normalizeUpayaNumber, UPAYA_LAYOUT } from '../../carriers/upaya/number.js';
import type { CarrierId } from '../../generated/catalog.js';
import { regionalGofoRequestNumber } from '../detection/gofo.js';
import { isValidMondialRelayBarcode } from '../detection/mondialRelay.js';
import { ninjaVanTrackingUrl } from '../detection/ninjaVan.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { amazonOrdersUrl, amazonShippingUrl } from './amazon.js';
import { CARRIER_DEFINITIONS } from './definitions.js';
import type { CarrierDefinition, CarrierInfo, CarrierInputRequirement } from './types.js';

export * from './types.js';
export * from './definitions.js';
export * from './linkRules.js';
export * from './amazon.js';

/** Carrier-specific printed identifiers expected by the official portal. */
export function trackingNumberForLink(carrierId: CarrierId, raw: string): string {
  const normalized = normalizeTrackingNumber(raw);
  if (carrierId === 'mondial-relay' && isValidMondialRelayBarcode(normalized)) return normalized.slice(0, 12);
  if (carrierId === 'c-chez-vous') {
    const composite = /^([A-Z0-9]{11})(\d{5})$/.exec(normalized);
    if (composite) return `${composite[1]}--${composite[2]}`;
  }
  if (carrierId === 'the-courier-guy') {
    const product = /^(DD|LD)([A-Z0-9]{6})$/.exec(normalized);
    if (product) return normalizeCourierGuyNumber(normalized);
  }
  if (carrierId === 'postlogistics') return postlogisticsIdentifier(raw);
  if (carrierId === 'ozon-logistics') return ozonPosting(raw) ?? raw;
  // CDL's page finds an order number only with the hyphen before its last digit.
  if (carrierId === 'cdl' && /^\d{10}$/.test(normalized)) return cdlRequestNumber(normalized);
  // Pack-Man's page finds a voucher only with the hyphen after its letter.
  if (carrierId === 'pack-man' && /^[A-Z]\d{8}$/.test(normalized)) return normalizePackManNumber(normalized);
  // GoGo Xpress's page finds a number only in its three hyphenated groups of four.
  if (carrierId === 'gogo-xpress' && /^(?=\d*[A-Z])[A-Z0-9]{12}$/.test(normalized)) return normalizeGogoXpressNumber(normalized);
  // ZR Express's page finds a number only with a dash between its three blocks.
  if (carrierId === 'zr-express' && ZR_EXPRESS_LAYOUT.test(normalized)) return zrExpressRequestNumber(normalized);
  // MHI's tracker finds a P series number only with its label's dashes.
  if (carrierId === 'mhi' && MHI_LAYOUT.test(normalized)) return mhiPrintedNumber(normalized);
  // NOEST's page finds a number only in capitals with a hyphen between its three blocks.
  if (carrierId === 'noest' && NOEST_LAYOUT.test(normalized)) return noestRequestNumber(normalized);
  // Paperfly's page finds a number only with the hyphens between its parts.
  if (carrierId === 'paperfly' && PAPERFLY_LAYOUT.test(normalized)) return paperflyRequestNumber(normalized);
  if (carrierId === 'gofo-fr') return regionalGofoRequestNumber(normalized);
  // Border Express's tracker takes a consignment, not the barcode of one of its units.
  if (carrierId === 'border-express') return borderExpressBarcodeConsignment(normalized) ?? raw;
  // TForce Freight's page takes a PRO, which a PARS number for the Canadian border carries after 2205.
  if (carrierId === 'tforce-freight') return tforceParsPro(normalized) ?? raw;
  // tnt.com's page takes a consignment's nine digits, without the GE and WW a label can print around them.
  if (carrierId === 'tnt' && /^GE\d{9}WW$/.test(normalized)) return normalized.slice(2, 11);
  // tnt.it's tracker finds a waybill only without the check digit its label prints after a dash.
  if (carrierId === 'tnt-it' && /^[A-Z]{2}\d{9}$/.test(normalized)) return normalizeTntItalyNumber(normalized);
  // Upaya's page finds a code only in capitals with the hyphen before its last seven digits.
  if (carrierId === 'upaya' && UPAYA_LAYOUT.test(normalized)) return normalizeUpayaNumber(normalized);
  // Flip Post prints its waybills with dashes, and its tracking API finds one only with them, so a
  // link gives seven or nine digits their dashes. Eight digits fit two layouts and stay as given.
  if (carrierId === 'flippost' && FLIPPOST_ONE_LAYOUT.test(normalized)) return flippostWaybills(normalized)[0]!;
  // Ecoscooting's page finds a Cainiao reference only with its CN.
  if (carrierId === 'ecoscooting' && ecoscootingReference(normalized) !== normalized) return ecoscootingReference(normalized);
  return raw;
}

/** Build a carrier's portal link factory from its catalog template. */
export function trackingLink(carrierId: CarrierId, template: string | undefined) {
  if (carrierId === 'amazon-logistics') return amazonOrdersUrl;
  if (carrierId === 'amazon-shipping') return amazonShippingUrl;
  if (carrierId === 'ninja-van') return ninjaVanTrackingUrl;
  if (!template) return undefined;
  // FedEx Poland's link names the number twice: as the shipment listed and as the one looked up.
  const link = (trackingNumber: string) =>
    template.replaceAll(
      '{trackingNumber}',
      encodeURIComponent(trackingNumberForLink(carrierId, trackingNumber)),
    );
  if (carrierId === 'inpost') return (trackingNumber: string) => inpostUkTrackingUrl(trackingNumber) ?? link(trackingNumber);
  return link;
}

function hiddenLeg(pattern: string | undefined) {
  if (!pattern) return undefined;
  const numbers = new RegExp(pattern);
  return (trackingNumber: string) => numbers.test(normalizeTrackingNumber(trackingNumber));
}

function builtCarrierInfo(id: CarrierId, carrier: CarrierDefinition): CarrierInfo {
  return {
    id,
    name: carrier.displayName,
    aliases: carrier.aliases ?? [],
    countries: carrier.countries ?? [],
    trackingSiteName: carrier.trackingSiteName,
    color: carrier.color,
    trackingUrl: trackingLink(id, carrier.trackingUrlTemplate),
    trackingSearchUrl: carrier.trackingSearchUrl,
    helpUrl: carrier.helpUrl,
    hidesDestinationLeg: hiddenLeg(carrier.hidesDestinationLeg),
    capabilities: {
      tracking: {
        mode: carrier.tracking.mode,
        adapter: carrier.tracking.adapter,
        requirements: [...(carrier.tracking.requirements ?? [])],
      },
      selectable: carrier.selectable,
      timezone: carrier.timezone,
    },
  };
}

export const CARRIERS = Object.fromEntries(
  Object.entries(CARRIER_DEFINITIONS).map(([id, carrier]) => [
    id,
    builtCarrierInfo(id as CarrierId, carrier),
  ]),
) as Record<CarrierId, CarrierInfo>;

export function carrierInfo(id: CarrierId, locale?: string): CarrierInfo {
  const carrier = CARRIERS[id] ?? CARRIERS.unknown;
  const name = locale ? CARRIER_DEFINITIONS[carrier.id].displayNames?.[locale] : undefined;
  return name ? { ...carrier, name } : carrier;
}

export const SELECTABLE_CARRIERS = Object.values(CARRIERS).filter(
  (carrier) => carrier.capabilities.selectable,
);

const numberPatterns = new WeakMap<object, RegExp>();
const valuePatterns = new WeakMap<object, RegExp>();

/** A requirement's pattern, compiled once per requirement. */
function requirementPattern(cache: WeakMap<object, RegExp>, requirement: object, source: string): RegExp {
  let pattern = cache.get(requirement);
  if (!pattern) {
    pattern = new RegExp(source);
    cache.set(requirement, pattern);
  }
  return pattern;
}

/** The requirements a form shows for one number, matched unanchored. */
export function carrierRequirements(
  carrierId: CarrierId,
  trackingNumber: string,
): CarrierInputRequirement[] {
  const normalized = normalizeTrackingNumber(trackingNumber);
  return CARRIERS[carrierId].capabilities.tracking.requirements.filter(
    (requirement) =>
      !requirement.whenTrackingNumber
      || requirementPattern(numberPatterns, requirement, requirement.whenTrackingNumber).test(normalized),
  );
}

/**
 * Whether a form value lets the parcel be saved: blank passes only for an
 * optional input, and a value that is typed must still match the pattern.
 */
export function requirementSatisfied(
  requirement: Pick<CarrierInputRequirement, 'optional' | 'pattern'>,
  raw: string,
): boolean {
  const value = raw.trim();
  if (!value) return requirement.optional === true;
  return !requirement.pattern || requirementPattern(valuePatterns, requirement, requirement.pattern).test(value);
}

export function tracksAutomatically(carrierId: CarrierId): boolean {
  return CARRIERS[carrierId].capabilities.tracking.mode === 'automatic';
}

/** Point a carrier portal at the reader's language when the site supports it. */
export function localizedCarrierUrl(
  carrierId: CarrierId,
  url: string,
  locale?: string,
): string {
  if (!locale || !['en', 'de', 'fr', 'it', 'es', 'pt', 'pl'].includes(locale)) return url;
  try {
    const localizedUrl = new URL(url);
    if (carrierId === 'swiss-post') {
      localizedUrl.searchParams.set('lang', ['en', 'de', 'fr', 'it'].includes(locale) ? locale : 'en');
    } else if (localizedUrl.hostname === 't.17track.net' || localizedUrl.hostname === 'parcelsapp.com') {
      // Parcels supports Spanish and Portuguese, but has no Polish page.
      const siteLocale = localizedUrl.hostname === 'parcelsapp.com' && locale === 'pl' ? 'en' : locale;
      localizedUrl.pathname = localizedUrl.pathname.replace(/^\/[a-z]{2}(?=\/|$)/i, `/${siteLocale}`);
    } else {
      return url;
    }
    return localizedUrl.toString();
  } catch {
    return url;
  }
}

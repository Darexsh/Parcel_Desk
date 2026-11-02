/**
 * The parcel view of the app this package was extracted from.
 *
 * What it is: that app's parcel fields, and what its screens derive from them
 * and the catalog: which carrier a card shows, the numbers and links it
 * lists, and the translation key of the "add a parcel" hint.
 * What it is not: part of the tracking contract. It follows that app.
 */
import type { CarrierId } from '../../generated/catalog.js';
import { supportsSwissPostHandoff } from '../detection/s10.js';
import { amazonOrdersUrl, requiresAmazonAccount } from './amazon.js';
import { carrierInfo, localizedCarrierUrl, tracksAutomatically } from './index.js';
import type { CarrierInfo } from './types.js';

export interface ParcelTrackingLink {
  carrier: CarrierInfo;
  name: string;
  url: string;
  active: boolean;
  ready: boolean;
  role: 'active' | 'waiting' | 'history';
}

/**
 * The parcel fields the tracking-link helpers read. Structurally a subset of
 * the application's `Parcel`, restated here so the package stays independent.
 */
export interface TrackedParcel {
  carrier: CarrierId;
  trackingNumber: string;
  trackingUrl?: string;
  /** Carrier currently supplying automatic updates for a multi-carrier journey. */
  trackingSource?: CarrierId;
  trackingProvider?: string;
  /** The carrier answered the check the provider's result came from; links stay with the carrier. */
  carrierAnswered?: boolean;
  activeTrackingNumber?: string;
  /** Whether Swiss Post has announced a Swiss-issued inbound shipment. */
  swissPostReady?: boolean;
  originalCarrier?: CarrierId;
  originalTrackingNumber?: string;
  originalTrackingUrl?: string;
  /** Where the parcel is delivered; for an Amazon number that names no country, it chooses the store. */
  destinationCountry?: string;
}

export function carrierTrackingHintKey(carrierId: CarrierId) {
  return requiresAmazonAccount(carrierId) ? 'add.amazonAccount'
    : tracksAutomatically(carrierId) ? 'add.autoSync' : 'add.linkSync';
}

/** The source shown on cards and used as the primary link. */
export function activeTrackingCarrierId(
  parcel: Pick<TrackedParcel, 'carrier' | 'trackingNumber' | 'trackingSource'>,
): CarrierId {
  if (requiresAmazonAccount(parcel.carrier, parcel.trackingNumber)) return 'amazon-logistics';
  if (parcel.trackingSource) return parcel.trackingSource;
  return supportsSwissPostHandoff(parcel.trackingNumber) ? 'aliexpress' : parcel.carrier;
}

/** Keep the original carrier identity when separate tracking numbers have been linked. */
export function displayedCarrierId(
  parcel: Pick<TrackedParcel, 'carrier' | 'trackingNumber' | 'trackingSource' | 'originalCarrier'>,
): CarrierId {
  return parcel.originalCarrier ?? activeTrackingCarrierId(parcel);
}

/** Distinct numbers in delivery-first order, including carriers without a website. */
export function parcelTrackingNumbers(parcel: Pick<TrackedParcel,
  'carrier' | 'trackingNumber' | 'trackingSource' | 'activeTrackingNumber' | 'originalCarrier' | 'originalTrackingNumber'
>): { carrier: CarrierId; number: string }[] {
  const delivery = { carrier: activeTrackingCarrierId(parcel), number: parcel.activeTrackingNumber ?? parcel.trackingNumber };
  const original = { carrier: parcel.originalCarrier ?? parcel.carrier, number: parcel.originalTrackingNumber ?? parcel.trackingNumber };
  return delivery.number === original.number ? [delivery] : [delivery, original];
}

/** Link to the source of the displayed result, never a speculative routing preference. */
export function parcelTrackingLinks(
  parcel: Parameters<typeof carrierTrackingLinks>[0] & Pick<TrackedParcel, 'destinationCountry'>, locale?: string,
): ParcelTrackingLink[] {
  if (requiresAmazonAccount(parcel.carrier, parcel.trackingNumber)) {
    const carrier = carrierInfo('amazon-logistics', locale);
    return [{ carrier, name: carrier.name, url: amazonOrdersUrl(parcel.trackingNumber, parcel.destinationCountry), active: true, ready: true, role: 'active' }];
  }
  const links = carrierTrackingLinks(parcel, locale);
  const number = encodeURIComponent(parcel.originalCarrier && parcel.trackingSource
    ? parcel.activeTrackingNumber ?? parcel.trackingNumber : parcel.trackingNumber);
  const provider = parcel.carrierAnswered ? undefined : parcel.trackingProvider;
  const url = provider === '17TRACK' ? `https://t.17track.net/en#nums=${number}`
    : provider === 'ParcelsApp' ? `https://parcelsapp.com/en/tracking/${number}`
    : provider === 'Ship24' ? `https://www.ship24.com/tracking?p=${number}`
    // Postal Ninja's verified public entry point; no guessed session/private URL.
    : provider === 'Postal Ninja' ? 'https://postal.ninja/en/track'
    : provider === 'UPU' ? 'https://globaltracktrace.ptc.post/gtt.web/Search.aspx' : undefined;
  if (!url || !provider) return links;
  const primary: ParcelTrackingLink = { carrier: carrierInfo('unknown', locale), name: provider,
    url: localizedCarrierUrl('unknown', url, locale), active: true, ready: true, role: 'active' };
  return [primary, ...links.filter((link) => link.role !== 'active' && link.url !== primary.url)];
}

/** Primary delivery tracker first, followed by the earlier international journey. */
function carrierTrackingLinks(
  parcel: Pick<
    TrackedParcel,
    | 'carrier'
    | 'trackingNumber'
    | 'trackingUrl'
    | 'trackingSource'
    | 'trackingProvider'
    | 'carrierAnswered'
    | 'activeTrackingNumber'
    | 'swissPostReady'
    | 'originalCarrier'
    | 'originalTrackingNumber'
    | 'originalTrackingUrl'
  >,
  locale?: string,
): ParcelTrackingLink[] {
  if (parcel.originalCarrier && parcel.originalTrackingNumber) {
    const active = parcelTrackingLinks({
      carrier: activeTrackingCarrierId(parcel), trackingNumber: parcel.activeTrackingNumber ?? parcel.trackingNumber,
      trackingUrl: activeTrackingCarrierId(parcel) === parcel.carrier
        && (!parcel.activeTrackingNumber || parcel.activeTrackingNumber === parcel.trackingNumber) ? parcel.trackingUrl : undefined,
    }, locale);
    const original = parcelTrackingLinks({
      carrier: parcel.originalCarrier, trackingNumber: parcel.originalTrackingNumber,
      trackingUrl: parcel.originalTrackingUrl,
    }, locale).map((link) => ({ ...link, active: false, role: 'history' as const }));
    return [...active, ...original];
  }
  if (!supportsSwissPostHandoff(parcel.trackingNumber)) {
    const carrier = carrierInfo(activeTrackingCarrierId(parcel), locale);
    const number = parcel.activeTrackingNumber ?? parcel.trackingNumber;
    // Repair obsolete generated links saved by earlier app versions.
    let savedUrl = requiresAmazonAccount(carrier.id, number) || carrier.id === 'intl-post' || carrier.id !== parcel.carrier
      || number !== parcel.trackingNumber ? undefined : parcel.trackingUrl;
    if (parcel.carrier === 'spring-gds' && savedUrl) {
      try {
        const saved = new URL(savedUrl);
        if (saved.hostname === 'postnl.post' && saved.pathname.startsWith('/details/')) {
          savedUrl = undefined;
        }
      } catch {
        // Leave other saved URLs to the existing link validation.
      }
    }
    const url = savedUrl ?? carrier.trackingUrl?.(number);
    return url ? [{
      carrier,
      name: carrier.trackingSiteName ?? carrier.name,
      url: localizedCarrierUrl(carrier.id, url, locale),
      active: true,
      ready: true,
      role: 'active',
    }] : [];
  }

  const activeCarrier = activeTrackingCarrierId(parcel);
  const swissPostReady = parcel.swissPostReady === true || activeCarrier === 'swiss-post';
  const links = (['aliexpress', 'swiss-post'] as const).map((carrierId) => {
    const carrier = carrierInfo(carrierId, locale);
    const active = carrierId === activeCarrier;
    const ready = carrierId !== 'swiss-post' || swissPostReady;
    return {
      carrier,
      name: carrier.trackingSiteName ?? carrier.name,
      url: localizedCarrierUrl(
        carrier.id,
        carrier.trackingUrl!(parcel.trackingNumber),
        locale,
      ),
      active,
      ready,
      role: active ? 'active' as const : ready ? 'history' as const : 'waiting' as const,
    };
  });
  return links.sort((first, second) => Number(second.active) - Number(first.active));
}

/**
 * Amazon portal links.
 *
 * What it is: the marketplace mapping behind Amazon's order-history and public
 * Amazon Shipping URLs, and the rule that decides when a parcel can only be
 * followed inside the customer's Amazon account.
 * What it is not: no account state, no eligibility probe, no provider I/O; the
 * server checks public availability separately.
 */
import { isAmazonTrackingNumber } from '../detection/amazon.js';

export function requiresAmazonAccount(carrier: string, trackingNumber = ''): boolean {
  return carrier !== 'amazon-shipping' && (carrier === 'amazon-logistics' || isAmazonTrackingNumber(trackingNumber));
}

// Amazon's store for each country it delivers in. Amazon sends visitors from a
// European country without a store of its own to amazon.de (Iceland's to
// amazon.co.uk), so its parcels' orders are there.
const STORES: Readonly<Record<string, string>> = {
  FR: 'fr', DE: 'de', AT: 'de', BE: 'com.be', UK: 'co.uk', GB: 'co.uk',
  IT: 'it', ES: 'es', PT: 'es', NL: 'nl', IE: 'ie', PL: 'pl', SE: 'se', TR: 'com.tr',
  CH: 'de', LI: 'de', LU: 'de', DK: 'de', NO: 'de', FI: 'de', CZ: 'de', HU: 'de', RO: 'de',
  HR: 'de', SI: 'de', EE: 'de', LV: 'de', LT: 'de', GR: 'de', IS: 'co.uk',
};

const DELIVERY_STORES: Readonly<Record<string, string>> = { ...STORES, CA: 'ca', MX: 'com.mx' };

/**
 * The Amazon store whose order history holds the parcel. A number's country
 * prefix decides. TBA names no country, and amazon.ca orders ship under it too,
 * so the delivery country decides there, and when there is no number.
 */
export function amazonMarketplace(raw: string, country = ''): string {
  const number = raw.replace(/[\s.-]/g, '').toUpperCase();
  const destination = country.trim().toUpperCase();
  if (number.startsWith('TBC')) return 'ca';
  if (number.startsWith('TBM')) return 'com.mx';
  if (number.startsWith('TBA')) return destination === 'CA' ? 'ca' : 'com';
  if (!number) return DELIVERY_STORES[destination] ?? 'com';
  return STORES[number.slice(0, 2)] ?? 'com';
}

export function amazonOrdersUrl(raw: string, country = ''): string {
  return `https://www.amazon.${amazonMarketplace(raw, country)}/gp/your-account/order-history`;
}

// These public portals share Amazon's European tracker; DE/BE have no portal of their own.
export function amazonShippingOrigin(raw: string): string {
  const prefix = raw.replace(/[\s.-]/g, '').toUpperCase().slice(0, 2);
  const domains: Record<string, string> = { IT: 'it', ES: 'es', UK: 'co.uk', GB: 'co.uk', TB: 'com' };
  return `https://track.amazon.${domains[prefix] ?? 'fr'}`;
}

export function amazonShippingUrl(raw: string): string {
  return `${amazonShippingOrigin(raw)}/tracking/${encodeURIComponent(raw.replace(/[\s.-]/g, '').toUpperCase())}`;
}

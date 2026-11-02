import { normalizeTrackingNumber } from './normalize.js';

export type NinjaVanCountry = 'sg' | 'my' | 'id' | 'ph' | 'th' | 'vn';

/** Country-bearing catalog families; custom shipper IDs do not identify a route. */
export function ninjaVanCountry(number: string): NinjaVanCountry | undefined {
  if (/^NJVTT\d{11}$/.test(number)) return 'id';
  const match = /^(?:NL(SG|MY|ID|PH|TH|VN)[A-Z]{1,2}\d{8,10}|NV(SG|MY|ID|PH|TH|VN)(?!STAMP[A-Z0-9]{9}$)[A-Z0-9]{8,20})$/.exec(number);
  return match ? (match[1] ?? match[2])!.toLowerCase() as NinjaVanCountry : undefined;
}

/** The country in these families chooses a lookup route, not the destination. */
export function ninjaVanTrackingUrl(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  const country = ninjaVanCountry(number) ?? 'my';
  const host = country === 'id' ? 'www.ninjaxpress.co' : 'www.ninjavan.co';
  return `https://${host}/en-${country}/tracking?id=${encodeURIComponent(number)}`;
}

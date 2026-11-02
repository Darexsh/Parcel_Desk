import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import type { CarrierResult } from '../../core/result/index.js';

/**
 * The last-mile companies whose catalog carrier is certain, by the names
 * TracX Logis's replies and site code give them. Other names, such as Ecohai,
 * the Singapore couriers it hires, or K-Packet, which Korea Post carries and
 * the destination's post delivers, name no carrier.
 */
const PARTNERS: Readonly<Record<string, string>> = {
  SAGAWA: 'sagawa',
  YAMATO: 'yamato',
  JPPOST: 'japan-post',
  'JP POST': 'japan-post',
  EPOST: 'korea-post',
  CJGLS: 'cj-logistics',
  HANJIN: 'hanjin',
  LOTTE: 'lotte-global',
  LOGEN: 'logen',
  ILYANG: 'ilyang-logis',
};

/** A company's name as the site reads it: without a two- or four-letter code before it, such as JD in JD Sagawa. */
function partnerOf(company: string): string | undefined {
  const name = company.trim().toUpperCase().replace(/\s+/g, ' ');
  return PARTNERS[name] ?? PARTNERS[/^(?:[A-Z]{4}|[A-Z]{2}) (.+)$/.exec(name)?.[1] ?? ''];
}

/**
 * The delivering company's number from the summary's `TrackingNo`, and that
 * company when its name is one above and its rules fit the number.
 */
export function tracxHandoff(company: string, reference: string, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const delivery = normalizeTrackingNumber(reference);
  if (!/^[A-Z0-9]{4,40}$/.test(delivery) || delivery === number) return {};
  const partner = partnerOf(company);
  const fits = partner !== undefined && (detectCarrierMatch(delivery).candidates as string[]).includes(partner);
  return { ...(fits ? { delivery_carrier: partner } : {}), delivery_tracking_number: delivery };
}

/** Beijing's clock, on which Cainiao dates its leg in mainland China and Hong Kong. */
export const CAINIAO_CHINA_ZONE = 'Asia/Shanghai';

/**
 * The wordings of Cainiao's steps in China, from the seller's to the
 * departing flight, and of its return warehouse. Its feed dates them on
 * China's clock wherever the parcel goes. So is the order's cancellation:
 * on any clock west of UTC+7:36 it came after the check that first returned
 * it, on a parcel to Portugal. Its later steps are on their site's
 * clock, which varies by parcel, so they are not listed: "Arrived at linehaul
 * office" came at China's digits on one parcel and Europe's on another. The
 * list holds Cainiao's English, as ParcelsApp relays it, and Postal Ninja's
 * translation of it, which keeps Cainiao's digits.
 */
export const CAINIAO_CHINA_LEG: readonly string[] = [
  'pending shipping by the seller', 'order received successfully', 'order has been cancelled', 'package finished', 'leave the warehouse',
  'departed from warehouse', 'accepted by carrier', 'shipment information received by warehouse electronically',
  'package ready for shipping from warehouse', 'package shipped out from warehouse',
  '(?:inbound|outbound) in sorting center', 'processing at sorting center', 'departed from sorting center',
  'package not accepted by sorting center', 'package (?:received by|left) sorting center of transit', 'last-mile delivery forecast',
  'arrived at departure transport hub', 'export customs clearance started', 'export clearance success',
  '(?:leaving|left) from departure country/region', 'cross-solution reroute', '质检真假鉴定',
  'return warehouse inbound success\\.?', 'parcel has been destroyed in return warehouse\\.?',
  // Postal Ninja's translation.
  'shipment information received electronically by the warehouse', 'package shipped from the warehouse', 'received by carrier',
  'inbound processing in sorting center', 'departed from the sorting center', 'forecast of last-mile delivery by carrier',
  'arrived at the departure transport hub', 'export customs clearance complete successfully',
  'leaving the origin country or region', 'departed from the departure country or region',
];

// Postal Ninja follows the step's wording with the scan's own text: "… by the warehouse. Order received successfully".
const CHINA_LEG = new RegExp(`^(?:${CAINIAO_CHINA_LEG.join('|')})(?:\\.\\s.*)?$`, 'is');

/** Whether a Cainiao scan's wording, or the step's wording before the scan's own text, names a step of its leg in China. */
export function cainiaoInChina(wording: string): boolean {
  return CHINA_LEG.test(wording.trim());
}

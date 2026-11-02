import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The codes the tracker's current lookup gives each scan (`status_code`). The
 * courier's run from the hub to the address is `delivery_start` from the
 * moment it leaves, whatever the sentence says.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // The courier is on the way to collect the parcel from the seller.
  ['pickup_start', 'registered'],
  ['pickup_success', 'accepted'],
  ['pickup_station_out', 'in_transit'],
  ['sc_inbound', 'in_transit'],
  ['sc_outbound', 'in_transit'],
  ['station_inbound', 'in_transit'],
  ['delivery_start', 'out_for_delivery'],
  ['signed_personally', 'delivered'],
]);

/**
 * The scans of GoTo Logistics' tracker by wording: short English labels from
 * its earlier lookup, and Indonesian sentences that can name the hub.
 */
const SCANS: ReadonlyArray<readonly [RegExp, Stage]> = [
  // The first scan after the parcel leaves the seller.
  [/^proceeding to carrier facility$/, 'accepted'],
  [/^assigned to transport$/, 'in_transit'],
  [/^arrived at sorting cent(?:er|re)$/, 'in_transit'],
  [/^shipment en route$/, 'in_transit'],
  // Ready for the next leg's driver, between two sorting centres: the parcel
  // is not waiting for the recipient, as the shared rules would read it.
  [/^parcel ready for pick-?up$/, 'in_transit'],
  [/^processed at delivery cent(?:er|re)$/, 'in_transit'],
  [/^successfully delivered$/, 'delivered'],
  // The order waits for a courier to collect it from the seller.
  [/^pesanan akan segera dipickup oleh kurir\.?$/, 'registered'],
  [/^kurir sedang menuju lokasi pickup\.?$/, 'registered'],
  [/^pesanan sudah berhasil dipickup oleh kurir\.?$/, 'accepted'],
  // "Paket telah tiba di … Sorting Center.": the parcel reached the named hub.
  [/^paket telah tiba di .+$/, 'in_transit'],
  // "Paket sudah berangkat dari GTL … Hub.": the parcel left the named hub.
  [/^paket sudah berangkat dari .+$/, 'in_transit'],
  [/^kurir sedang menuju lokasi pengantaran\.?$/, 'out_for_delivery'],
  // "Paket sudah sampai dan diterima oleh …", whoever took it.
  [/^paket sudah sampai dan diterima\b.*$/, 'delivered'],
];

/** The stage GoTo Logistics' own wording gives a scan, if the map knows it. */
export function gtlMappedStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  return SCANS.find(([pattern]) => pattern.test(text))?.[1];
}

/** The stage a scan's code gives, else its wording, if the map knows either. */
export function gtlMappedScanStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? gtlMappedStage(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function gtlStage(wording: string, code: string | null = null): ClassifiedWording | null {
  const mapped = gtlMappedScanStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code and wording seen moves the parcel. */
export const statusMap: CarrierStatusMap = {
  stage: gtlMappedScanStage,
  gaps: [],
};

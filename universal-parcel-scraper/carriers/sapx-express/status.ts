import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SAPX's event headings, in Indonesian, by how they start: a branch, an
 * office or a failure reason can follow. A heading carries no code. A longer
 * heading comes before a shorter one it starts with: a courier taking the
 * parcel back to the sender is a return, not a delivery run. The courier's
 * handover back to the hub after a run is transit, and a held shipment, which
 * a return followed, is an exception. "Dikembalikan ke Customer" is the
 * summary of a parcel returned to the sender.
 */
const HEADINGS: ReadonlyArray<readonly [string, Stage]> = [
  ['sedang dipick up', 'registered'],
  ['paket telah dipick up', 'accepted'],
  ['verifikasi paket', 'accepted'],
  ['keluar dari kantor', 'in_transit'],
  ['sampai di kantor', 'in_transit'],
  ['dalam perjalanan ke', 'in_transit'],
  ['incoming smu', 'in_transit'],
  ['multi bagging', 'in_transit'],
  ['serah terima paket dari kurir ke kantor hub', 'in_transit'],
  ['paket diantar kurir untuk dikembalikan', 'returned'],
  ['paket diantar kurir', 'out_for_delivery'],
  ['paket belum berhasil terkirim', 'failed_attempt'],
  ['shipment hold', 'exception'],
  ['paket telah dikembalikan', 'returned'],
  ['dikembalikan ke customer', 'returned'],
  ['paket telah diterima', 'delivered'],
];

/** The stage the map gives a heading, or an event's wording that starts with one. */
export function sapxMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return HEADINGS.find(([heading]) => key === heading || key.startsWith(`${heading} `) || key.startsWith(`${heading}:`))?.[1];
}

/** An event's stage: its heading from the map, else the shared wording rules, else nothing. */
export function sapxStage(wording: string): ClassifiedWording | null {
  const mapped = sapxMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The heading stages an event. A failure's code (`N1`, `O7`) only names the
 * reason, and a return delivered to the sender carries a delivery's code, so
 * the map reads the wording alone.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => sapxMappedStage(wording),
  gaps: [],
};

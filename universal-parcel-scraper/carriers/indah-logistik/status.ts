import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** A wording's stage, and whether the text after its dash names a branch or warehouse town. */
type Entry = readonly [stage: Stage, place: boolean];

/**
 * The wordings Indah Logistik's lookup writes before a dash, in lower case.
 * Movement wordings name a town after the dash; the courier's, the delivery's
 * and an attempt's name a person, and a scheduled delivery a note.
 */
const WORDINGS: ReadonlyMap<string, Entry> = new Map([
  // The counter of a branch or drop point books, weighs and prices the parcel.
  ['transaksi', ['accepted', true]],
  ['paket sudah berada di gudang asal', ['accepted', true]],
  ['paket dalam perjalanan dari gudang asal', ['in_transit', true]],
  ['paket telah sampai di gudang transit', ['in_transit', true]],
  ['paket telah berangkat dari gudang transit', ['in_transit', true]],
  // The destination branch's warehouse, not the recipient.
  ['paket telah sampai di gudang tujuan', ['in_transit', true]],
  ['paket sedang diantar oleh kurir', ['out_for_delivery', false]],
  // A delivery booked for a later run, such as one across islands; no attempt was made.
  ['pengantaran terjadwal', ['in_transit', false]],
  ['alamat tidak ditemukan / penerima tidak dapat di hubungi', ['failed_attempt', false]],
  ['paket telah diterima', ['delivered', false]],
]);

const key = (wording: string) => wording.toLowerCase().replace(/\s+/g, ' ').trim();

/** The stage Indah Logistik's own wording gives a row, without the text after its dash. */
export function indahLogistikMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording))?.[0];
}

/** Whether the text after this wording's dash is a town the parcel was at. */
export function namesPlace(wording: string): boolean {
  return WORDINGS.get(key(wording))?.[1] ?? false;
}

/** A row's stage: its wording, else the shared wording rules, else nothing. */
export function indahLogistikStage(wording: string): ClassifiedWording | null {
  const mapped = indahLogistikMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => indahLogistikMappedStage(wording),
  gaps: [],
};

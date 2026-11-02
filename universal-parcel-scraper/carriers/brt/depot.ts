import { brandCarrierIds, carrierIdFromName } from '../../core/catalog/hints.js';

/** A depot as the scan table names it, with BRT's three-digit code: "SAMPLETOWN (999)". */
export const DEPOT = /^(.+) \(\d{3}\)$/;

/**
 * Whether a depot is named by carriers alone, as `DPD-COLISSIMO` is
 * after the parcels Colissimo hands the DPD network for BRT. It names no
 * place, so its scans have none.
 */
export function isBrtCarrierDepot(place: string): boolean {
  const words = DEPOT.exec(place.trim())?.[1]?.split(/[^\p{L}]+/u).filter(Boolean) ?? [];
  return words.length > 0 && words.every((word) => Boolean(carrierIdFromName(word)) || brandCarrierIds(word).length > 0);
}

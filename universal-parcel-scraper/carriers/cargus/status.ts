import { classifyWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The app service's scan wordings, in English and, where seen, Romanian.
 * Scans carry no code, so the wording is the only key.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // A courier collected the parcel from the sender.
  ['pickup shipment', 'accepted'],
  ['expediere colectata', 'accepted'],
  // The sender dropped the parcel off at a Ship & Go point or locker.
  ['drop off at delivery location by sender', 'accepted'],
  ['consolidation scan', 'in_transit'],
  ['automatic parcel sorting', 'in_transit'],
  ['with courier', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** "Received in warehouse", followed by the warehouse's town and "[Depozit]". */
const WAREHOUSE = /^received in warehouse\b/;

/**
 * The summary's status, which the service sends beside the scans. It keeps
 * "New" after the first scan, so it only speaks for a parcel without one.
 */
const SUMMARIES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['new', 'registered'],
  ['creat', 'registered'],
  ['in warehouse', 'in_transit'],
  ['delivered', 'delivered'],
]);

export interface CargusStage {
  stage: Stage;
  source: string;
}

function mapped(map: ReadonlyMap<string, Stage>, text: string): CargusStage | undefined {
  const wording = normalizeStatusWording(text);
  const stage = map.get(wording) ?? (map === SCANS && WAREHOUSE.test(wording) ? 'in_transit' : undefined);
  if (stage) return { stage, source: 'carrier_map' };
  // Wording the map has not seen falls to the shared rules, which stay open for review.
  const classified = classifyWording(text, 'pending');
  return classified.source === 'none' ? undefined : classified;
}

export const cargusScanStage = (text: string) => mapped(SCANS, text);
export const cargusSummaryStage = (text: string) => mapped(SUMMARIES, text);

/** Scans and the summary come without a code; a code is not Cargus's. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (code !== null) return undefined;
    return SCANS.get(wording) ?? (WAREHOUSE.test(wording) ? 'in_transit' : SUMMARIES.get(wording));
  },
  gaps: [],
};

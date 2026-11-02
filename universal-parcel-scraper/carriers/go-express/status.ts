import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scan wording of GO!'s tracker, in the English the adapter asks for and
 * in German, the network's own wording. The rows carry no code. A hub line is
 * the overnight trunk between the stations and GO!'s hubs: it is loaded where a
 * parcel leaves and unloaded where it arrives, the delivering station included.
 * The delivery trip is the courier's tour.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['loading hub line', 'in_transit'],
  ['unloading hub line', 'in_transit'],
  ['loading delivery trip', 'out_for_delivery'],
  ['delivery consignee', 'delivered'],
  // The courier collected the shipment from the sender.
  ['abgeholt - sendung übernommen', 'accepted'],
  // The shipment entered a station, then the station recorded it.
  ['eingang station', 'in_transit'],
  ['erfassung station', 'in_transit'],
  ['beladung hub-linie', 'in_transit'],
  ['entladung hub-linie', 'in_transit'],
  ['beladung zustelltour', 'out_for_delivery'],
  ['zustellung empfänger', 'delivered'],
  // The courier could not collect the shipment; it is still with the sender.
  ['abholung war nicht möglich.', 'exception'],
]);

/** The stage the map gives GO!'s wording, if it knows it. */
export function goExpressScanStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A row's stage from the map, else from the shared wording rules, else an
 * exception when the tracker marks the row as an error. Other wording stays
 * without a stage, so it remains visible for review.
 */
export function goExpressStage(wording: string, flaggedError: boolean): ClassifiedWording | null {
  const mapped = goExpressScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  if (worded.source !== 'none') return worded;
  return flaggedError ? { stage: 'exception', source: 'carrier_map' } : null;
}

/** The rows carry wording only; the error mark the tracker puts on a row is not part of the key. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : goExpressScanStage(wording)),
  gaps: [],
};

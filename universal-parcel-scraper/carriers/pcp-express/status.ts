import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** PCP Express's status ids, which replies carry beside each status name. Only ids seen in replies are mapped. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['201', 'in_transit'], // ARRIVE AT OPERATION: at a sorting facility.
  ['39', 'in_transit'], // MANIFESTING PROCESS: bagged and manifested out of the sorting facility.
  ['41', 'in_transit'], // ARRIVAL AT DESTINATION: the bag reached the destination branch.
  ['42', 'out_for_delivery'], // DELIVERY PROCESS
  ['77', 'out_for_delivery'], // ASSIGNMENT DELIVERY PROCESS: put on a courier's delivery run sheet.
  ['1', 'failed_attempt'], // SHIPMENT STATUS ON PROCESS / KIRIM ULANG: not delivered, to go out again; the reason follows.
  ['2', 'delivered'], // SHIPMENT STATUS DELIVERED
]);

/**
 * The status names the tracking page's script reads to light its progress
 * steps, for a name whose id no reply has shown.
 */
const NAMES: ReadonlyMap<string, Stage> = new Map([
  ['pickup order', 'accepted'], // The page shows it as picked up by the courier.
  ['shipment entry', 'accepted'], // Entered at the origin branch.
  ['arrive at operation', 'in_transit'],
  ['manifesting process', 'in_transit'],
  ['arrival at destination', 'in_transit'],
  ['delivery process', 'out_for_delivery'],
  ['assignment delivery process', 'out_for_delivery'],
  ['shipment status on process / kirim ulang', 'failed_attempt'],
  ['shipment status delivered', 'delivered'],
]);

/** The status name of a scan's wording, without the reason an undelivered scan adds after a colon. */
const nameOf = (wording: string) => wording.split(':')[0]!.toLowerCase().replace(/\s+/g, ' ').trim();

/** The stage PCP Express's own ids and status names give a scan. */
export function pcpExpressMappedStage(code: string, wording: string): Stage | undefined {
  return CODES.get(code.trim()) ?? NAMES.get(nameOf(wording));
}

/** A scan's stage: its id or status name, else the shared wording rules, else nothing. */
export function pcpExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = pcpExpressMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => pcpExpressMappedStage(code ?? '', wording),
  gaps: [],
};

import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The code of the arrival at the terminal in the consignee's city, whose stage depends on the route. */
export const KIT_ARRIVED = '03';

/**
 * The codes the tracker gives each step (`status_code`), as its page's script
 * lists them. The arrival (03) is left out: its stage depends on the route.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['00', 'registered'], // The order is created; the cargo is still to reach the sending terminal.
  ['01', 'accepted'], // Accepted at the sending terminal.
  ['02', 'in_transit'], // Left the sending terminal.
  ['F3', 'out_for_delivery'], // Handed to the driver for the address or the pickup point.
  ['04', 'delivered'], // Issued to the consignee.
  ['ZZ', 'exception'], // The order is cancelled.
]);

/** The page's own labels for those codes, and its notice that the sender has barred issue. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['новый заказ', 'registered'],
  ['груз принят на терминале', 'accepted'],
  ['груз отправлен', 'in_transit'],
  ['груз принят на доставку', 'out_for_delivery'],
  ['груз выдан', 'delivered'],
  ['отменен', 'exception'],
  ['выдача груза заблокирована отправителем', 'exception'],
]);

const ARRIVAL = new Set(['груз прибыл на терминал', 'прибыл']);

/**
 * The arrival at the consignee's terminal: ready to collect there, unless the
 * cargo goes on to an address or a pickup point, where the page says it is
 * being prepared for that delivery.
 */
function arrivalStage(atTerminal: boolean): Stage {
  return atTerminal ? 'ready_for_pickup' : 'in_transit';
}

/** The stage the map gives a code, else a wording that came without one, when the code or wording alone settles it. */
export function kitMappedStage(code: string | null, wording: string): Stage | undefined {
  if (code) return CODES.get(code.toUpperCase());
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A step's stage: its code or the page's label, the arrival by the route, else the shared wording rules, else nothing. */
export function kitStage(code: string | null, wording: string, atTerminal: boolean): ClassifiedWording | null {
  const text = normalizeStatusWording(wording);
  if (code?.toUpperCase() === KIT_ARRIVED || (!code && ARRIVAL.has(text))) return { stage: arrivalStage(atTerminal), source: 'carrier_map' };
  const mapped = kitMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The arrival's stage comes from the rest of the reply, so the map leaves it unknown; the estimates are no steps. */
export const statusMap: CarrierStatusMap = {
  stage: kitMappedStage,
  gaps: [
    { code: 'F1', note: 'An arrival estimate the tracker page shows, not a step: the adapter leaves it out of the history.' },
    { code: 'F2', note: 'An arrival estimate the tracker page shows in preference to F1, not a step: the adapter leaves it out of the history.' },
  ],
};

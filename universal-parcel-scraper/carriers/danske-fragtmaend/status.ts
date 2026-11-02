import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Danske Fragtmænd's event codes. Only codes seen in replies are mapped; another
 * code takes the scan's status icon, then the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['DAT', 'registered'], // The sender's data arrived; Danske Fragtmænd does not have the consignment yet.
  ['AFH', 'accepted'], // Collected from the sender.
  ['ANK', 'in_transit'], // A terminal, named in the wording, is handling the consignment.
  ['KTU', 'in_transit'], // Loaded for delivery later the same day; leaving the terminal comes after.
  ['OMX', 'out_for_delivery'],
  ['FIH', 'failed_attempt'], // Nobody was home; the consignment went back to the terminal.
  ['LEV', 'delivered'],
]);

/**
 * The scan's `Status`, which picks its icon on the tracking page: 3 is the
 * delivered tick and 7 the cancelled cross. The other icons (on its way,
 * delayed, error, information) do not name one milestone.
 */
const ICONS: ReadonlyMap<number, Stage> = new Map([[3, 'delivered'], [7, 'exception']]);

/** The stage Danske Fragtmænd's codes give a scan code. */
export function danskeFragtmaendMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else its status icon, else the shared wording rules, else nothing. */
export function danskeFragtmaendStage(code: string, icon: number | null, wording: string): ClassifiedWording | null {
  const mapped = danskeFragtmaendMappedStage(code) ?? (icon === null ? undefined : ICONS.get(icon));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? danskeFragtmaendMappedStage(code) : undefined),
  gaps: [],
};

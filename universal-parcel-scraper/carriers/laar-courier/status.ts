import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * Laar's state ids, which number both the steps of the tracker's timeline and
 * the transit details under them. Only ids seen in replies, or named by the
 * page's script, are mapped; another id falls to the wordings.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['2', 'registered'], // Created, waiting to be collected.
  ['3', 'accepted'], // Collected from the sender.
  ['4', 'in_transit'], // Into a warehouse.
  ['5', 'in_transit'], // In operational processing.
  // In the destination's delivery zone; the delivery follows the same day.
  ['6', 'out_for_delivery'],
  ['6.01', 'out_for_delivery'], // The page shows it in the place of 6.
  ['7', 'delivered'],
  ['11', 'in_transit'], // Left the origin warehouse.
]);

/** The same steps by the names the page shows, in the normalized form, and the ones its script names without an id. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['por recolectar', 'registered'],
  ['recolectado', 'accepted'],
  ['en bodega', 'in_transit'],
  ['en tránsito', 'in_transit'],
  ['zona de entrega', 'out_for_delivery'],
  ['entregado', 'delivered'],
  ['salida de bodega de origen', 'in_transit'],
  // An import on its way from the United States.
  ['tránsito a ecuador', 'in_transit'],
  // The page marks a reported problem in red with a warning sign.
  ['con novedad', 'exception'],
]);

/** The stage Laar's ids or step names give a scan. */
export function laarMappedStage(code: string, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its id or name, else the shared wording rules, else nothing. */
export function laarStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = laarMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => laarMappedStage(code ?? '', wording),
  gaps: [],
};

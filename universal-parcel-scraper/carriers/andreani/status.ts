import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Andreani's tracker words each scan for the recipient and lists it under a
 * milestone. The scans carry no code, so the lines seen in replies are
 * mapped, with the branch and town they name left open.
 */
const LINES: readonly (readonly [RegExp, Stage])[] = [
  [/^tu envío se encuentra pendiente de ingreso\.?$/, 'registered'],
  [/^¡ya tenemos tu envío! el circuito comienza en /, 'accepted'],
  [/^tu envío salió de la sucursal /, 'in_transit'],
  [/^tu envío se encuentra en camino a la sucursal /, 'in_transit'],
  [/^la sucursal .+ ya está procesando tu envío\./, 'in_transit'],
  [/^hoy te visitaremos para entregarte tu envío\.?$/, 'out_for_delivery'],
  [/^ya entregamos tu envío\./, 'delivered'],
];

/** The milestones the page heads scans with, and the parcel's current one. */
const MILESTONES: ReadonlyMap<string, Stage> = new Map([
  ['pendiente de ingreso', 'registered'],
  ['ingresado', 'accepted'],
  ['en camino', 'in_transit'],
  ['entregado', 'delivered'],
]);

const key = (text: string) => text.toLocaleLowerCase('es-AR').trim().split(/\s+/).join(' ');

/** The stage a scan's line gives, if the map knows it. */
export function andreaniLineStage(wording: string): Stage | undefined {
  const line = key(wording);
  return LINES.find(([pattern]) => pattern.test(line))?.[1];
}

/** The stage a milestone's heading gives, if the map knows it. */
export function andreaniMilestoneStage(heading: string): Stage | undefined {
  return MILESTONES.get(key(heading).replace(/\.+$/, ''));
}

/** A scan's stage: its line, else its milestone, else the shared wording rules, else nothing. */
export function andreaniStage(heading: string, wording: string): ClassifiedWording | null {
  const mapped = andreaniLineStage(wording) ?? andreaniMilestoneStage(heading);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The scans carry no code. A line's stage comes from its wording; a scan
 * without a line of its own is worded as its milestone.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => andreaniLineStage(wording) ?? andreaniMilestoneStage(wording),
  gaps: [],
};

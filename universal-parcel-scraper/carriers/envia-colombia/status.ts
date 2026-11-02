import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The milestones of Envía's tracking page, which come without codes: the
 * titles its history lists, each with a fixed sentence under it. The guía is
 * made before the parcel is collected, and "¡Prepárate para recibirlo!" says
 * the couriers are delivering in the recipient's area.
 */
const MILESTONES: Readonly<Record<string, Stage>> = {
  'tu guía fue generada': 'registered',
  'tu envío está en movimiento.': 'in_transit',
  '¡prepárate para recibirlo!': 'out_for_delivery',
  entregado: 'delivered',
};

/**
 * The guía's state code beside its current state. Only codes seen in replies
 * are mapped; the page itself reads `13` as delivered.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['13', 'delivered'], // "ENTREGADA DIGITALIZADA EN …": delivered, with the proof of delivery filed.
]);

/** The stage a milestone title gives, if the map knows it. */
export function enviaMilestoneStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return Object.hasOwn(MILESTONES, normalized) ? MILESTONES[normalized] : undefined;
}

/** The stage a state code gives, if the map knows it. */
export function enviaMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its state code or milestone title, else the shared wording rules, else nothing. */
export function enviaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = code ? enviaMappedStage(code) : enviaMilestoneStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Milestones come without a code and current states with one. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? enviaMappedStage(code) : enviaMilestoneStage(wording)),
  gaps: [],
};

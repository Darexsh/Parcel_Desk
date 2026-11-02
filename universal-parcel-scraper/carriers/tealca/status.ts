import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The shipment's `status`, with the label the tracking page shows for it. A
 * parcel stays at code 2 from its origin store's dispatch until the delivery,
 * at the destination store too.
 */
const SUMMARY: ReadonlyMap<string, { readonly stage: Stage; readonly label: string }> = new Map([
  ['1', { stage: 'accepted', label: 'En tienda' }], // At the origin store, where the guía was made out.
  ['2', { stage: 'in_transit', label: 'En tránsito' }],
  ['3', { stage: 'delivered', label: 'Entregado' }],
]);

/**
 * The opening words of each scan Tealca's network writes, with the store or
 * platform it names after them. Guías are made out at the store the sender
 * brings the parcel to, so a new guía is already in Tealca's hands.
 */
const SCANS: readonly (readonly [RegExp, Stage])[] = [
  [/^gu[ií]a creada\b/, 'accepted'],
  [/^despacho de tienda origen\b/, 'in_transit'],
  [/^recepci[oó]n en plataforma\b/, 'in_transit'],
  [/^en tr[aá]nsito nacional\b/, 'in_transit'],
  [/^despacho de plataforma\b/, 'in_transit'], // To another platform or to the destination store.
  // The destination store receives parcels it then delivers or hands over at its counter.
  [/^recepci[oó]n en tienda destino\b/, 'in_transit'],
  [/^gu[ií]a entregada\b/, 'delivered'],
];

/** The stage of a summary `status` code. */
export function tealcaSummary(code: string): { stage: Stage; label: string } | undefined {
  return SUMMARY.get(code);
}

/** The stage Tealca's own scan wording gives, read from its opening words. */
export function tealcaMappedStage(wording: string): Stage | undefined {
  const text = wording.toLocaleLowerCase('es').trim();
  return SCANS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A scan's stage: its wording in Tealca's vocabulary, else the shared wording rules, else nothing. */
export function tealcaStage(wording: string): ClassifiedWording | null {
  const mapped = tealcaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? tealcaSummary(code)?.stage : tealcaMappedStage(wording)),
  gaps: [],
};

import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The steps Fermopoint's booking page lists, mapped whole. A Fermoticket is a
 * collection booked at a shop; a shipment is a parcel a shop sends on with BRT.
 * The page gives no codes, so the wording sets the stage.
 */
export const FERMOPOINT_STEPS: Readonly<Record<string, Stage>> = {
  'Ritiro prenotato': 'registered',
  // The former page's first step.
  'Consegna prenotata': 'registered',
  // The sender is preparing the parcel; no carrier has it yet.
  'In Preparazione': 'registered',
  // On its way to the shop, not out to a door.
  'In consegna': 'in_transit',
  'Arrivato al negozio': 'ready_for_pickup',
  'Arrivato al Fermo!Point': 'ready_for_pickup',
  // The recipient collected it at the shop.
  'Pacco ritirato': 'delivered',
  'Spedizione prenotata': 'registered',
  // The sender left the parcel at the shop it is sent from.
  'Consegnato al point di partenza': 'accepted',
  // The courier collected it from that shop.
  'Ritirato dal corriere': 'in_transit',
  'Pacco ritirato dal destinatario': 'delivered',
};

const STEPS = new Map(Object.entries(FERMOPOINT_STEPS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a step's wording, if it knows it. */
export function fermopointStepStage(wording: string): Stage | undefined {
  return STEPS.get(normalizeStatusWording(wording));
}

/** A step's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function fermopointStage(wording: string): ClassifiedWording | null {
  const mapped = fermopointStepStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The wording sets the stage; Fermopoint's map leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => fermopointStepStage(wording),
  gaps: [],
};

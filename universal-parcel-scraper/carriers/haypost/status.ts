import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * HayPost's scan wordings in English. Most are the names of the UPU's IPS
 * events, which HayPost and the posts abroad record, followed by the leg in
 * brackets: "(Otb)" outward, "(Inb)" inward, "(EDI-received)" a scan the
 * sending post reported as data. The leg does not change the stage, so the map
 * keys the name without it.
 */
export const HAYPOST_EVENTS: Readonly<Record<string, Stage>> = {
  'Receive item from customer': 'accepted',
  'Receive item at office of exchange': 'in_transit',
  'Insert item into bag': 'in_transit',
  'Send item abroad': 'in_transit',
  'Send item to customs': 'customs',
  // Customs recorded its status for the item.
  'Record item customs information': 'customs',
  // Customs released the item into the post's network; it is not a return to the sender.
  'Return item from customs': 'in_transit',
  'Send item to domestic location': 'in_transit',
  // The office that hands the item over received it.
  'Receive item at location': 'in_transit',
  'Receive item at delivery office': 'in_transit',
  'Receive item at sorting centre': 'in_transit',
  'Send item out for physical delivery': 'out_for_delivery',
  'Unsuccessful item delivery attempt': 'failed_attempt',
  // IPS's record of an item not delivered, with the reason and what happens next after it.
  'The notification was sent to the customer': 'failed_attempt',
  'Receive item at collection point for pick-up': 'ready_for_pickup',
  'Deliver item': 'delivered',
};

const EVENTS = new Map(Object.entries(HAYPOST_EVENTS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
// The leg IPS names after an event.
const LEG = /\s*\((?:inb|otb|dom|edi-received)\)\s*$/i;
// The reason the scan gives, after the event.
const DETAIL = ': ';

/** The stage the map gives a scan's wording, without its reason or leg, if it knows it. */
export function haypostEventStage(wording: string): Stage | undefined {
  return EVENTS.get(normalizeStatusWording(wording.split(DETAIL)[0]!.replace(LEG, '')));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function haypostStage(wording: string): ClassifiedWording | null {
  const mapped = haypostEventStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry no codes; the wording sets the stage, and the map leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => haypostEventStage(wording),
  gaps: [],
};

import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event names of the UPU's IPS system, which Bulgarian Posts' tracker
 * prints in English, mostly with the leg they belong to: "(Otb)" in the
 * posting country and "(Inb)" in the destination. The sending post's events,
 * relayed by its electronic data, use the same names. The map reads a name
 * up to its leg; the former tracker printed the Bulgarian label after it.
 */
const IPS: ReadonlyMap<string, Stage> = new Map([
  ['receive item from customer', 'accepted'],
  ['receive item from sender', 'accepted'],
  ['insert item into bag', 'in_transit'],
  // The despatch the item left in, from the sending post's electronic data.
  ['send item abroad (edi-received)', 'in_transit'],
  ['receive item at office of exchange', 'in_transit'],
  ['receive item at location', 'in_transit'],
  ['insert item into domestic bag', 'in_transit'],
  ['send item to domestic location', 'in_transit'],
  ['receive item at delivery office', 'in_transit'],
  ['send item to customs', 'customs'],
  // Customs recorded its status for the item; the scan's detail names it.
  ['record item customs information', 'customs'],
  // Customs handed the item back: a release.
  ['return item from customs', 'in_transit'],
  ['handover item to delivery agent', 'out_for_delivery'],
  ['unsuccessful item delivery attempt', 'failed_attempt'],
  ['receive item at collection point for pick-up', 'ready_for_pickup'],
  ['deliver item', 'delivered'],
]);

/**
 * Bulgarian Posts' own domestic scans, in Bulgarian whatever language the page
 * asks for, and the names the Bulgarian page gives the IPS events.
 */
const BULGARIAN: ReadonlyMap<string, Stage> = new Map([
  ['получаване пратка от клиент (а10)', 'accepted'],
  ['влагане на пратка в чувал (c 09) и изпращане в чужбина', 'in_transit'],
  ['изпращане на изх.пратка в чужбина', 'in_transit'],
  ['получаване на изх.пратка в межд.разменна станция (в 09)', 'in_transit'],
  ['получаване на вх.пратка в межд.разменна станция', 'in_transit'],
  ['изпращане на вх. пратка на митница', 'customs'],
  ['записване на митническа информация за вх.пратка', 'customs'],
  ['връщане на вх.пратка от митница', 'in_transit'],
  ['влагане на пратка във вътрешен чувал', 'in_transit'],
  ['получаване на вх. пратка', 'in_transit'],
  ['изпращане на вх.пратка в рсц/ов', 'in_transit'],
  ['неуспешен опит за доставка', 'failed_attempt'],
  ['получаване на пратка в станция за доставка', 'ready_for_pickup'],
  ['доставена пратка', 'delivered'],
  // Taken in at an office or sorting centre along the way.
  ['приемане', 'in_transit'],
  // The first visit, which left a notice: the item goes to the post office for collection.
  ['първо посещение', 'failed_attempt'],
  ['за получаване в пс', 'ready_for_pickup'],
  ['доставена', 'delivered'],
  // The former tracker's domestic scans, with a Latin e in the first.
  ['пратката e получена', 'accepted'],
  ['пратката е приета', 'in_transit'],
]);

/**
 * Bulgarian Posts creating its own record of an item, at the minute an item
 * from abroad is taken in after its office of exchange: no movement.
 */
const NOTICES: ReadonlyMap<string, string> = new Map([
  ['създаване', 'Bulgarian Posts creating its record of the item, beside its intake: not a movement, so it keeps the stage of the scan before it.'],
]);

/** Whether a scan's event name is a notice, which keeps the stage of the scan before it. */
export function isBulgarianPostsNotice(name: string): boolean {
  return NOTICES.has(normalizeStatusWording(name));
}

// The leg after an IPS event name, and anything the page puts after it.
const LEG = /\s*\((?:otb|inb|domestic)\)[\s\S]*$/;

/** The stage the map gives a scan's event name, if it knows it. */
export function bulgarianPostsEventStage(name: string): Stage | undefined {
  const wording = normalizeStatusWording(name);
  return BULGARIAN.get(wording) ?? IPS.get(wording.replace(LEG, ''));
}

/** A scan's stage from its event name, else the shared wording rules, else nothing, which keeps it visible for review. */
export function bulgarianPostsStage(name: string): ClassifiedWording | null {
  if (isBulgarianPostsNotice(name)) return null;
  const mapped = bulgarianPostsEventStage(name);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(name, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The scans carry no code. A scan's wording is its event name, then the
 * detail the page shows beside it after a colon; the event name sets the stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : bulgarianPostsEventStage(wording.split(': ')[0]!)),
  gaps: [...NOTICES].map(([wording, note]) => ({ wording, note })),
};

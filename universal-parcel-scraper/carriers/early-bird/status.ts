import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Early Bird's tracking service, which carries no code. Current
 * parcels are worded in the language asked for; older ones come from an
 * earlier system in Swedish whatever the language. A terminal's or route's
 * name is part of the arrival wording, so those are matched as patterns.
 * Each wording is matched in `normalizeStatusWording` form.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  // The sender booked the delivery; Early Bird does not have the parcel yet.
  [/^your delivery is booked with early bird\.$/, 'registered'],
  [/^din leverans är bokad med early bird\.$/, 'registered'],
  [/^leveransen till dig är bokad av e-handlaren\./, 'registered'],
  [/^early bird has received your package\.$/, 'accepted'],
  [/^early bird har tagit emot ditt paket\.$/, 'accepted'],
  // Early Bird's own terminals and the local delivery terminals and routes.
  [/^your package has arrived at the terminal in .{1,80}\.$/, 'in_transit'],
  [/^ditt paket har kommit till terminalen i .{1,80}\.$/, 'in_transit'],
  [/^paketet har ankommit till sorteringsterminal .{1,80}$/, 'in_transit'],
  // On its way to the parcel locker a failed home delivery was sent on to.
  [/^your package is on its way\. you will receive a notification when it is ready to be collected from the parcel locker\.$/, 'in_transit'],
  [/^paketet är på väg\. du får ett meddelande när det är redo att hämtas ur paketskåpet\.$/, 'in_transit'],
  // Both wordings of a failed round, the one that names a door code problem
  // and the decision to send the parcel on to a locker instead. The first
  // promises the parcel "is delivered", which the shared rules would read as
  // a delivery.
  [/^we failed to deliver your package as planned\./, 'failed_attempt'],
  [/^vi misslyckades med att leverera ditt paket som planerat\./, 'failed_attempt'],
  [/^we were unable to access the entrance and therefore failed to deliver your package\./, 'failed_attempt'],
  [/^vi kunde inte komma in i porten och misslyckades därför med att leverera ditt paket\./, 'failed_attempt'],
  [/^since we were unable to deliver the parcel to your home, we will reroute it to a parcel locker\./, 'failed_attempt'],
  [/^eftersom vi inte kunde leverera paketet hem till dig så kommer vi boka om det till ett paketskåp\./, 'failed_attempt'],
  [/^your package is now ready for collection from the parcel locker\./, 'ready_for_pickup'],
  [/^ditt paket finns nu redo att hämtas från paketskåpet\./, 'ready_for_pickup'],
  // Collected from the locker by the recipient.
  [/^the package has been collected from the parcel locker\.$/, 'delivered'],
  [/^paketet har hämtats ur paketskåpet\.$/, 'delivered'],
  // At the door, in the mailbox, or in a bag hung on the mailbox.
  [/^the package has been delivered (?:to your (?:door|mailbox)|in a bag on your mailbox)\.$/, 'delivered'],
  [/^paketet är levererat (?:till din (?:dörr|postlåda)|i en påse på din postlåda)\.$/, 'delivered'],
  [/^ditt paket har nu levererats av early bird\./, 'delivered'],
];

// A new attempt booked after a failed round, not a movement: the parcel keeps
// the stage it had.
const NOTICES: ReadonlySet<string> = new Set([
  'we have scheduled a new attempt to deliver your package.',
  'vi har bokat in ett nytt försök att leverera ditt paket.',
]);

/** The stage the map gives Early Bird's wording, if it knows it. */
export function earlyBirdWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1];
}

export function isEarlyBirdNotice(wording: string): boolean {
  return NOTICES.has(normalizeStatusWording(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function earlyBirdStage(wording: string): ClassifiedWording | null {
  const mapped = earlyBirdWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : earlyBirdWordingStage(wording)),
  gaps: [...NOTICES].map((wording) => ({
    wording, note: 'A new delivery attempt booked after a failed round, not a movement: the parcel keeps the stage it had.',
  })),
};

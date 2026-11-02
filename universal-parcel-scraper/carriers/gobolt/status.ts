import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The step names GoBolt's tracker reads, from its page script and replies.
 * A delivery and a customer's return share them, apart from the return's own
 * pickup steps. Another name falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['label_created', 'registered'], // The merchant sent the order over, or a return was set up.
  ['label_return_scheduled', 'registered'], // A return's pickup is booked.
  ['label_return_out_for_pickup', 'registered'], // A driver is on the way to collect a return.
  ['label_return_picked_up', 'accepted'], // The driver collected the return.
  ['label_scanned', 'accepted'], // The first scan at GoBolt's hub.
  ['label_received_at_destination', 'in_transit'], // At the local facility.
  ['label_returned_to_warehouse', 'in_transit'], // Back at GoBolt's warehouse after a failed run.
  ['label_out_for_delivery', 'out_for_delivery'],
  ['label_failed', 'failed_attempt'], // Read with its reason, below.
  ['label_lost', 'exception'], // The parcel missed a scan and is being looked for.
  ['label_delivered', 'delivered'],
]);

// A failed step whose reason sends the parcel back to the merchant.
const TO_MERCHANT = /\breturn(?:ing|ed)?\s+(?:package\s+)?to\s+(?:the\s+)?(?:merchant|sender)\b/i;
// A failed step whose reason is a problem on GoBolt's side rather than a visit to the door.
const PROBLEM = /\b(?:lost|damaged|loading issue|issue on route|unable to complete route|weather|road closure|order incomplete|cancell?ed)\b/i;

/**
 * The stage of a failed step, `label_failed`, which the page shows with its
 * reason as the driver's note. A visit the recipient missed or refused is a
 * failed attempt and the parcel goes out again; a lost or damaged parcel or a
 * problem on the route is an exception; a reason that sends it back to the
 * merchant is a return.
 */
function failedStage(wording: string): Stage {
  if (TO_MERCHANT.test(wording)) return 'returned';
  if (PROBLEM.test(wording)) return 'exception';
  return 'failed_attempt';
}

/** The stage GoBolt's step name gives a scan, read with its wording where the name needs it. */
export function goboltMappedStage(code: string, wording: string): Stage | undefined {
  const name = code.toLowerCase();
  if (name === 'label_failed') return failedStage(wording);
  if (name === 'label_returned_to_warehouse' && TO_MERCHANT.test(wording)) return 'returned';
  return CODES.get(name);
}

/**
 * A scan's stage: its step name, else the shared wording rules, else nothing.
 * A failed step of a customer's return is a pickup the driver missed: the
 * parcel has not moved and the pickup is tried again, so it has no stage.
 */
export function goboltStage(code: string, wording: string, isReturn = false): ClassifiedWording | null {
  if (isReturn && code.toLowerCase() === 'label_failed') return null;
  const mapped = goboltMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The delivery's reading; a return's missed pickup depends on the rest of the reply.
  stage: (code, wording) => (code ? goboltMappedStage(code, wording) : undefined),
  gaps: [],
};

/**
 * UPS status vocabulary.
 *
 * Nearly every scan in UPS's `GetStatus` reply carries a two-character
 * `actCode`, the official Track API's `status.code`. The code is the stable key: one wording can stand for two codes
 * ("Arrived at Facility" is both the origin scan `OR` and an arrival `AR`), and
 * the wording arrives HTML-escaped and reworded. The adapter maps the code to a
 * stage and leaves a scan with an unmapped code to the shared wording
 * classifier. A scan sent without a code is read by its exact wording only.
 *
 * The shipment detail also carries `progressBarType`, a coarse token, and
 * English prose. They decide the status only when the newest scan's code is
 * unmapped, and for the rendered page, which has no scans.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { RecipientAction, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const EXCEPTION_TERMS = [
  'return to sender', 'returned', 'delivery attempted', 'we missed you',
  'not delivered', 'exception', 'action required',
];
const DELIVERED_TERMS = ['delivered', 'left at'];
const IN_TRANSIT_TERMS = [
  'on the way', 'in transit', 'we have your package', 'first ups possession',
  'departed', 'arrived', 'processing at ups facility',
];
const PENDING_TERMS = ['label created', 'manifest upload', 'shipment ready for ups'];
// A delivery still to come, as in "Your package will be delivered one business day later than expected."
const FUTURE_DELIVERY = /\b(?:will|to) be delivered\b/g;

/**
 * Classify UPS status prose. `hasEvents` reports that the shipment already has
 * a scan history, which is what makes unrecognized wording "moving" rather
 * than "unknown"; without it an unmapped phrase stays `unknown` on purpose.
 */
export function upsStatus(text: string, hasEvents = false): CarrierStatus {
  const value = text.toLocaleLowerCase('en-US').replace(FUTURE_DELIVERY, ' ');
  if (EXCEPTION_TERMS.some((term) => value.includes(term))) return 'exception';
  if (DELIVERED_TERMS.some((term) => value.includes(term))) return 'delivered';
  if (value.includes('out for delivery')) return 'out_for_delivery';
  if (hasEvents || IN_TRANSIT_TERMS.some((term) => value.includes(term))) return 'in_transit';
  if (PENDING_TERMS.some((term) => value.includes(term))) return 'pending';
  return 'unknown';
}

/**
 * `progressBarType` on a shipment detail, lowercased. It outranks the prose
 * because it is the value the page's own progress bar is driven by.
 */
export const UPS_PROGRESS_STATUS: Readonly<Record<string, CarrierStatus>> = {
  manifestupload: 'pending',
  firstupspossession: 'in_transit',
  intransit: 'in_transit',
  outfordelivery: 'out_for_delivery',
  delivered: 'delivered',
  exception: 'exception',
};

/**
 * The official Track API's status `type` letter: delivered, in transit, picked
 * up, manifest (a label, no parcel yet) and exception. Like the progress token,
 * it decides only when the newest scan's code is unmapped.
 */
export const UPS_STATUS_TYPE: Readonly<Record<string, CarrierStatus>> = {
  D: 'delivered',
  I: 'in_transit',
  P: 'in_transit',
  M: 'pending',
  X: 'exception',
};

/**
 * `actCode` on each scan, as seen live. A delay or a delivery instruction keeps
 * the parcel in transit; an unlisted code is left to the wording classifier.
 */
const ACTIVITY_STAGES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // Shipper created a label; UPS does not have the parcel yet.
  ['MP', 'registered'],
  // Drop-off at an access point, the access point readying it for UPS, a
  // pickup scan, the RFID-confirmed collection from the access point, the
  // parcel on its way to its first UPS facility, and the origin scan there.
  // The adapter reads these as transit after the parcel's delivery leg.
  ['XD', 'accepted'], ['ZO', 'accepted'], ['PU', 'accepted'], ['PC', 'accepted'], ['AG', 'accepted'], ['OR', 'accepted'],
  // Facility scans, export and import scans.
  ['AR', 'in_transit'], ['DP', 'in_transit'], ['DS', 'in_transit'], ['YP', 'in_transit'], ['HL', 'in_transit'],
  ['EP', 'in_transit'], ['IP', 'in_transit'],
  // A notice that the package is on its way, without a facility.
  ['DA', 'in_transit'],
  // Delays and new delivery plans: a late flight, a possible delay, a new
  // plan, a delivery a day early, a Saturday delivery requested, a day's delay for weather,
  // and a delivery a business day later than expected.
  ['18', 'in_transit'], ['Q5', 'in_transit'], ['E3', 'in_transit'], ['2U', 'in_transit'], ['RF', 'in_transit'],
  ['DJ', 'in_transit'], ['8Y', 'in_transit'],
  // Address corrections, redirects and receiver requests, including a
  // delivery to an access point that is still pending or only confirmed, and
  // one to the receiver's address instead of the access point.
  ['AL', 'in_transit'], ['HM', 'in_transit'], ['H6', 'in_transit'], ['TB', 'in_transit'], ['VM', 'in_transit'],
  ['ZA', 'in_transit'], ['ZB', 'in_transit'], ['ZC', 'in_transit'],
  // Ground Saver's hand-off to the post office: moving there, transferred, and
  // received by it.
  ['ZW', 'in_transit'], ['LX', 'in_transit'], ['YH', 'in_transit'],
  // Collected back from an access point, or moved off one that is closing.
  ['3P', 'in_transit'], ['6B', 'in_transit'],
  // Prepared for clearance, duties or taxes due, and the parcel held until the
  // receiver pays them.
  ['Z1', 'customs'], ['7F', 'customs'], ['OQ', 'customs'],
  // Loaded on the delivery vehicle, and out for delivery.
  ['OF', 'out_for_delivery'], ['OT', 'out_for_delivery'],
  // Receiver absent, absent again at the final attempt, business closed, or
  // diverted to an access point after a failed attempt.
  ['48', 'failed_attempt'], ['49', 'failed_attempt'], ['G3', 'failed_attempt'], ['5R', 'failed_attempt'],
  // The receiver's or company's name is wrong, which holds the delivery until
  // UPS has the right one.
  ['AD', 'exception'],
  // Delivered to an access point, held there, and UPS's reminder to collect a parcel it holds
  // before the hold ends: it is returned only if no one collects it.
  ['2Q', 'ready_for_pickup'], ['ZP', 'ready_for_pickup'], ['5G', 'ready_for_pickup'],
  // Delivered, including collection from an access point and delivery by the
  // post office after a hand-off.
  ['9E', 'delivered'], ['FS', 'delivered'], ['KB', 'delivered'], ['KD', 'delivered'], ['KE', 'delivered'],
  ['2W', 'delivered'], ['YC', 'delivered'],
]);

/** Duties or taxes due, and the parcel held until the receiver pays them. */
const DUTIES_CODES = new Set(['7F', 'OQ']);

/** What a scan's `actCode` asks the receiver to do, whatever the wording beside it. */
export function upsRecipientAction(code: string): RecipientAction | undefined {
  return DUTIES_CODES.has(code.trim().toUpperCase()) ? 'duties' : undefined;
}

/** The stage a scan's `actCode` stands for, or undefined when the code is not mapped. */
export function upsActivityStage(code: string): Stage | undefined {
  return ACTIVITY_STAGES.get(code.trim().toUpperCase());
}

/**
 * Codes of notices that are no scan: the receiver's delivery instructions,
 * seen while UPS had only the label. A notice keeps the stage of the scan
 * before it, and the newest other scan decides the parcel's.
 */
const NOTICE_CODES = new Set(['L0']);

/** Whether a scan's `actCode` is a notice the stage is not read from. */
export function isUpsNotice(code: string | undefined): boolean {
  return NOTICE_CODES.has((code ?? '').trim().toUpperCase());
}

/**
 * The milestone the rendered page's banner names. Apart from the scans below,
 * it is the only wording the adapter reads without an activity code. Scan
 * wording is otherwise not read without its code: "Arrived at Facility" is
 * both the origin scan and an arrival.
 */
const BANNER_STAGES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['label created', 'registered'],
  ['on the way', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The stage of the rendered page's banner, or undefined for a milestone it does not name. */
export function upsBannerStage(text: string): Stage | undefined {
  return BANNER_STAGES.get(normalizeStatusWording(text));
}

/**
 * Scans UPS sends with an empty `actCode`, by their whole wording. The
 * clearing agency, UPS's customs broker, notes a parcel it holds for release
 * this way.
 */
const UNCODED_SCAN_STAGES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['the package is at the clearing agency awaiting final release.', 'customs'],
]);

/** The stage of a scan UPS sent without an activity code, or undefined for wording it does not name. */
export function upsUncodedScanStage(text: string): Stage | undefined {
  return UNCODED_SCAN_STAGES.get(normalizeStatusWording(text));
}

/** What the map says about one scan: by its activity code, or by its wording without one. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? upsActivityStage(code) : upsBannerStage(wording) ?? upsUncodedScanStage(wording)),
  gaps: [{ code: 'L0', note: "The receiver's delivery instructions, a notice and no scan: it keeps the stage of the scan before it, and the newest other scan decides the parcel's." }],
};

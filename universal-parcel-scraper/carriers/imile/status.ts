import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { statusMap as cainiaoStatusMap } from '../aliexpress/status.js';

/**
 * iMile's `trackStage` codes, by the label the reply gives them. Delivered
 * and returned decide the stage whatever the wording says.
 */
const DECISIVE: ReadonlyMap<string, Stage> = new Map([
  ['2060', 'delivered'], // Delivered.
  ['2065', 'returned'], // Returned to Client.
]);

/**
 * Return Handling Process: the parcel goes back after its delivery failed.
 * Its scans are the way back, centres receiving it and drivers' reasons, so
 * the return is under way until a sentence says the sender has it.
 */
const RETURNING = '1008';

/** The other codes, when the wording is not one of iMile's own sentences. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1001', 'registered'], // Order Creation: the sender's order, before iMile has the parcel.
  ['2005', 'accepted'], // Pick Up: collected from the sender.
  // Received at iMile's first centre in the destination country, after any
  // flight and clearance: movement, not a first acceptance.
  ['2004', 'in_transit'],
  ['1002', 'in_transit'], // In Transit: flights, clearance and centres.
]);

/** The code whose scans its wording tells apart: arrivals, delivery runs, attempts and drivers' reasons. */
const DELIVERY = '1003';

/**
 * iMile's own sentences and drivers' reasons, without the centre names in
 * 【】 and the closing full stop, with the stage they mean. Null marks a scan
 * that moves nothing: a driver's reason that does not establish a loss and
 * a stock count.
 */
const PHRASES: ReadonlyMap<string, Stage | null> = new Map<string, Stage | null>([
  ['order submitted, pending to receive', 'registered'],
  ['order submited', 'registered'],
  ['your order has assigned pickup driver', 'registered'],
  ['your order has been picked up', 'accepted'],
  ['your order has been received', 'in_transit'],
  ['received', 'in_transit'],
  ['your order has arrived at', 'in_transit'],
  ['arrived in warehouse', 'in_transit'],
  ['arrived', 'in_transit'],
  ['your order has been shipped from', 'in_transit'],
  // A centre sends the parcel on to the next, the delivery station in 【】 after it, as JS Express relays it.
  ['parcel shipped to', 'in_transit'],
  ['goods put on shelves completed', 'in_transit'],
  ['parcel is currently being processed', 'in_transit'],
  ['the flight has taken off', 'in_transit'],
  ['flight arrived - waiting for customs clearance', 'customs'],
  ['clearance start', 'customs'],
  ['clearance processing', 'customs'],
  ['airplane clearance finish,ready to ship to', 'in_transit'],
  // The driver is named before the parcel leaves the centre; the misspelling is iMile's.
  ['your order has assigned delivery drvier', 'in_transit'],
  ['dispatch task assigned to da', 'in_transit'],
  ['our delivery associate is out for delivery', 'out_for_delivery'],
  ['shipment out for delivery', 'out_for_delivery'],
  ['delivery attempt finished,return to local logistics company warehouse', 'failed_attempt'],
  // The same return to the delivery station, as relayed to WanbExpress's tracker.
  ['back to ds', 'failed_attempt'],
  // Drivers' reasons, each followed by the attempt's end and the return to the centre.
  ['switch off', 'failed_attempt'],
  ['customer wants to change location', 'failed_attempt'],
  ['route not completed', 'failed_attempt'],
  ['<route not completed>', 'failed_attempt'],
  // On the delivery run only (`1003`); on the way to the delivery office (`1002`) it is a delay.
  ['traffic, strike, bad weather', 'failed_attempt'],
  ['user not at home', 'failed_attempt'],
  ['consignee not at home', 'failed_attempt'],
  ['wrong address', 'failed_attempt'],
  ['<bad address>', 'failed_attempt'],
  // The recipient refused the parcel at the door.
  ['refuse to accept', 'failed_attempt'],
  // A recipient iMile cannot reach, on the delivery run before the return starts.
  ['need to return', 'exception'],
  ['lost order', null],
  // After a failed attempt the recipient chose to collect the parcel; the drop-off at a pickup point follows.
  ['the delivery method has been confirmed with the recipient as self-pickup', null],
  ['inventory count scan', null],
  ['your order has been delivered successfully', 'delivered'],
  ['your package was received', 'delivered'],
  ['order delivery failed, returning to sender', 'exception'],
  ['shipment returned to origin', 'returned'],
  ['return signature', 'returned'],
]);

/**
 * Sentences that carry a date or a reason after a fixed opening. A booked
 * flight and a scheduled delivery day are no movement.
 */
const OPENINGS: readonly (readonly [RegExp, Stage | null])[] = [
  // The origin airport's warehouse took the parcel in; the flight it books follows.
  [/^origin port warehouse receive\b/, 'in_transit'],
  [/^flight schedule etd\b/, null],
  [/^(?:shipment is )?scheduled to\b/, null],
  [/^the driver failed to deliver\b/, 'failed_attempt'],
  // The parcel waits at a pickup point the sentence names, for the recipient's code. The page writes
  // the point and its address in 【】, which the phrase leaves out; a stored wording keeps them.
  [/^the parcel has been delivered to\b.*\. please collect your parcel\b.* using your pickup code$/, 'ready_for_pickup'],
];

/** A wording as the phrases list it: lower case, without the 【】 names, single spaces, no closing full stop. */
export function imilePhrase(wording: string): string {
  return wording.replace(/【[^】]*】/g, ' ').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim().replace(/\s*\.$/, '');
}

/** Drivers' reasons iMile also gives a parcel held up before its delivery run. */
const DELAYS: ReadonlySet<string> = new Set(['traffic, strike, bad weather']);

// The name a stored wording shows before the sentence ("BOG: Clearance start."), which iMile writes in 【】.
const HEADING = /^[^:]{1,120}: (?=\S)/;

/** What iMile's own sentences say: a stage, null for a scan that moves nothing, undefined for a sentence they do not know. */
function phraseStage(code: string, wording: string): Stage | null | undefined {
  const read = (phrase: string) => {
    if (DELAYS.has(phrase) && code !== DELIVERY) return 'in_transit';
    if (PHRASES.has(phrase)) return PHRASES.get(phrase)!;
    return OPENINGS.find(([opening]) => opening.test(phrase))?.[1];
  };
  const phrase = imilePhrase(wording);
  const stage = read(phrase);
  const heading = stage === undefined ? HEADING.exec(phrase) : null;
  return heading ? read(phrase.slice(heading[0].length)) : stage;
}

/**
 * The stage one of iMile's sentences gives its scan under iMile's code for it, null for a scan
 * that moves nothing, undefined for a sentence iMile's map does not know.
 */
export const imileSentenceStage = (code: string, wording: string): Stage | null | undefined => phraseStage(code, wording);

/**
 * The stage one of iMile's sentences gives its scan as another tracker relays it, without a code:
 * opening with the centre's name in 【】, as iMile writes it. Undefined for any other wording and for
 * a scan that moves nothing.
 */
export function imileRelayedStage(wording: string): Stage | undefined {
  return /^\s*【[^】]+】/.test(wording) ? phraseStage('', wording) ?? undefined : undefined;
}

/** The stage iMile's code and sentences give a scan, null for one that moves nothing, undefined when neither decides. */
export function imileMappedStage(code: string, wording: string): Stage | null | undefined {
  const phrase = phraseStage(code, wording);
  if (phrase === null) return null;
  if (code === RETURNING) return phrase === 'returned' ? phrase : 'exception';
  return DECISIVE.get(code) ?? phrase ?? CODES.get(code);
}

/**
 * A scan's stage: iMile's code and sentences, else the shared wording rules.
 * A delivery-stage scan they do not read stays in transit as the fallback.
 */
export function imileStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = imileMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (mapped === null) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' && code !== DELIVERY ? null : worded;
}

/** iMile's own codes are numbers; Cainiao's action codes, on the scans of its leg, are words. */
const IMILE_CODE = /^\d{1,6}$/;

/** iMile's map for its own scans, and Cainiao's for the scans of Cainiao's leg in front of them. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code && !IMILE_CODE.test(code)
    ? cainiaoStatusMap.stage(code, wording)
    : imileMappedStage(code ?? '', wording) ?? undefined),
  gaps: [
    { code: DELIVERY, wording: 'lost order', note: 'A driver\'s reason during a delivery run, followed by the attempt\'s end; the parcel it was seen on went out again and was delivered, so it does not establish a loss.' },
    { code: DELIVERY, wording: 'the delivery method has been confirmed with the recipient as self-pickup.', note: 'The recipient chose to collect the parcel after a failed attempt; it keeps the stage of the scan before it until the pickup point has the parcel.' },
    ...cainiaoStatusMap.gaps,
  ],
};

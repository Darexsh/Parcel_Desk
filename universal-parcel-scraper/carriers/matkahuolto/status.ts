import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The English tracker's scan wording, mapped whole. The scans carry no code.
 * Several read as the wrong milestone to the shared classifier: the notice
 * that Matkahuolto still waits for the sender reads as transit, and the
 * morning run to the pickup point as a parcel already waiting there.
 */
export const MATKAHUOLTO_SCANS: Readonly<Record<string, Stage>> = {
  'Consignment is being processed': 'in_transit',
  'The consignment is on its way': 'in_transit',
  'Your parcel has been sorted and will be taken next to the pickup point.': 'in_transit',
  'The consignment has been delivered. Thank you for choosing Matkahuolto!': 'delivered',
};

/**
 * Wording the tracker goes on with a place, a point, a date or an explanation;
 * the map reads its opening words.
 */
export const MATKAHUOLTO_SCAN_OPENINGS: Readonly<Record<string, Stage>> = {
  // The sender's data has arrived; the parcel itself has not reached Matkahuolto.
  'Matkahuolto is waiting for the consignment from the sender': 'registered',
  'The consignment is ready to continue its journey from Matkahuolto': 'in_transit',
  // The point was full, so the parcel goes on to another one.
  'Your pick up point has changed': 'in_transit',
  // The van takes the parcel to the pickup point that day.
  'We will deliver the consignment to the pickup point during the day': 'out_for_delivery',
  'The shipment is available for pickup with the pickup code at the pick up point': 'ready_for_pickup',
  'Your parcel is available for pick up at the pick up point': 'ready_for_pickup',
};

/** Messages to the recipient: no movement, so the parcel keeps its stage. */
const NOTICE_OPENINGS = [
  'We have sent the recipient a message about the arrival of the consignment',
  'The recipients phone number is missing or incorrect',
];

/** The notices seen whole, which the status map leaves without a stage. */
export const MATKAHUOLTO_NOTICES = [
  'We have sent the recipient a message about the arrival of the consignment (sms).',
  'We have sent the recipient a message about the arrival of the consignment (e-mail).',
  'We have sent the recipient a message about the arrival of the consignment (Paketit mobile app notification).',
  'The recipients phone number is missing or incorrect, so we were unable to send the arrival notification via SMS. The arrival notification has been sent via email if an email address is provided in the shipment information. Phone numbers can be corrected upon the senders request; please contact the sender in this case.',
];

const SCANS = new Map(Object.entries(MATKAHUOLTO_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const OPENINGS = Object.entries(MATKAHUOLTO_SCAN_OPENINGS).map(([wording, stage]) => [normalizeStatusWording(wording), stage] as const);
const NOTICE_KEYS = NOTICE_OPENINGS.map(normalizeStatusWording);

/** Whether normalized wording starts with an opening and goes on with a new word or punctuation. */
const opens = (key: string, opening: string) => key === opening
  || (key.startsWith(opening) && /^[\s.,;:(]/.test(key.slice(opening.length)));

function stageOfKey(key: string): Stage | undefined {
  return SCANS.get(key) ?? OPENINGS.find(([opening]) => opens(key, opening))?.[1];
}

/** The stage Matkahuolto's own wording gives a scan, if the map knows it. */
export function matkahuoltoScanStage(wording: string): Stage | undefined {
  return stageOfKey(normalizeStatusWording(wording));
}

export function isMatkahuoltoNotice(wording: string): boolean {
  const key = normalizeStatusWording(wording);
  return NOTICE_KEYS.some(opening => opens(key, opening));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function matkahuoltoStage(wording: string): ClassifiedWording | null {
  const mapped = matkahuoltoScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only; notices are left without a stage on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : stageOfKey(wording)),
  gaps: MATKAHUOLTO_NOTICES.map(wording => ({
    wording: normalizeStatusWording(wording),
    note: 'A message to the recipient, not a movement: the parcel keeps the stage it had.',
  })),
};

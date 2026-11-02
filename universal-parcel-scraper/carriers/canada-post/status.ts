import type { CarrierStatus } from '../../core/result/index.js';
import { trackingLanguageStage, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The official client's package enum and English translations. */
export const CANADA_POST_STATUS_STAGE: Readonly<Record<string, Stage>> = {
  HalfAccepted: 'registered', FullAccepted: 'accepted', InTransit: 'in_transit',
  InTransitAlert: 'exception', FullProgressAlert: 'exception', FullProgress: 'out_for_delivery',
  HalfDelivered: 'failed_attempt', ReadyPickup: 'ready_for_pickup', Delivered: 'delivered',
  '0': 'registered', '1': 'accepted', '2': 'in_transit', '3': 'exception', '4': 'exception',
  '5': 'out_for_delivery', '6': 'failed_attempt', '7': 'ready_for_pickup', '8': 'delivered',
};

export function canadaPostPackageStage(code: string): Stage | null {
  return Object.hasOwn(CANADA_POST_STATUS_STAGE, code) ? CANADA_POST_STATUS_STAGE[code]! : null;
}

const SCAN_STAGE: Readonly<Record<string, Stage>> = {
  '2600': 'in_transit', '1481': 'exception', '0156': 'ready_for_pickup', '0172': 'exception',
  '1701': 'ready_for_pickup', '1703': 'in_transit', '0174': 'out_for_delivery', '0170': 'in_transit',
  '1301': 'accepted', '1466': 'delivered', '0500': 'out_for_delivery', '2407': 'ready_for_pickup',
  '0175': 'in_transit', '0100': 'in_transit', '1302': 'accepted',
  '3000': 'registered', '2300': 'accepted', '0104': 'in_transit', '0105': 'in_transit', '0107': 'in_transit',
  // Arrivals and departures between facilities, after acceptance.
  '0405': 'in_transit', '0410': 'in_transit',
  // A new label put on the item at a processing plant, between two processing scans.
  '0198': 'in_transit',
  // A delivery notice card: the attempt ended with the item sent to a post office.
  '1479': 'failed_attempt', '1488': 'failed_attempt',
  // A hold the recipient asked for: the item waits for its new delivery.
  '1410': 'in_transit',
  '1434': 'delivered', '1441': 'delivered', '1442': 'delivered', '1462': 'delivered', '1496': 'delivered', '1498': 'delivered',
  '4700': 'in_transit',
  // International legs. A customs release moves the item on rather than holding it.
  '4000': 'accepted', '4100': 'in_transit', '4202': 'in_transit', '0700': 'customs', '0910': 'in_transit',
  '8901': 'in_transit', '4310': 'in_transit', '4311': 'in_transit', '4330': 'customs', '4400': 'customs',
  '4450': 'in_transit', '4600': 'in_transit',
};

export function canadaPostScanStage(code: string, description = ''): Stage | null {
  // A hold that names a post office or pickup point waits there for collection.
  if (code === '1410' && /post office|postal outlet|pick[ -]?up/i.test(description)) return 'ready_for_pickup';
  return Object.hasOwn(SCAN_STAGE, code) ? SCAN_STAGE[code]! : null;
}

/** Notices that move nothing, and why. */
const NOTICES: ReadonlyMap<string, string> = new Map([
  ['1200', 'A revised delivery date: the new date is the estimate, and the parcel does not move.'],
  ['1220', "The recipient's delivery preference: it moves nothing."],
  ['1225', "The recipient's delivery preference: it moves nothing."],
  ['2001', 'A delivery photo is available: it moves nothing, and the photo is not read.'],
]);

/** The signature captured at delivery, a proof beside the delivery scan. */
export const SIGNATURE_CODE = '20';

/** The wording of a delivery on the way back: the return reached the sender. */
export const RETURNED_TO_SENDER = 'Returned to sender';

/** A code whose meaning is known, whether or not it carries a stage. */
export function isKnownCanadaPostScan(code: string): boolean {
  return canadaPostScanStage(code) !== null || NOTICES.has(code);
}

/**
 * What the map says about one scan by its code, else its wording, as the
 * parser stages it. Every scan carries its code.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (!code || code === SIGNATURE_CODE) return undefined;
    const stage = canadaPostScanStage(code, wording) ?? canadaPostStage(wording) ?? undefined;
    return stage === 'delivered' && wording === normalizeStatusWording(RETURNED_TO_SENDER) ? 'returned' : stage;
  },
  gaps: [
    { code: SIGNATURE_CODE, note: 'The signature captured at delivery: a proof beside the delivery scan, not a scan of its own.' },
    ...[...NOTICES].map(([code, note]) => ({ code, note })),
  ],
};

export function canadaPostStage(text: string): Stage | null {
  const value = text.toLowerCase();
  if (/\b(?:will|may|might|would)\b.*\breturn(?:ed)?\b/.test(value)) return /notice|pick[ -]?up|collect/.test(value) ? 'ready_for_pickup' : null;
  if (/\b(?:en\s?route|in transit)\b.*\bsender\b/.test(value)) return 'in_transit';
  if (/\breturned to (?:the )?sender\b/.test(value)) return 'returned';
  if (/\b(?:being returned|returning|return to sender)\b/.test(value)) return 'exception';
  if (/available for pick[ -]?up|held at (?:the )?post office/.test(value)) return 'ready_for_pickup';
  if (/delivery attempt|notice left|delivery notice|no answer|business closed|not delivered|unable to deliver|recipient not located/.test(value)) return 'failed_attempt';
  if (/\b(?:will|expected|scheduled)\b.*\bdelivered\b/.test(value)) return null;
  if (/\bdelivered\b/.test(value)) return 'delivered';
  if (/out for delivery/.test(value)) return 'out_for_delivery';
  // A completed release moves the item on; the shared rules tell it from a clearance still pending.
  if (/customs|clearance/.test(value)) return trackingLanguageStage(text) === 'in_transit' ? 'in_transit' : 'customs';
  if (/exception|alert|delay|damaged|lost|seized|held|re-routed due to processing error/.test(value)) return 'exception';
  if (/manifest|label created|information (?:received|submitted)|order received|pre-shipment|waiting for item/.test(value)) return 'registered';
  if (/accepted|picked up|received by canada post|item arrived|arrived at/.test(value)) return 'accepted';
  if (/in transit|on its way|departed|processed|processing|distribution cent(?:re|er)|sorting/.test(value)) return 'in_transit';
  return null;
}

export function statusForStage(stage: Stage): CarrierStatus {
  if (stage === 'delivered') return 'delivered';
  if (stage === 'out_for_delivery' || stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'exception' || stage === 'failed_attempt' || stage === 'returned') return 'exception';
  if (stage === 'registered' || stage === 'pending') return 'pending';
  return 'in_transit';
}

export function canadaPostStatus(code: string, text: string): CarrierStatus {
  const stage = canadaPostPackageStage(code.trim()) ?? canadaPostStage(text);
  return stage ? statusForStage(stage) : 'unknown';
}

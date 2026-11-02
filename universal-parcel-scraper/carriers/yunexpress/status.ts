import type { CarrierStatus } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { chinaPostEnglish, chinaPostRelayedStage } from '../china-post/status.js';
import statuses from './statuses.json' with { type: 'json' };

const FAILED_ATTEMPT: ClassifiedStatus = { status: 'exception', stage: 'failed_attempt' };

const ENTRIES: ReadonlyArray<readonly [string, ClassifiedStatus]> = [
  ['Shipment information received', { status: 'pending', stage: 'registered' }],
  // The sender's order reaching YunExpress before the parcel does.
  ['Order submitted', { status: 'pending', stage: 'registered' }],
  ['Shipment picked up', { status: 'in_transit', stage: 'accepted' }],
  ['Arrived at origin facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Departed from sort facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment is in transit to next facility', { status: 'in_transit', stage: 'in_transit' }],
  ['The country of origin commences customs declaration.', { status: 'in_transit', stage: 'customs' }],
  ['Arrived at the origin international airport', { status: 'in_transit', stage: 'in_transit' }],
  ['Clearence processing completed - Export', { status: 'in_transit', stage: 'in_transit' }],
  ['International flight has departed', { status: 'in_transit', stage: 'in_transit' }],
  ['International flight has arrived', { status: 'in_transit', stage: 'in_transit' }],
  ['Start Customs Clearence', { status: 'in_transit', stage: 'customs' }],
  ['Collected at Cargo Terminal', { status: 'in_transit', stage: 'in_transit' }],
  ['Clearance processing completed - Import', { status: 'in_transit', stage: 'in_transit' }],
  ['Customs released - Import', { status: 'in_transit', stage: 'in_transit' }],
  ['Customs inspection - Import', { status: 'in_transit', stage: 'customs' }],
  ['In clearance processing - Import', { status: 'in_transit', stage: 'customs' }],
  ['Arrived at the warehouse of Customs Broker', { status: 'in_transit', stage: 'customs' }],
  ['Arrived at sort facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment is ready for outbound', { status: 'in_transit', stage: 'in_transit' }],
  ['Departed from facility', { status: 'in_transit', stage: 'in_transit' }],
  // The hand-over to the destination's last-mile carrier, not to the recipient.
  ['Delivered to local carrier', { status: 'in_transit', stage: 'in_transit' }],
  // The sorting before import customs, and the last-mile carrier's steps it relays up to the delivery round.
  ['Processing at sort facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at destination', { status: 'in_transit', stage: 'in_transit' }],
  ['Handled by local carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Transport to delivery centre', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at delivery centre', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at sorting center', { status: 'in_transit', stage: 'in_transit' }],
  ['The package left sorting center', { status: 'in_transit', stage: 'in_transit' }],
  ['Package departed from sorting center', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at GOFO Regional Destination Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['The driver is out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // GOFO's own scans in the US, read as its codes are: the vehicle is the line haul between its facilities.
  ['Arrived at GOFO Regional Hub', { status: 'in_transit', stage: 'in_transit' }],
  ['Departed GOFO Regional Hub', { status: 'in_transit', stage: 'in_transit' }],
  ['In Transit to Next Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Loaded on Vehicle', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at GOFO Delivery Station', { status: 'in_transit', stage: 'in_transit' }],
  ['Out for Delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Departure from the international sorting center', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment in transit to DHL', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment is in transit to carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Preparing for delivery', { status: 'in_transit', stage: 'in_transit' }],
  // Last-mile wording the feed relays without codes. DPD files its data
  // record before the parcel leaves China and its proof of delivery after the
  // delivery scan. The DHL Parcel Netherlands lines follow that carrier's codes.
  // A partner's order pre-advice is a data record too.
  ['Sender goods issue', { status: 'pending', stage: 'registered' }],
  ['Parcel data transmitted', { status: 'pending', stage: 'registered' }],
  ['In transit.', { status: 'in_transit', stage: 'in_transit' }],
  ['At parcel delivery centre.', { status: 'in_transit', stage: 'in_transit' }],
  ['Out for delivery.', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Shipping Label Created', { status: 'pending', stage: 'registered' }],
  ['POD available', { status: 'delivered', stage: 'delivered' }],
  ['Shipment not yet received or processed', { status: 'pending', stage: 'registered' }],
  ['Order information received. We\'re expecting your parcel to arrive with us.', { status: 'pending', stage: 'registered' }],
  ['We deliver your shipment at a DHL ServicePoint', { status: 'in_transit', stage: 'in_transit' }],
  ['Request by the recipient for delivery at DHL ServicePoint', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivery instruction changed to delivery at DHL ServicePoint', { status: 'in_transit', stage: 'in_transit' }],
  ['New delivery attempt on the next delivery day', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivery planned at the CityHub', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivery planned in the route of the courier', { status: 'in_transit', stage: 'in_transit' }],
  ['Entered into handheld device of the courier', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Handed over to the courier', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Your package is ready to be picked up.', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['Your shipment has been delivered to the postal operator of the country of destination and will be delivered in the coming days.', { status: 'in_transit', stage: 'in_transit' }],
  ['Parcel is handled', { status: 'in_transit', stage: 'in_transit' }],
  ['First parcel scan along Poste Italiane’s logistic network', { status: 'in_transit', stage: 'in_transit' }],
  ['TASK ASSIGNED', { status: 'in_transit', stage: 'in_transit' }],
  ['OUTBOUND SCANNED', { status: 'in_transit', stage: 'in_transit' }],
  ['ORDER EXCEPTION RELEASED', { status: 'in_transit', stage: 'in_transit' }],
  ['DELIVERING, WAIT FOR CONSIGNEE PICK UP', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  // A courier partner's acceptance follows the scans of the network that
  // brought the parcel to it: a hand-over, not the parcel's acceptance.
  ['Package accepted at courier partner', { status: 'in_transit', stage: 'in_transit' }],
  // An American last-mile carrier's intake after the label it printed, then its facilities.
  ['Accepted at Carrier\'s Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at Carrier\'s Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Departed Carrier\'s Facility', { status: 'in_transit', stage: 'in_transit' }],
  // Ecoscooting's last mile after the hand-over to it, read as its own codes are: the
  // delivery carrier's acceptance is a hand-over between carriers.
  ['Your shipment has arrived at sorting center', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has been processed at sorting center and ready for shipping', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has been accepted by delivery carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment is out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // CouriersPlease's lines on an Australian parcel: the hand-over to it, its round and a missed delivery.
  ['1 item has been In transit, Despatched to Carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Onboard for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Unsuccessful delivery - failed delivery card left', FAILED_ATTEMPT],
  // GLS keeps the parcel at its depot after the parcel box it was due in was full.
  ['The parcel is being stored in the GLS parcel center. It could not be delivered as the parcel box was occupied.', FAILED_ATTEMPT],
  // GOFO's line haul between its facilities, relayed without the next one.
  ['In Transit', { status: 'in_transit', stage: 'in_transit' }],
  // China Post's scans in Chinese after YunExpress hands a parcel to it: its receipt is that
  // hand-over, and a presentation to export or import customs holds the parcel there until its release,
  // which puts it back in transit.
  ['中国邮政已收取邮件', { status: 'in_transit', stage: 'in_transit' }],
  ['送交出口海关', { status: 'in_transit', stage: 'customs' }],
  ['出口海关/放行', { status: 'in_transit', stage: 'in_transit' }],
  ['已交承运商运输', { status: 'in_transit', stage: 'in_transit' }],
  ['航空公司接收', { status: 'in_transit', stage: 'in_transit' }],
  ['航空公司启运', { status: 'in_transit', stage: 'in_transit' }],
  ['飞机进港', { status: 'in_transit', stage: 'in_transit' }],
  ['到达寄达地', { status: 'in_transit', stage: 'in_transit' }],
  ['到达寄达地处理中心', { status: 'in_transit', stage: 'in_transit' }],
  ['送交境外进口海关', { status: 'in_transit', stage: 'customs' }],
  ['寄达地海关允许进口', { status: 'in_transit', stage: 'in_transit' }],
];

/**
 * Partner lines that carry a place or a reason after fixed words, by their
 * `normalizeStatusWording` form: GOFO's missed delivery with its type,
 * Ecoscooting's with its reason in brackets, and CouriersPlease's acceptance
 * at a town's depot, its transfer to a depot after it left a card and its
 * transfer to the depot's collection run.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, ClassifiedStatus]> = [
  [/^delivery failed, type: ?recipient absent or delivery location inaccessible\b/, FAILED_ATTEMPT],
  [/^your shipment delivery attempt failed(?: \[[^\]]{1,200}\])?$/, FAILED_ATTEMPT],
  [/^your item has been accepted in \S.* depot$/, { status: 'in_transit', stage: 'in_transit' }],
  [/^\d+ items? (?:has|have) been transferred to \S.* card left$/, FAILED_ATTEMPT],
  [/^\d+ items? (?:has|have) been transferred to run \S+ depot collection$/, { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  // Import customs abroad holding the item for inspection, with what it waits for in brackets.
  [/^境外进口海关留存待验(?:[（(][^（）()]{1,60}[）)])?$/, { status: 'in_transit', stage: 'customs' }],
  // The departure from a processing centre abroad, its country in 【】.
  [/^离开【[^【】]+】处理中心$/, { status: 'in_transit', stage: 'in_transit' }],
];

// China Post's arrival at an office or departure from one names the office in 【】 right after
// the verb: "邮件到达【office】", "邮件离开【office】，正在发往下一站".
const OFFICE_SCAN = /^(邮件(?:到达|离开))【([^【】]+)】(?=$|，)/;

/**
 * A China Post arrival or departure with its office taken out of the wording,
 * as the scan's place: "邮件离开，正在发往下一站" at the office. Other
 * wording, and an office the feed left empty, give undefined.
 */
export function chinaPostOffice(wording: string): { wording: string; office: string } | undefined {
  const match = OFFICE_SCAN.exec(wording.trim());
  const office = match?.[2]!.trim();
  return match && office ? { wording: `${match[1]}${wording.trim().slice(match[0].length)}`, office } : undefined;
}

/**
 * The English China Post's adapter shows for one of its scans relayed in
 * Chinese, read with the office an arrival or a departure names, or with the
 * place that office became. A partner's line, with kana or hangul, and wording
 * China Post's labels do not know give undefined.
 */
export function chinaPostRelayEnglish(wording: string, place = ''): string | undefined {
  const text = wording.trim();
  if (!/\p{Script=Han}/u.test(text) || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return undefined;
  return chinaPostEnglish(text.replace(/^(邮件(?:到达|离开))(?=$|，)/u, `$1【${place.trim()}】`));
}

// A partner's line can carry its tracking page's markup, such as a link holding the parcel's
// number around "CARD LEFT". The scan keeps the link's text, never the tag or its address.
const MARKUP = /<\/?(?:a|b|i|u|em|strong|span|font|br|p|div)\b[^<>]{0,1000}>/gi;

/** A partner's line without its tracking page's markup. */
export function withoutMarkup(text: string): string {
  return text.replace(MARKUP, ' ');
}

/**
 * A place with each part given once in a row: a partner's place can give the
 * town twice ("Example, Example, ES"). A country after a town of its name
 * ("Mexico, Mexico") stays.
 */
export function withoutRepeatedParts(location: string): string {
  const parts = location.split(',').map((part) => part.trim());
  const repeated = (part: string, at: number) => part !== '' && part.toLowerCase() === parts[at - 1]?.toLowerCase()
    && !(at === parts.length - 1 && countryCode(part));
  return parts.some(repeated) ? parts.filter((part, at) => !repeated(part, at)).join(', ') : location;
}

// A relayed notice about the parcel rather than a scan of it names no stage,
// so the parcel keeps the one it had: here a reminder to collect it that
// failed to send.
const NOTICE = normalizeStatusWording('REMINDER EMAIL SENT FAILED');

/** Whether the wording is a relayed notice the map gives no stage on purpose. */
export function isYunExpressNotice(description: string): boolean {
  return normalizeStatusWording(description) === NOTICE;
}

/** Yuntrack's scan wording, compared without case or repeated spaces. */
const WORDING = new Map(ENTRIES.map(([text, status]) => [normalizeStatusWording(text), status]));
// China Post's offices and flights, named in 【】, read as China Post's relayed scans.
const worded = (wording: string): ClassifiedStatus | undefined => {
  const relayed = chinaPostRelayedStage(wording);
  return WORDING.get(wording) ?? PATTERNS.find(([pattern]) => pattern.test(wording))?.[1]
    ?? (relayed ? { status: 'in_transit', stage: relayed } : undefined);
};

// China Post's relayed scans show in English, which stages as their Chinese.
const RELAYED = new Map(statuses.entries.flatMap(({ wording }) => {
  const english = wording ? chinaPostRelayEnglish(wording) : undefined;
  const status = english && wording ? worded(normalizeStatusWording(wording)) : undefined;
  return english && status ? [[normalizeStatusWording(english), status] as const] : [];
}));

// The page labels these latest-event codes Processing and Transit. They give
// the parcel's status when its newest wording is new, never a scan's stage.
const CODE_STATUS = new Map<unknown, CarrierStatus>([[10, 'pending'], [20, 'in_transit'], [30, 'in_transit']]);

export function yunExpressStatus(description: string, code?: unknown): ClassifiedStatus | undefined {
  // The latest event's explicit delivered code also covers partner wording
  // containing variable delivery notes. It is never inherited by older scans.
  if (code === 50) return { status: 'delivered', stage: 'delivered' };
  const wording = normalizeStatusWording(description);
  return worded(wording) ?? RELAYED.get(wording);
}

/** The status the latest event's own code states, for wording the map does not know. */
export function yunExpressCodeStatus(code: unknown): CarrierStatus | undefined {
  return CODE_STATUS.get(code);
}

/**
 * What the map says about one scan. Scans carry no code: the delivered code
 * comes only with the latest event and is never a scan's own. Wording stored
 * with a partner's markup reads as the adapter now writes it, without.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => yunExpressStatus(withoutMarkup(wording))?.stage,
  gaps: [{ wording: NOTICE, note: 'A reminder that failed to send, not a movement: the parcel keeps the stage it had.' }],
};

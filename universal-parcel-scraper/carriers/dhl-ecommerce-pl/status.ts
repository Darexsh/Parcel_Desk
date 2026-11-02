/**
 * DHL eCommerce Poland status vocabulary.
 *
 * The portal sends a status code and the step of its four-point timeline.
 * `statuses.json` holds the codes whose meaning the page script or a live
 * answer establishes. Any other code takes the stage of its timeline step.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage?: Stage }

// The entries with a code are the API's statuses; the others are history scans.
const CODES = new Map<string, Entry>(statuses.entries.flatMap((entry) => 'code' in entry && entry.code
  ? [[entry.code, { wording: entry.wording, stage: entry.stage as Stage }] as const] : []));

// The timeline steps with the English labels the page gives them. `None` is a
// label that was created and not posted yet: it names no stage.
const TIMELINE: Record<string, Entry> = {
  None: { wording: 'Shipment preparation' },
  Sent: { wording: 'Posted', stage: 'registered' },
  Route: { wording: 'On its way', stage: 'in_transit' },
  Delivery: { wording: 'For delivery', stage: 'out_for_delivery' },
  Delivered: { wording: 'Delivered', stage: 'delivered' },
  ReturnToSender: { wording: 'Return to the Sender', stage: 'returned' },
  DeliveredToSender: { wording: 'Delivered to the Sender', stage: 'returned' },
  Resigned: { wording: 'The sender has requested the withdrawal of the shipment', stage: 'exception' },
  Error: { wording: 'Error', stage: 'exception' },
};

const STATUSES: Record<Stage, CarrierStatus> = {
  pending: 'pending', registered: 'pending', accepted: 'in_transit', in_transit: 'in_transit', customs: 'in_transit',
  ready_for_pickup: 'in_transit', out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  failed_attempt: 'exception', returned: 'exception', exception: 'exception',
};

export interface DhlEcommercePlStatus { description: string; stage?: Stage }

/** `text` is the sentence the answer carries for the status, when it has one. */
export function dhlEcommercePlStatus(code: string, timelineStep: unknown, text = ''): DhlEcommercePlStatus {
  const known = CODES.get(code);
  const step = typeof timelineStep === 'string' && Object.hasOwn(TIMELINE, timelineStep) ? TIMELINE[timelineStep] : undefined;
  const stage = known?.stage ?? step?.stage;
  const words = code.replaceAll('_', ' ').toLowerCase();
  return { description: text || known?.wording || step?.wording || words.charAt(0).toUpperCase() + words.slice(1), ...(stage ? { stage } : {}) };
}

export function statusForStage(stage: Stage): CarrierStatus {
  return STATUSES[stage];
}

// The history page's scan wording, in English or Polish, with the stage each names.
const SCAN_STAGES: readonly [RegExp, Stage][] = [
  [/^(?:Delivered to customer\.|Przesyłka doręczona do Odbiorcy\.)$/i, 'delivered'],
  [/^(?:With delivery courier|Przesyłka przekazana kurierowi do doręczenia)\.?(?: Expected delivery hours: \d{2}:\d{2}-\d{2}:\d{2}\.)?$/i, 'out_for_delivery'],
  [/^(?:The shipment is in transit to the delivery depot\.|Przesyłka w transporcie do oddziału doręczającego\.)$/i, 'in_transit'],
  [/^(?:The shipment has arrives at sorting center\.|Przesyłka została przyjęta w centrum sortowania\.)$/i, 'in_transit'],
  [/^(?:The shipment is processed at depot of origin country\.|Przesyłka jest obsługiwana w oddziale nadającym\.)$/i, 'in_transit'],
  [/^(?:The shipment has been dropped off at depot by the sender\.|Przesyłka została nadana przez nadawcę w oddziale DHL\.)$/i, 'accepted'],
  [/^(?:The shipment is handled in Sorting Center|Przesyłka jest obsługiwana w Centrum Sortowania)\.?$/i, 'in_transit'],
  [/^(?:The shipment has reached DHL terminal\.|Przesyłka dotarła do oddziału nadawczego DHL Parcel\.)$/i, 'accepted'],
  // A terminal that gives the planned delivery day is reached on the way, with the sorting centre's scan.
  [/^The shipment has reached DHL terminal(?: in [^.]{0,80})?\. Planned date of delivery to: \d{2}-\d{2}-\d{4}\.$/i, 'in_transit'],
  // A parcel sent abroad: its first terminal, named without a delivery day, then the way out.
  [/^The shipment has reached DHL terminal in [^.]{0,80}\.$/i, 'accepted'],
  [/^The shipment left the origin country\.?$/i, 'in_transit'],
  [/^The shipment has arrived at gateway in destination country\.$/i, 'in_transit'],
  [/^The shipment has arrived at delivery depot\.$/i, 'in_transit'],
  [/^The shipment (?:has been|was) delivered to the recipient\.$/i, 'delivered'],
];

/** The stage of one history scan's wording, once the recipient's acknowledgement is cut off. */
export function dhlPolandScanStage(description: string): Stage | undefined {
  return SCAN_STAGES.find(([pattern]) => pattern.test(description))?.[1];
}

/**
 * What the map says about one scan: the history page's wording, as the browser step reads it.
 * The API's current status is a summary, not a scan, so its wording stays open.
 */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => dhlPolandScanStage(wording), gaps: [] };

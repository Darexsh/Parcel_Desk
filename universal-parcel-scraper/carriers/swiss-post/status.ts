/**
 * Swiss Post status classification.
 *
 * Two independent vocabularies meet here. `globalStatus` is the shipment-level
 * summary the portal shows at the top of the page. Event codes are the last
 * segment of a dotted `eventCode` such as `PARCEL.*.1.1003`, and they are the
 * authority for the current stage: the summary lags behind (a MyPost24 deposit
 * reads `DELIVERED` while the parcel is still waiting in the locker).
 *
 * Only codes with a confirmed meaning are mapped. Anything else is left without
 * a stage so the sync can classify the wording and record the code for review.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../generated/catalog.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Shipment-level `globalStatus` → status. The event codes below refine it. */
export const STATUS_MAP = new Map<string, CarrierStatus>([
  ['REPORTED', 'pending'],
  ['REGISTERED', 'pending'],
  ['TO_BE_DELIVERED', 'in_transit'],
  ['IN_DELIVERY', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['MISSED_DELIVERY', 'exception'],
  ['NOT_DELIVERED', 'exception'],
  ['RETURNED', 'exception'],
  ['CUSTOMS', 'in_transit'],
]);

/** Wording for codes the translation service does not resolve. */
export const FALLBACK_EVENT_LABELS: Record<string, string> = {
  '600': 'Your shipment will shortly be handed over to Swiss Post',
  '1003': 'Loading into delivery vehicle',
  '1201': 'Sorted for delivery',
  '1202': 'Shipment was sorted',
};

/**
 * Event codes (the last dotted segment) with a confirmed stage. Swiss Post's
 * own wording table gives each code one meaning for parcels and letters alike,
 * domestic or international, so one table serves every source and product.
 */
export const EVENT_STAGE_BY_CODE: Record<string, Stage> = {
  '100': 'accepted',
  '200': 'accepted',
  '500': 'accepted',
  // Pickups at the client, like 500, in Swiss Post's own wording table.
  '501': 'accepted',
  '502': 'accepted',
  '600': 'registered',
  '620': 'registered',
  '803': 'customs',
  '804': 'in_transit',
  '805': 'in_transit',
  '813': 'in_transit',
  '815': 'in_transit',
  '818': 'in_transit',
  '819': 'customs',
  '820': 'in_transit',
  '842': 'customs',
  '847': 'in_transit',
  '854': 'registered',
  '859': 'registered',
  '902': 'customs',
  '904': 'in_transit',
  '906': 'in_transit',
  '908': 'in_transit',
  '909': 'in_transit',
  '910': 'ready_for_pickup',
  '912': 'accepted',
  '913': 'in_transit',
  '915': 'in_transit',
  '918': 'in_transit',
  '919': 'customs',
  '920': 'in_transit',
  '921': 'in_transit',
  '923': 'failed_attempt',
  '924': 'failed_attempt',
  '926': 'ready_for_pickup',
  '934': 'failed_attempt',
  '938': 'delivered',
  '1001': 'in_transit',
  '1002': 'in_transit',
  '1003': 'out_for_delivery',
  '1100': 'in_transit',
  '1201': 'in_transit',
  '1202': 'in_transit',
  '1204': 'in_transit',
  '1213': 'in_transit',
  '1218': 'in_transit',
  // Sorted and sent on, and its arrival at a special delivery base, between two delivery rounds.
  '1300': 'in_transit',
  '1400': 'in_transit',
  // Handed to the recipient at a post office counter.
  '2000': 'delivered',
  // A pickup notice like 910: the item waits at a post office for collection.
  '2100': 'ready_for_pickup',
  '2101': 'ready_for_pickup',
  '2102': 'ready_for_pickup',
  '3600': 'returned',
  // The recipient's refusal. Sending the item back is a later scan of its own.
  '3700': 'exception',
  '3800': 'delivered',
  '4000': 'delivered',
  '4001': 'delivered',
  '4020': 'in_transit',
  // After the item was loaded into the delivery vehicle; a later round follows.
  '4100': 'failed_attempt',
  '4600': 'delivered',
  // Held at a post office for the recipient to collect, as poste restante.
  '9400': 'ready_for_pickup',
};

/** The shipment status implied by the newest event's stage. */
export const STAGE_STATUS: Record<string, CarrierStatus> = {
  registered: 'pending',
  accepted: 'in_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  customs: 'in_transit',
  failed_attempt: 'exception',
  ready_for_pickup: 'in_transit',
  returned: 'exception',
};

/**
 * The stage for a full dotted event code, or undefined when the code is not
 * mapped. A sub-event starting `CAN` revokes the scan it qualifies ("Delivered
 * — Revocation" in the carrier's wording), so it never takes the code's stage.
 */
export function swissPostEventStage(eventCode: string, subEventId = ''): Stage | undefined {
  if (/^CAN/i.test(subEventId)) return undefined;
  return EVENT_STAGE_BY_CODE[eventCode.split('.').at(-1) ?? ''];
}

/** The stage the shipment-level `globalStatus` implies, used when the newest scan has none. */
export const GLOBAL_STATUS_STAGE: Record<string, Stage> = {
  REPORTED: 'registered',
  REGISTERED: 'registered',
  TO_BE_DELIVERED: 'in_transit',
  IN_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  MISSED_DELIVERY: 'failed_attempt',
  NOT_DELIVERED: 'failed_attempt',
  RETURNED: 'returned',
  CUSTOMS: 'customs',
};

/** The `globalStatus` codes with a known meaning. A status-only answer carries its code as the status text. */
export const SWISS_POST_GLOBAL_STATUSES: readonly string[] = Object.freeze(Object.keys(GLOBAL_STATUS_STAGE));

/** The languages the tracker words its scans in; it answers any other with German. */
export const SWISS_POST_LANGUAGES = ['en', 'de', 'fr', 'it'] as const;
export type SwissPostLanguage = (typeof SWISS_POST_LANGUAGES)[number];

/** A revoked scan's wording ends with its sub-event's label, in any of the tracker's languages. */
const REVOKED = /— (?:revocation|révocation|widerruf|revoca)$/i;

/** Whether a scan's wording is that of a revoked scan ("Delivered — Revocation", "Distribué — Révocation"). */
export function swissPostRevoked(wording: string): boolean {
  return REVOKED.test(wording.trim());
}

/**
 * What the map says about one scan. The map reads the last segment of the
 * dotted event code. A revoked scan takes no stage.
 */
export const statusMap: CarrierStatusMap = {
  codeKey: (code) => code.split('.').at(-1) ?? code,
  stage: (code, wording) => (code && !swissPostRevoked(wording) ? swissPostEventStage(code) : undefined),
  gaps: [
    { code: '9112', note: 'An enquiry note, not a movement: the shipment summary decides the stage.' },
    { code: '1800', note: 'A delay notice, not a movement: the shipment summary decides the stage.' },
    { code: '9224', note: "The recipient's order to forward the shipment, not a movement: the shipment summary decides the stage." },
  ],
};

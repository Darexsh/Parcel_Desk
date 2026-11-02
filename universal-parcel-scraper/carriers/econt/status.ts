import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** One kind of Econt scan: the English wording the adapter gives it and its stage. */
interface EcontScan {
  readonly wording: string;
  readonly stage?: Stage;
}

// The tracker's reply names each scan's kind with a code and labels it from
// the page's own text, in English "delivered", "arrival at an office" and so
// on. A label-printed shipment waits for its sender under `prepared`.
const SCANS = new Map<string, EcontScan>([
  ['prepared', { wording: 'Awaiting delivery to Econt', stage: 'registered' }],
  ['office', { wording: 'Arrival at an office', stage: 'in_transit' }],
  ['courier_direction', { wording: 'Received by line-haul', stage: 'in_transit' }],
  ['redirect', { wording: 'Shipment forwarding', stage: 'in_transit' }],
  // Collected from the sender's door, or taken out for delivery: the scans before it tell which.
  ['courier', { wording: 'Submitted to courier' }],
  ['failed_delivery', { wording: 'Failed delivery', stage: 'failed_attempt' }],
  ['client', { wording: 'Delivered', stage: 'delivered' }],
  ['return', { wording: 'Delivery return', stage: 'returned' }],
  ['destroy', { wording: 'Shipment destruction', stage: 'exception' }],
  ['instruction', { wording: 'Change delivery terms' }],
  ['info', { wording: 'Information' }],
]);

/** The wording and stage of one scan code; a code the map does not know keeps it as wording. */
export function econtScan(code: string): EcontScan {
  return SCANS.get(code) ?? { wording: code };
}

/**
 * A courier scan before the parcel reached any office or line is the pickup
 * from the sender; after that, the courier takes it out for delivery.
 */
export function econtCourierStage(afterNetworkScan: boolean): Stage {
  return afterNetworkScan ? 'out_for_delivery' : 'accepted';
}

/**
 * The shipment's summary status, in the Bulgarian the reply always carries
 * (its Latin form is a translation that can change). Only the statuses that
 * settle the stage are here; the others, such as "В куриер" (with a courier,
 * which can be either one), follow the newest scan.
 */
const SUMMARIES: Readonly<Record<string, Stage>> = {
  'подготвена в eecont': 'registered',
  'очаква предаване към еконт': 'registered',
  'приета в еконт': 'accepted',
  'приета в офис': 'accepted',
  'пътува по линия': 'in_transit',
  'доставена': 'delivered',
  'върната': 'returned',
  'върната и доставена към подател': 'returned',
  'връща се към подател': 'exception',
  'анулирана след изпращане': 'exception',
  'анулирана преди изпращане': 'exception',
};

/** Waiting at an office: ready for pickup once the reply names the office storing it. */
const AT_OFFICE = new Set(['в офис', 'пристигнала в офис']);

/** The stage a summary status settles, given whether the reply names the office storing the parcel. */
export function econtSummaryStage(summary: string, stored: boolean): Stage | undefined {
  const key = normalizeStatusWording(summary);
  if (AT_OFFICE.has(key)) return stored ? 'ready_for_pickup' : undefined;
  return Object.hasOwn(SUMMARIES, key) ? SUMMARIES[key] : undefined;
}

/** Return-receipt scans share one code: they follow the signed receipt, not the parcel. */
export const RECEIPT_CODE = 'receipt';

/** Every scan carries a code; wording alone gets nothing. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code === null ? undefined : SCANS.get(code)?.stage),
  gaps: [
    { code: 'courier', note: 'A courier collecting the parcel from the sender or taking it out for delivery: the adapter reads which from the scans before it.' },
    { code: 'instruction', note: "An order changing the shipment's delivery terms, such as its delivery office; the parcel does not move." },
    { code: 'info', note: 'Free information the tracker shows without a milestone.' },
    { code: RECEIPT_CODE, note: 'A scan of the return receipt the recipient signed, travelling back to the sender, not of the parcel.' },
  ],
};

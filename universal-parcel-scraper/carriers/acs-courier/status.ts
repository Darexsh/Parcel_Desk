import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The English wording of the scans in ACS's full history. Scans carry no
 * code. A label printed by the sender's software or the branch's pickup list
 * records data, not the parcel; the courier's collection is the pickup from
 * the sender. "On delivery" is the parcel handed to a courier for delivery,
 * and SmartPoint is ACS's network of lockers and partner points.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  'Print ACSConnect/WebTools label': 'registered',
  'Print take delivery status': 'registered',
  'Pick-up from sender': 'accepted',
  // The same collection, worded short: the parcel's first scan, before its departure.
  'Pick-up': 'accepted',
  'Departure to destination': 'in_transit',
  'Transit from HUB': 'in_transit',
  'Arrival-departure from HUB': 'in_transit',
  'Arrival to': 'in_transit',
  'On delivery': 'out_for_delivery',
  'Shipment placed in SmartPoint': 'ready_for_pickup',
  'Not delivered': 'failed_attempt',
  'Delivery to consignee': 'delivered',
  'Delivery via SmartPoint': 'delivered',
};

/** Wording that names the next branch after it, as in "Departure to destination EXAMPLE 2". */
const PREFIXES: readonly (readonly [string, Stage])[] = [['departure to destination ', 'in_transit']];

/** Messages to the recipient: no movement, so the parcel keeps its stage. */
const NOTICES = ['SENT NOTIFICATION', 'SENT EMAIL NOTIFICATION'];

const SCAN_KEYS = new Map(Object.entries(SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const NOTICE_KEYS = new Set(NOTICES.map(normalizeStatusWording));

/** The stage the wording alone gives a scan, if any. */
export function acsScanStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return SCAN_KEYS.get(key) ?? PREFIXES.find(([prefix]) => key.startsWith(prefix) && key.length > prefix.length)?.[1];
}

/**
 * The milestones of the shortened history the Greek site shows, by their
 * `controlPid`. The fourth is a courier's round or a locker, which only its
 * wording tells apart.
 */
const MILESTONES = new Map<number, Stage>([[100, 'accepted'], [200, 'in_transit'], [300, 'in_transit'], [600, 'delivered']]);

export function acsMilestoneStage(id: number): Stage | undefined {
  return MILESTONES.get(id);
}

export function isAcsNotice(wording: string): boolean {
  return NOTICE_KEYS.has(normalizeStatusWording(wording));
}

/** One of the parcel's summary statuses: its English hint and its stage. */
interface AcsSummary {
  readonly wording: string;
  readonly stage: Stage;
  /** The newest scan's stage replaces it, when there is one. */
  readonly scansDecide?: boolean;
}

/**
 * The summary statuses the API's own list (`/api/parcels/shipment-statuses`)
 * defines, by id, with the English hint the page shows. Delivery problems,
 * returns and a delivered parcel settle the parcel's stage. An in-transit
 * summary leaves it to the scans, which say whether the parcel is out for
 * delivery or waiting at a SmartPoint. The list words status 5 "In Transit"
 * and describes it as damage or any other cause.
 */
const SUMMARIES = new Map<number, AcsSummary>([
  [1, { wording: 'Denial of delivery', stage: 'exception' }],
  [2, { wording: 'Attention required', stage: 'exception' }],
  [3, { wording: 'Absent', stage: 'failed_attempt' }],
  [4, { wording: 'Delivered', stage: 'delivered' }],
  [5, { wording: 'In Transit', stage: 'in_transit', scansDecide: true }],
  [6, { wording: 'Return in transit to sender', stage: 'exception' }],
  [7, { wording: 'Returned to sender', stage: 'returned' }],
  [8, { wording: 'In Transit', stage: 'in_transit', scansDecide: true }],
  [9, { wording: 'Pending', stage: 'exception' }],
]);

export function acsSummary(id: number): AcsSummary | undefined {
  return SUMMARIES.get(id);
}

/**
 * Full-history scans carry wording only, and notices are left without a stage
 * on purpose. A milestone of the shortened history carries its three-digit id;
 * a summary status is the provider code of a parcel without scans.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code === null ? acsScanStage(wording)
    : /^\d00$/.test(code) ? MILESTONES.get(Number(code))
      : /^\d$/.test(code) ? SUMMARIES.get(Number(code))?.stage : undefined,
  gaps: [
    ...[...NOTICE_KEYS].map(wording => ({
      wording, note: 'A message to the recipient, not a movement: the parcel keeps the stage it had.',
    })),
    { code: '400', note: "The fourth milestone is a courier's round or a SmartPoint locker, which only its wording tells apart." },
  ],
};

import type { ClassifiedStatus } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// Codes and their labels come from the official tracking widget. EN_ROUTE and
// OTHER also cover several distinct milestones and administrative notices.
const codes: Record<string, ClassifiedStatus> = {
  CREATED: { status: 'pending', stage: 'registered' },
  INFORMED: { status: 'pending', stage: 'registered' },
  EN_ROUTE: { status: 'in_transit', stage: 'in_transit' },
  AVAILABLE_FOR_DELIVERY: { status: 'in_transit', stage: 'ready_for_pickup' },
  DELIVERED: { status: 'delivered', stage: 'delivered' },
  DELIVERY_IMPOSSIBLE: { status: 'exception', stage: 'failed_attempt' },
  DELIVERY_REFUSED: { status: 'exception', stage: 'failed_attempt' },
  RETURNED: { status: 'exception', stage: 'returned' },
  DELAYED: { status: 'exception', stage: 'exception' },
  EXPECTED_DELAY: { status: 'exception', stage: 'exception' },
  STOPPED: { status: 'exception', stage: 'exception' },
  CUSTOMS_STOPPED_VAT: { status: 'exception', stage: 'customs' },
};

const accepted: ClassifiedStatus = { status: 'in_transit', stage: 'accepted' };
const moving: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };
const customs: ClassifiedStatus = { status: 'in_transit', stage: 'customs' };

/** A wording table keyed in `normalizeStatusWording` form. */
function byWording(table: Record<string, ClassifiedStatus>): ReadonlyMap<string, ClassifiedStatus> {
  return new Map(Object.entries(table).map(([wording, status]) => [normalizeStatusWording(wording), status]));
}

/** EN_ROUTE and OTHER wordings that name a milestone of their own. */
const milestones = byWording({
  'The delivery of the shipment item is in progress.': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'The shipment item is under transportation.': moving,
  'The shipment item has arrived at the distribution terminal.': moving,
  'Your item is being processed at our sorting center.': moving,
  'The shipment item has been loaded.': moving,
  'The shipment item has been dropped off by sender.': accepted,
  // Handed in at a service point after the day's last collection.
  'The shipment item has been dropped off after latest drop-off time.': accepted,
  'The shipment item has been picked-up for transportation.': accepted,
  'Customs VAT has been paid.': customs,
  'Import Charge sent to recipient.': customs,
});

/** STOPPED wordings for a parcel held on purpose rather than in trouble. */
const holds = byWording({
  'The shipment item is being customs cleared by us.': customs,
  'The shipment item is being held at a distribution terminal awaiting the booked delivery date or, awaiting an agreement of delivery with the recipient.': moving,
});

/** OTHER wordings for a notice to the recipient or the driver rather than a scan. */
const ADMINISTRATIVE = [
  'Suggested delivery time.',
  'Information to the driver added by the recipient.',
  'A text message notification has been delivered to the recipient.',
  'A text message notification has been sent to the recipient.',
  'A letter notification has been sent to the recipient.',
  'E-mail notification has been sent to the recipient.',
  'Notification sent via APP.',
  'Pick-up at servicepoint, selected by the receiver.',
];

export function isPostnordAdministrativeEvent(code: string, description: string): boolean {
  return code === 'OTHER' && ADMINISTRATIVE.includes(description);
}

export function classifyPostnordStatus(code: string, description = ''): ClassifiedStatus | undefined {
  const wording = normalizeStatusWording(description);
  if ((code === 'EN_ROUTE' || code === 'OTHER') && milestones.has(wording)) return milestones.get(wording);
  if (code === 'STOPPED' && holds.has(wording)) return holds.get(wording);
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}

/**
 * What the map says about one scan: its code, narrowed by its wording where the code covers
 * several milestones or a hold, as the parser reads it. Every scan carries a code; a copy
 * without one gets a stage only from wording that names a milestone or a hold of its own.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? classifyPostnordStatus(code, wording) : milestones.get(wording) ?? holds.get(wording))?.stage,
  gaps: ADMINISTRATIVE.map((wording) => ({ code: 'OTHER', wording: normalizeStatusWording(wording),
    note: 'A notice to the recipient or the driver, not a scan: the parser drops it, and a stored copy keeps the stage of the scan before it.' })),
};

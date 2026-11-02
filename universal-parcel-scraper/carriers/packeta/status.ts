/**
 * Packeta status vocabulary.
 *
 * Two independent maps, because Packeta reports status twice:
 * - `packetStatusId` on the parcel, a closed numeric vocabulary. An unmapped id
 *   is schema drift, so the result reports `unknown` rather than guessing.
 * - The event sentences in `trackingDetails[].text`. There is no per-event
 *   code; the request pins the locale to English and real parcels confirmed
 *   these sentences are canned templates, so fixed substring matching is safe.
 *   An unrecognized sentence keeps no stage: the sync classifies it and records
 *   where the final stage came from.
 *
 * Provenance: derived from the prior-art client
 * https://github.com/ha-parcel-integrations/ha-packeta (MIT), and from the id
 * names the public tracking page's own script declares (read 2026-10-09).
 * `packetStatusId` "3" (delivered), "4" (cancelled), "5" (returned to sender)
 * and "21" are live-confirmed; the other ids are reconstructed. The script also
 * names SENT_BY_MAIL, TO_BE_SENT_BY_MAIL and PROBLEMATIC_CAPTURE, left unmapped
 * because their names do not say where the parcel is. The event sentences were
 * confirmed live on 2026-08-19 against real delivered parcels (values
 * fictionalized in that project's fixtures); the return's sentence on 2026-10-09.
 */
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const RETURNED: ClassifiedStatus = { status: 'exception', stage: 'returned' };
const EXCEPTION: ClassifiedStatus = { status: 'exception', stage: 'exception' };

const PACKET_STATUS: Record<string, ClassifiedStatus> = {
  // TO_BE_PROCESSED
  '997': { status: 'pending', stage: 'registered' },
  // WAITING_FOR_DELIVERY (in warehouse)
  '1': { status: 'in_transit', stage: 'in_transit' },
  // ON_THE_WAY
  '31': { status: 'in_transit', stage: 'in_transit' },
  // READY_FOR_PICKUP
  '2': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  // READY_LAST_DAY: the last day it waits at the point
  '996': { status: 'out_for_delivery', stage: 'ready_for_pickup' },
  // ISSUED_AND_ACCOUNTED (live-confirmed delivered wording:
  // "The package has been delivered")
  '3': { status: 'delivered', stage: 'delivered' },
  // CANCELLED
  '4': EXCEPTION,
  // RETURNED_AND_ACCOUNTED (live wording "Returned to sender")
  '5': RETURNED,
  // RETURN
  '20': RETURNED,
  // TO_BE_RETURNED
  '998': RETURNED,
  // Named LOST_OR_UNKNOWN in the page's script, but worded "Return (on the way
  // back)" live.
  '21': RETURNED,
  // CLOSED_BY_PROTOCOL
  '22': EXCEPTION,
  // LONG_TERM_RETURN
  '24': RETURNED,
  // TO_BE_DISPOSED
  '33': EXCEPTION,
};

const EVENT_TEXT_STAGES: Array<[substring: string, stage: Stage]> = [
  ['aware of your parcel and are waiting for the sender', 'registered'],
  ['assigned a tracking number', 'registered'],
  ['successfully received the parcel for transport', 'in_transit'],
  ['on its way to the depot', 'in_transit'],
  ['arrived at the depot', 'in_transit'],
  ['has been handed over to the carrier', 'in_transit'],
  ['on its way to you', 'out_for_delivery'],
  ['ready for pickup', 'ready_for_pickup'],
  ['the parcel is with you', 'delivered'],
  ['investigating the status of the parcel', 'failed_attempt'],
  ['returned the parcel back to the sender', 'returned'],
];

/** The stage and status for a `packetStatusId`, or undefined when unmapped. */
export function classifyPacketaStatus(code: string): ClassifiedStatus | undefined {
  return PACKET_STATUS[code];
}

/** The stage for one canned English event sentence, or null when unrecognized. */
export function packetaEventStage(rawDescription: string): Stage | null {
  const value = rawDescription.toLocaleLowerCase('en-US');
  for (const [substring, stage] of EVENT_TEXT_STAGES) {
    if (value.includes(substring)) return stage;
  }
  return null;
}

/**
 * What the map says about one scan: its sentence, the only key a scan has. The
 * parcel's `packetStatusId` stages the parcel, never a scan.
 */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => packetaEventStage(wording) ?? undefined, gaps: [] };

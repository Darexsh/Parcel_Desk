import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Gebrüder Weiss reports each status event under a family, an event code and,
 * for most, a reason code. A scan's provider code joins the three with
 * slashes, as `RDGW/850/009`. The road network's family is `RDGW`; air, sea,
 * home-delivery services and warehouses report under families of their own
 * whose codes mean other things, so the map reads only `RDGW`. The wording is
 * the short English the service sends with each event; the codes and the
 * page's fuller wording come from its translation file.
 */
const CODE = /^RDGW\/([0-9A-Z*]{1,10})(?:\/([0-9A-Z]{1,10}))?$/;

/** Events whose every reason gives the same stage. */
const EVENTS: ReadonlyMap<string, Stage> = new Map([
  // Unloaded at a depot, in full or in part.
  ['00', 'in_transit'],
  ['02', 'in_transit'],
  // A collection that did not happen yet: the order is with Gebrüder Weiss, the goods are not.
  ['450', 'registered'],
  ['400', 'accepted'],
  // Designated for delivery, unloaded, loaded and on the long haul between depots.
  ['170', 'in_transit'],
  ['180', 'in_transit'],
  ['190', 'in_transit'],
  ['290', 'in_transit'],
  // Collected by the consignee, or delivered with damage or a shortage.
  ['635', 'delivered'],
  ['820', 'delivered'],
  ['825', 'delivered'],
  ['830', 'delivered'],
]);

/** Events whose reason decides the stage. */
const REASONS: ReadonlyMap<string, Stage> = new Map([
  ['113/A54', 'registered'],
  ['301/503', 'accepted'],
  // Departures, hubs and the route to the delivery depot.
  ['110/010', 'in_transit'],
  ['110/110', 'in_transit'],
  ['110/120', 'in_transit'],
  ['110/130', 'in_transit'],
  // Held back from the day's round for an agreed notice or date; forwarded to a partner.
  ['165/017', 'in_transit'],
  ['165/019', 'in_transit'],
  ['165/057', 'in_transit'],
  ['165/058', 'in_transit'],
  ['165/059', 'in_transit'],
  ['165/060', 'in_transit'],
  ['165/095', 'in_transit'],
  ['165/140', 'in_transit'],
  ['166/803', 'in_transit'],
  ['166/GE2', 'in_transit'],
  ['300/CLI', 'in_transit'],
  ['405/500', 'in_transit'],
  ['405/506', 'in_transit'],
  ['405/508', 'in_transit'],
  ['610/E61', 'in_transit'],
  ['810/058', 'in_transit'],
  ['810/059', 'in_transit'],
  // Customs goods a gateway holds back.
  ['165/136', 'customs'],
  ['165/143', 'customs'],
  ['300/054', 'out_for_delivery'],
  ['300/LOG', 'out_for_delivery'],
  ['300/MOB', 'out_for_delivery'],
  ['610/E29', 'out_for_delivery'],
  ['165/072', 'delivered'],
  ['610/E01', 'delivered'],
  ['610/E02', 'delivered'],
  ['610/E11', 'delivered'],
  ['810/012', 'delivered'],
  ['810/072', 'delivered'],
  ['810/172', 'delivered'],
  // Not delivered, with a new delivery planned or agreed.
  ['850/008', 'failed_attempt'],
  ['850/009', 'failed_attempt'],
  ['850/018', 'failed_attempt'],
  ['850/019', 'failed_attempt'],
  ['850/056', 'failed_attempt'],
  ['850/062', 'failed_attempt'],
  ['850/063', 'failed_attempt'],
  ['850/064', 'failed_attempt'],
  ['850/084', 'failed_attempt'],
  ['850/099', 'failed_attempt'],
  ['610/E25', 'failed_attempt'],
  ['610/E33', 'failed_attempt'],
  ['610/E51', 'failed_attempt'],
  // Refused, damaged, lost or outside the delivery area.
  ['165/003', 'exception'],
  ['850/010', 'exception'],
  ['850/074', 'exception'],
  ['850/080', 'exception'],
  ['850/081', 'exception'],
  ['850/082', 'exception'],
  ['850/083', 'exception'],
  ['850/085', 'exception'],
  ['850/090', 'exception'],
  ['850/100', 'exception'],
  ['610/E21', 'exception'],
  ['610/E22', 'exception'],
  ['610/E23', 'exception'],
  ['610/E24', 'exception'],
  ['610/E26', 'exception'],
  ['610/E63', 'exception'],
  ['610/E64', 'exception'],
  ['610/E65', 'exception'],
  ['860/003', 'exception'],
  ['860/011', 'exception'],
  ['860/066', 'exception'],
  ['860/077', 'exception'],
  // Refused and sent back to the sending depot.
  ['860/067', 'returned'],
  ['860/068', 'returned'],
  ['610/E50', 'returned'],
]);

/** Events that move nothing, whatever their reason, keyed as `RDGW/{event}`. */
const QUIET_EVENTS: ReadonlyMap<string, string> = new Map([
  ['120', 'Messages and delivery bookings with the consignee: they move nothing.'],
  ['641', 'Notices, services and internal transfers around a delivery; none says where the goods are.'],
  ['650', 'A delivery date agreed or requested: a plan, not a movement.'],
  ['870', 'Proof of delivery, photos and signatures archived after the delivery.'],
  ['871', 'Internal archiving.'],
  ['875', 'An electronic signature archived after the delivery.'],
  ['876', 'A depot starting to scan a vehicle it unloads.'],
  ['877', 'A depot finishing the scan of a vehicle it unloaded.'],
  ['878', 'A depot starting to scan a vehicle it loads.'],
  ['879', 'A depot finishing the scan of a vehicle it loaded.'],
]);

/** Single codes that move nothing. */
const QUIET_CODES: ReadonlyMap<string, string> = new Map([
  ['RDGW/110/170', 'A text message or email sent to the consignee.'],
  ['RDGW/110/180', 'A text message or email that could not be sent.'],
  ['RDGW/166/138', 'The time a vehicle reached the consignee or the shipper; the scan after it says what happened.'],
  ['RDGW/100/904', 'Proof of delivery archived.'],
  ['RDGW/405/504', 'Handed to a contractor who answers for the delivery; it does not say the consignee has the goods.'],
]);

/** The provider code of a status event: its family, event and reason. */
export function gebruederWeissCode(family: string, event: string, reason: string): string {
  return [family, event, reason].filter(Boolean).join('/');
}

/** The key the map's gaps use: whole events for the quiet ones, else the code itself. */
function keyOf(code: string): string {
  const event = CODE.exec(code)?.[1];
  return event !== undefined && QUIET_EVENTS.has(event) ? `RDGW/${event}` : code;
}

/** Whether a provider code moves nothing. */
function quiet(code: string): boolean {
  const event = CODE.exec(code)?.[1];
  return QUIET_CODES.has(code) || (event !== undefined && QUIET_EVENTS.has(event));
}

/** The stage the map gives a road event's provider code, if it knows it. */
export function gebruederWeissCodeStage(code: string): Stage | undefined {
  const match = CODE.exec(code);
  if (!match || quiet(code)) return undefined;
  const [, event, reason] = match;
  return (reason === undefined ? undefined : REASONS.get(`${event}/${reason}`)) ?? EVENTS.get(event!);
}

/**
 * A scan's stage from the map, else from the shared wording rules. Codes that
 * move nothing get none, so the parcel keeps the stage it had.
 */
export function gebruederWeissStage(code: string, wording: string): ClassifiedWording | null {
  if (quiet(code)) return null;
  const mapped = gebruederWeissCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  codeKey: keyOf,
  stage: (code) => (code ? gebruederWeissCodeStage(code) : undefined),
  gaps: [
    ...[...QUIET_EVENTS].map(([event, note]) => ({ code: `RDGW/${event}`, note })),
    ...[...QUIET_CODES].map(([code, note]) => ({ code, note })),
  ],
};

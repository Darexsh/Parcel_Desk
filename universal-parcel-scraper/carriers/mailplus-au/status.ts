import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event names MailPlus's tracker gives, in lower case. Its own steps come with a note that
 * says more; the scans of the carrier it lodged a parcel with come under that carrier's own
 * wording, which some partners pair with a bare status such as `Intransit` at the same minute.
 */
const NAMES: Readonly<Record<string, Stage>> = {
  // A booked collection the sender has not handed over yet: the page reads it alone as "not
  // dispatched by sender". The shared rules would read it as waiting for the recipient.
  'ready for collection': 'registered',
  'picked up': 'accepted',
  // "Parcel processing at depot": the parcel reached MailPlus's depot, or the carrier it is lodged with.
  lodged: 'in_transit',
  // The lodging partner's pre-advice, after MailPlus collected the parcel.
  'shipment created': 'registered',
  'shipping information received by australia post': 'registered',
  initiated: 'registered',
  'picked up from sender': 'accepted',
  intransit: 'in_transit',
  'pickup and in transit': 'in_transit',
  'item processed at sorting facility': 'in_transit',
  'out for delivery': 'out_for_delivery',
  // The shared rules do not read "onboard" as a delivery round.
  'onboard for delivery': 'out_for_delivery',
  delivered: 'delivered',
};

const key = (name: string) => name.toLowerCase().trim().split(/\s+/).join(' ');

/** The stage MailPlus's map gives an event name. */
export function mailplusMappedStage(name: string): Stage | undefined {
  return Object.hasOwn(NAMES, key(name)) ? NAMES[key(name)] : undefined;
}

/** An event's stage: the map's for its name, else the shared rules' for its note or name, else nothing. */
export function mailplusStage(name: string, note: string): ClassifiedWording | null {
  const mapped = mailplusMappedStage(name);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const wording of [note, name]) {
    if (!wording) continue;
    const worded = classifyWording(wording, 'in_transit');
    if (worded.source !== 'none') return worded;
  }
  return null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? mailplusMappedStage(code) : undefined),
  gaps: [],
};

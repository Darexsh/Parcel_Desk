import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * UBI's tracker files every scan under one of its own event codes, its hubs'
 * scans and those it relays from the destination's carrier alike. Most codes
 * name one milestone. `SCN` is any scan on the way, the partner's included,
 * and `INF` covers shipping information, a partner's notices and the arrival
 * at the destination airport: their wording decides.
 */
const CODES: Readonly<Record<string, Stage>> = {
  RCV: 'accepted',
  // The flight UBI books from its hub (the page's "Planning Depart").
  LHL: 'in_transit',
  // Customs that cleared the parcel puts it back in transit.
  'CCD-EXP': 'in_transit',
  CCD: 'in_transit',
  ARR: 'in_transit',
  BSE: 'in_transit',
  // The destination's carrier takes the parcel over.
  HDD: 'in_transit',
  'INF-OFD': 'out_for_delivery',
  DLD: 'delivered',
};

/** Wordings of the codes that need one, in `normalizeStatusWording` form. */
const WORDINGS: Readonly<Record<string, Readonly<Record<string, Stage>>>> = {
  SCN: {
    'processed at origin hub': 'in_transit',
    'item despatched to transshipment hub': 'in_transit',
    'item processed at post facility': 'in_transit',
    'processed through australia post facility': 'in_transit',
    transferred: 'in_transit',
  },
  INF: {
    'shipping information received': 'registered',
    'shipping information received by australia post': 'registered',
    'shipping information approved by australia post': 'registered',
    'electronic information submitted by shipper': 'registered',
    // Aramex's notice that the parcel is on its way to it, in UBI's words.
    'the sender is now completing the final steps to prepare your parcel for pick-up. we’ll send another update when the parcel is in the hands of an aramex courier.': 'registered',
    'arrived at destination airport': 'in_transit',
  },
};

// A partner's notice, not a movement: the parcel keeps the stage it had.
const NOTICES: ReadonlySet<string> = new Set(['expected delivery date updated']);

/** The stage the map gives a scan's code and wording, if it knows it. */
export function ubiMappedStage(code: string, wording: string): Stage | undefined {
  if (Object.hasOwn(WORDINGS, code)) {
    const wordings = WORDINGS[code]!;
    const key = normalizeStatusWording(wording);
    return Object.hasOwn(wordings, key) ? wordings[key] : undefined;
  }
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

/** A partner's notice that moved nothing. */
export function isUbiNotice(code: string, wording: string): boolean {
  return code === 'INF' && NOTICES.has(normalizeStatusWording(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. A notice
 * and wording neither knows stay without a stage, so they remain visible for
 * review.
 */
export function ubiStage(code: string, wording: string): ClassifiedWording | null {
  if (isUbiNotice(code, wording)) return null;
  const mapped = ubiMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its event code and wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? ubiMappedStage(code, wording) : undefined),
  gaps: [...NOTICES].map((wording) => ({
    code: 'INF', wording, note: 'A partner’s notice that its delivery estimate changed, not a movement: the parcel keeps the stage it had.',
  })),
};

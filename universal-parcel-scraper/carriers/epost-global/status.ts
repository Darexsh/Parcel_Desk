import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { osmCodeStage } from '../osm-worldwide/status.js';

/**
 * ePost Global's English wording. Its rows carry a code, but rows it relays
 * from the partner that delivers the parcel keep the partner's code, so a code
 * alone names no scan: PostNL's 30 is ePost Global's 30. The map reads the
 * wording: ePost Global's own, then the partners' that the shared wording
 * rules leave without a stage. Other partner wording goes to those rules.
 * OSM Worldwide's codes name it ("OSM04"), so its rows read as OSM's own do.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['data received', 'registered'],
  // Stamped a minute after the data, every time: the label, not a scan.
  ['shipment in transit to the epost global processing center', 'registered'],
  ['parcel received and processing', 'accepted'],
  ['parcel shipped', 'in_transit'],
  // The handover a minute after shipping, without the service it goes to.
  ['in transit', 'in_transit'],
  // DAI Post, for New Zealand: its manifest, then its origin hub and the airline.
  ['customer information manifested', 'registered'],
  ['checked in at origin hub', 'in_transit'],
  ['airline delay', 'in_transit'],
  ['collected from the airline for processing', 'in_transit'],
  // PostNL, through Spring.
  ['the item is tied to a mawb and ready for shipment', 'in_transit'],
  // La Poste's wording for parcels PostNL brings to France, after they left the United States.
  ['your item has been dropped off by the sender with our postal partner in the country of origin.', 'in_transit'],
  ['your item is ready to be forwarded from its foreign territory. it will be given to the carrier for forwarding.', 'in_transit'],
]);

// The handover a minute after shipping: "In transit to {service} tracking #: {number}".
const HANDED_OVER = /^in transit (?:to|via) \S.* tracking ?#:/;
// A row relayed from OSM Worldwide, under its code.
const OSM_CODE = /^OSM\d{2}$/;

// The rows ePost Global's processing centers scan, stamped on the center's clock.
const FACILITY_SCANS = new Set(['parcel received and processing', 'parcel shipped']);

/** The stage the map gives a row relayed from OSM Worldwide by its code, else the wording, if it knows it. */
export function epostGlobalScanStage(wording: string, code = ''): Stage | undefined {
  const relayed = OSM_CODE.test(code) ? osmCodeStage(code) : undefined;
  if (relayed) return relayed;
  const normalized = normalizeStatusWording(wording);
  return HANDED_OVER.test(normalized) ? 'in_transit' : STAGES.get(normalized);
}

/** A scan at one of ePost Global's processing centers. */
export function epostGlobalFacilityScan(wording: string): boolean {
  return FACILITY_SCANS.has(normalizeStatusWording(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function epostGlobalStage(wording: string, code = ''): ClassifiedWording | null {
  const mapped = epostGlobalScanStage(wording, code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Codes are shared with the partners' own, so only OSM Worldwide's and the wording are read. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => epostGlobalScanStage(wording, code ?? ''),
  gaps: [],
};

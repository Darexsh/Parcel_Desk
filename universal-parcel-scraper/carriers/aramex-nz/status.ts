import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { aramexStageMap } from '../aramex-au/status.js';

/**
 * The headings Aramex New Zealand's tracking page shows for its scans, in
 * `normalizeStatusWording` form. A heading decides first: the page files a
 * scan between depots under a depot's code.
 */
const HEADINGS: Readonly<Record<string, Stage>> = {
  // The courier could not collect the parcel: Aramex still has not got it.
  'attempted collection': 'registered',
  'picked up from sender': 'accepted',
  'in transit': 'in_transit',
  'awaiting customs clearance': 'customs',
  // Customs cleared the parcel, which carries on.
  'cleared by customs': 'in_transit',
  // A parcel from abroad reaches the New Zealand network.
  'arrived in destination country': 'in_transit',
  // Aramex hands the parcel on to NZ Post for a rural delivery.
  'delivery onforwarded': 'in_transit',
  'onboard for delivery': 'out_for_delivery',
  'attempted delivery': 'failed_attempt',
  delivered: 'delivered',
};

/**
 * The page script's own groups of codes, for a heading the map does not know.
 * Its group of scans before pickup also holds codes of a parcel's leg abroad
 * and its problem group mixes failures with other notices, so those codes are
 * left to their wording, as is `DVR`, which it counts both as delivered and as
 * handed on to another carrier.
 */
const GROUPS: readonly (readonly [Stage, readonly string[]])[] = [
  ['registered', ['IOC', 'PP0', 'PP2', 'PP4']],
  ['accepted', ['PPP', 'Z30', 'Z32']],
  ['in_transit', ['TRN']],
  // The page shows a parcel with a rural freight partner as onboard with the courier, due today.
  ['out_for_delivery', ['ONB', 'RUO']],
  // A calling card: the courier found no one.
  ['failed_attempt', ['CCL', 'CCQ', 'Y14', 'E14']],
  ['ready_for_pickup', ['CCP', 'MDC']],
  ['returned', ['RTS']],
  ['delivered', ['ATL', 'CLS', 'DRU', 'LAI', 'NEI', 'PCY', 'PRS', 'R34', 'R35', 'R36', 'RUD', 'YES', 'X03', 'SPD']],
];

const NEW_ZEALAND = aramexStageMap(HEADINGS, GROUPS);

/** The stage the map gives a scan's code and heading, if it knows either. */
export const aramexNzMappedStage = NEW_ZEALAND.mapped;

/**
 * A scan's stage from its heading, then its code, then the shared wording
 * rules. A scan none of them knows stays without a stage, so it remains
 * visible for review.
 */
export const aramexNzStage = NEW_ZEALAND.stage;

/** What the map says about one scan, by its code and heading. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => aramexNzMappedStage(code ?? '', wording),
  gaps: [],
};

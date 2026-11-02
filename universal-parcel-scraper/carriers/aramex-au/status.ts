import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The stage map of one Aramex network on the shared tracker: the headings its
 * page shows, in `normalizeStatusWording` form, then its page script's groups
 * of codes, then the shared wording rules.
 */
export function aramexStageMap(headings: Readonly<Record<string, Stage>>, groups: readonly (readonly [Stage, readonly string[]])[]) {
  const codes: ReadonlyMap<string, Stage> = new Map(groups.flatMap(([stage, list]) => list.map((code) => [code, stage] as const)));
  const mapped = (code: string, heading: string): Stage | undefined => {
    const key = normalizeStatusWording(heading);
    return (Object.hasOwn(headings, key) ? headings[key] : undefined) ?? codes.get(code);
  };
  const stage = (code: string, heading: string): ClassifiedWording | null => {
    const known = mapped(code, heading);
    if (known) return { stage: known, source: 'carrier_map' };
    const worded = classifyWording(heading, 'in_transit');
    return worded.source === 'none' ? null : worded;
  };
  return { mapped, stage };
}

/**
 * The headings the tracking page shows for its scans, in
 * `normalizeStatusWording` form. A heading decides first: one code can carry
 * several headings, and the page script's code groups lag behind them (it
 * still counts `PP1`, "Picked up from sender", as a scan before pickup).
 */
const HEADINGS: Readonly<Record<string, Stage>> = {
  'tracking number allocated': 'registered',
  'consignment information submitted': 'registered',
  'consignment is being processed': 'registered',
  'sender preparing parcel for pick-up': 'registered',
  'picked & packed': 'registered',
  // The sender does not have the parcel ready: Aramex still has not got it.
  'not ready for collection': 'registered',
  'picked up from sender': 'accepted',
  'pick-up': 'accepted',
  'in transit': 'in_transit',
  'parcel in transit': 'in_transit',
  'your parcel is in our care': 'in_transit',
  'received into depot': 'in_transit',
  // Customs cleared the parcel, which carries on.
  'processed by customs': 'in_transit',
  'onboard for delivery': 'out_for_delivery',
  onboard: 'out_for_delivery',
  delivered: 'delivered',
  'authority to leave': 'delivered',
};

/**
 * The page script's own groups of scan codes, for a heading the map does not
 * know. Its problem group mixes failures with customs clearance and other
 * notices, so those codes are left to their wording.
 */
const GROUPS: readonly (readonly [Stage, readonly string[]])[] = [
  ['registered', ['ARP', 'PP2', 'PP3', 'PP4', 'PP5', 'PP7', 'PP8', 'FUT', 'EBA', 'RL1', 'OWD', 'OWP', 'PC1', 'NOC', 'NOH']],
  ['accepted', ['PPP', 'WIN', 'PIC', 'AM1', 'Y21']],
  // A scan at a depot, filed under the depot's own code, and the receipt at one.
  ['in_transit', ['CBR', 'TVL', 'BLT', 'TMW', 'TOO', 'DPO', 'GOU', 'SYD', 'MKY', 'DUB', 'UNW', 'BRI', 'MEL', 'BDB', 'NTH', 'GLS',
    'PQQ', 'OAG', 'GFT', 'CCT', 'WGG', 'LAU', 'DAR', 'GFF', 'MYB', 'DDY', 'NWN', 'SUN', 'KLM', 'PER', 'YNG', 'ADL', 'WOL', 'CAP', 'GEE',
    'CFS', 'NEW', 'TAS', 'GLD', 'CNS', 'ALB', 'BAT', 'BEN', 'PRP', 'TUL', 'KNY', 'RID', 'RIA']],
  ['out_for_delivery', ['ONB', 'RUO']],
  // A calling card: the courier found no one and left the parcel to collect or redeliver.
  ['failed_attempt', ['CAR', 'CC1', 'CC2', 'CC3', 'CC4', 'CC5', 'CC6', 'CCL', 'CCR', 'CCQ']],
  ['ready_for_pickup', ['CCP', 'CKN', 'MDC']],
  ['returned', ['RTS', 'OW5', 'PCR', 'RSS', 'RPP']],
  ['delivered', ['YES', 'PCY', 'R36', 'ATL', 'LAI', 'PRS', 'R34', 'R35', 'DRU', 'YEA', 'ALL', 'CLS', 'SIG', 'CCD', 'SPD', 'NEI']],
];
const AUSTRALIA = aramexStageMap(HEADINGS, GROUPS);

/** The stage the map gives a scan's code and heading, if it knows either. */
export const aramexAuMappedStage = AUSTRALIA.mapped;

/**
 * A scan's stage from its heading, then its code, then the shared wording
 * rules. A scan none of them knows stays without a stage, so it remains
 * visible for review.
 */
export const aramexAuStage = AUSTRALIA.stage;

/** What the map says about one scan, by its code and heading. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => aramexAuMappedStage(code ?? '', wording),
  gaps: [],
};

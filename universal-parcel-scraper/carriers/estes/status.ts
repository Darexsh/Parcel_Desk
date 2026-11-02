import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Estes's reason codes (`reasonCode`), from the developer portal's delivery
 * no-service, bring-back and exception tables. Estes files a refused,
 * returned or undelivered stop under its Delivered milestone, so the code,
 * not the milestone, says whether the freight reached the consignee. Freight
 * handed to an interline or final delivery partner, or to a broker at the
 * border, has left Estes on its way and is not delivered yet.
 */
const CODES: Readonly<Record<string, Stage>> = {
  OK: 'delivered', BBC: 'delivered', CLO: 'delivered', DPU: 'delivered', NB: 'delivered',
  DD: 'delivered', DO: 'delivered', DS: 'delivered', DSW: 'delivered', PL: 'delivered', PR: 'delivered', DPR: 'delivered', OP: 'delivered',
  CTI: 'in_transit', DOI: 'in_transit', DDI: 'in_transit', DSI: 'in_transit', DM: 'in_transit', DI: 'in_transit',
  AGT: 'in_transit', L2L: 'in_transit', RDD: 'in_transit', EXL: 'in_transit', RCC: 'in_transit',
  BRK: 'customs', INB: 'customs',
  LT: 'out_for_delivery', PUD: 'out_for_delivery', SND: 'out_for_delivery',
  BK: 'failed_attempt', CO: 'failed_attempt', CT: 'failed_attempt', EQ: 'failed_attempt', HF: 'failed_attempt', HL: 'failed_attempt',
  NF: 'failed_attempt', NR: 'failed_attempt', OH: 'failed_attempt', OV: 'failed_attempt', PW: 'failed_attempt', ST: 'failed_attempt',
  UL: 'failed_attempt', UNL: 'failed_attempt', UP: 'failed_attempt', WDL: 'failed_attempt', CutOffResolved: 'failed_attempt',
  EndofDayResolved: 'failed_attempt', RF: 'failed_attempt', RD: 'failed_attempt', RS: 'failed_attempt', DRF: 'failed_attempt',
  DRD: 'failed_attempt', DRS: 'failed_attempt',
  DTS: 'returned', RTS: 'returned', RTI: 'returned',
  DB: 'exception', DCA: 'exception', DRC: 'exception', RCN: 'exception', SSR: 'exception', DMP: 'exception', NFT: 'exception',
};

/**
 * Estes's own wordings (`expandedStatus`), as the developer portal lists
 * them, in normalized form; a facility's name, state and number follow the
 * "at". The specific completions come before the general one. A pickup that
 * was attempted, failed or rescheduled leaves the freight with the shipper.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^(?:pickup location serviced|shipment picked up)$/, 'accepted'],
  [/^pickup (?:attempted|exception|rescheduled)\b/, 'registered'],
  [/^(?:(?:loaded|trailer closed|arrived) at|departed) estes facility at /, 'in_transit'],
  [/^en route to (?:estes|delivery) facility at /, 'in_transit'],
  [/^arrived at .+ delivery facility$/, 'in_transit'],
  [/^(?:loaded for delivery|trailer closed for delivery|assigned to driver) at /, 'in_transit'],
  [/^shipment released by customs$/, 'in_transit'],
  [/^shipment not released at border\b/, 'customs'],
  [/^(?:out for delivery|arrived at delivery location|unload(?:ed)? at delivery location)$/, 'out_for_delivery'],
  [/^delivery completed - (?:delivered (?:short )?to interline partner|delivered to broker at border)/, 'in_transit'],
  [/^delivery completed - (?:refused and estes handling disposal|no freight over 30 days)/, 'exception'],
  [/^delivery completed\b/, 'delivered'],
  [/^(?:delivery attempted|unable to deliver)\b/, 'failed_attempt'],
  [/^undelivered - returned to /, 'returned'],
  [/^undelivered\b/, 'exception'],
  [/^awaiting delivery - /, 'in_transit'],
  [/^delivery in progress - (?:documents submitted to broker|freight in bond)/, 'customs'],
  [/^delivery in progress - freight given to consignee\b/, 'out_for_delivery'],
  [/^delivery in progress - freight given to estes ltl/, 'in_transit'],
];

/**
 * The milestones (`conciseStatus`) the tracking page lights on its progress
 * rail. Delivered is left out: Estes files refused and returned stops under it.
 */
const MILESTONES: Readonly<Record<string, Stage>> = {
  'Departed Pickup Location': 'accepted',
  'Picked Up': 'accepted',
  'In Transit': 'in_transit',
  'Out for Delivery': 'out_for_delivery',
};

/** The pickup tables reuse delivery codes (NF, RS, CO…) with other meanings. */
function pickupWording(wording: string): boolean {
  return /^pickup\b/.test(wording);
}

/** The stage the map gives a reason code, if it knows it. */
export function estesCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

/** The stage the map gives wording, in any case and spacing, if it knows it. */
export function estesWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** What a status row says besides its code and wording. */
export interface EstesStatusFlags {
  readonly milestone: string;
  readonly isException: boolean;
}

/**
 * A status row's stage: its reason code outside a pickup, then Estes's
 * wording, then the exception flag, then the milestone, then the shared
 * wording rules. A Delivered milestone without a code or wording the map
 * knows counts as delivered only without the exception flag.
 */
export function estesStage(code: string, wording: string, flags: EstesStatusFlags): ClassifiedWording | null {
  const coded = code && !pickupWording(normalizeStatusWording(wording)) ? estesCodeStage(code) : undefined;
  const mapped = coded
    ?? estesWordingStage(wording)
    ?? (flags.isException ? 'exception' : undefined)
    ?? (Object.hasOwn(MILESTONES, flags.milestone) ? MILESTONES[flags.milestone] : undefined)
    ?? (flags.milestone === 'Delivered' ? 'delivered' : undefined);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its reason code outside a pickup, else by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code && !pickupWording(wording) ? estesCodeStage(code) : undefined) ?? estesWordingStage(wording),
  gaps: [],
};

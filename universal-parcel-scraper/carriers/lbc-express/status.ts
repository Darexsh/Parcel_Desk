import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

export const RELEASED = 'Released to authorized representative';

const DELIVERED: ClassifiedStatus = { status: 'delivered', stage: 'delivered' };

// LBC's own scan wordings, as the web history and the app's code 0 word them.
const WORDINGS: readonly [RegExp, ClassifiedStatus][] = [
  [/^(?:Delivered|Released to authorized representative)$/, DELIVERED],
  [/^Please expect delivery within the day\.$/, { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  [/^(?:Shipment has been accepted at\s+.+\.|PICKED UP BY LBC)$/, { status: 'in_transit', stage: 'accepted' }],
  [/^(?:Shipment has been received at\s+.+\.$|Shipment is en route to\s+.+\.|Shipment has left the origin\b)/, { status: 'in_transit', stage: 'in_transit' }],
];

/** The stage LBC's own scan wording names. */
export function classifyLbcWording(description: string): ClassifiedStatus | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(description))?.[1];
}

const CODES: Readonly<Record<string, ClassifiedStatus>> = {
  '1': DELIVERED,
  '4': { status: 'exception', stage: 'failed_attempt' },
  // Released to an authorized representative.
  '5': DELIVERED,
  '8000': { status: 'in_transit', stage: 'accepted' },
  '8002': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  '8810': { status: 'in_transit', stage: 'in_transit' },
  '8820': { status: 'in_transit', stage: 'in_transit' },
  '1004': { status: 'in_transit', stage: 'in_transit' },
};

/** An app scan's stage. Code 0 carries several kinds of scan, which LBC's wording tells apart. */
export function classifyLbcScan(code: string, description: string): ClassifiedStatus | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : code === '0' ? classifyLbcWording(description) : undefined;
}

const STORED_WORDINGS = WORDINGS.map(([pattern, status]) => [new RegExp(pattern.source, 'i'), status] as const);

/**
 * What the map says about one scan: its code, or for a scan stored from the old website,
 * which has none, its wording, as the adapter reads them.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code !== null && code !== '0' ? classifyLbcScan(code, '')
    : STORED_WORDINGS.find(([pattern]) => pattern.test(wording))?.[1])?.stage,
  gaps: [],
};

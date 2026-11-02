import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const filed = (codes: readonly string[], stage: Stage, status: ClassifiedStatus['status']): Record<string, ClassifiedStatus> =>
  Object.fromEntries(codes.map((code) => [code, { stage, status }]));

// Event codes of the public shipments gateway. A code not listed takes its
// milestone label, which groups several scans: a customer's safe-place request
// sits under whatever milestone the parcel had reached. Customs clearance on
// the way out counts as transit, and an item awaiting collection abroad is not
// delivered although its milestone says so.
const CODES: Record<string, ClassifiedStatus> = {
  ...filed(['ADMIN-ER39', 'ADMIN-ER40'], 'registered', 'pending'),
  ...filed(['AFC-ER15', 'AFC-ER16', 'AFC-ER31', 'AFC-ER36', 'INT-0001', 'INT-2144'], 'accepted', 'in_transit'),
  ...filed(['AFP-ER37', 'AFP-ER59', 'AFP-ER73', 'AFP-ER87', 'NSS-ER42', 'NSS-ER46', 'TDD-ER37', 'TTP-ER8', 'TTP-ER14',
    'TTP-ER21', 'TTP-ER37', 'TTP-ER81', 'DOM-0033', 'DOM-0035', 'DOM-0046', 'INT-0008', 'INT-0032', 'INT-0035',
    'INT-0071', 'INT-2164', 'INT-2165', 'INT-2171', 'INT-2177', 'INT-2180', 'INT-2185'], 'in_transit', 'in_transit'),
  ...filed(['INT-0030', 'INT-0031', 'INT-0044'], 'customs', 'in_transit'),
  ...filed(['AFP-ER13', 'INT-0074'], 'out_for_delivery', 'out_for_delivery'),
  ...filed(['DD-ER5', 'DD-ER11', 'INT-0036'], 'failed_attempt', 'exception'),
  ...filed(['DD-ER4', 'NT-ER4', 'INT-0075'], 'ready_for_pickup', 'in_transit'),
  ...filed(['DD-ER13', 'DD-ER14', 'DD-ER15', 'DD-ER37', 'DD-ER38', 'INT-0037'], 'delivered', 'delivered'),
};
const LABELS: Record<string, ClassifiedStatus> = {
  'delivered': { stage: 'delivered', status: 'delivered' },
  "it's coming today": { stage: 'out_for_delivery', status: 'out_for_delivery' },
  'onboard for delivery': { stage: 'out_for_delivery', status: 'out_for_delivery' },
  'out for delivery': { stage: 'out_for_delivery', status: 'out_for_delivery' },
  "it's on its way": { stage: 'in_transit', status: 'in_transit' },
  'in transit': { stage: 'in_transit', status: 'in_transit' },
  'despatched': { stage: 'in_transit', status: 'in_transit' },
  "we've got it": { stage: 'accepted', status: 'in_transit' },
  'label created by sender': { stage: 'registered', status: 'pending' },
  'awaiting collection': { stage: 'ready_for_pickup', status: 'in_transit' },
  'attempted delivery': { stage: 'failed_attempt', status: 'exception' },
  'delayed': { stage: 'exception', status: 'exception' },
  'return to sender': { stage: 'returned', status: 'exception' },
  'returned to sender': { stage: 'returned', status: 'exception' },
};

export function australiaPostStatus(label: string, code?: string): ClassifiedStatus | undefined {
  if (code && Object.hasOwn(CODES, code)) return CODES[code];
  const key = label.trim().toLowerCase().replace(/’/g, "'");
  return Object.hasOwn(LABELS, key) ? LABELS[key] : undefined;
}

/**
 * A scan's provider code: its event code, a slash and the milestone label the scan is filed under
 * ("TTP-ER81/It's on its way"), since the label stages a code the map does not list. A scan
 * without a label keeps its event code alone.
 */
export function australiaPostCode(code: string, milestone: string): string {
  return milestone ? `${code}/${milestone}` : code;
}

/** The event code and milestone label a provider code holds. A scan stored before the label joined its code has none. */
export function australiaPostCodeParts(providerCode: string): { code: string; milestone?: string } {
  const at = providerCode.indexOf('/');
  return at < 0 ? { code: providerCode } : { code: providerCode.slice(0, at), milestone: providerCode.slice(at + 1) };
}

/**
 * What the map says about one scan: its event code and milestone label, as the adapter reads
 * them. A scan stored with its event code alone, or without one, has no label: a listed code
 * stages it, and a delivery its wording, since the adapter words it "Delivered".
 */
export const statusMap: CarrierStatusMap = {
  stage: (providerCode, wording) => {
    const { code, milestone } = australiaPostCodeParts(providerCode ?? '');
    if (milestone !== undefined) return australiaPostStatus(milestone, code)?.stage;
    return australiaPostStatus('', code)?.stage ?? (wording === 'delivered' ? 'delivered' : undefined);
  },
  gaps: [],
};

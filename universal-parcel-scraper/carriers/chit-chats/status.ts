import { classifyWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// Chit Chats' own scans, in its own wording: the label, the drop-off, its
// facilities and the hand-over to the partner carrier ("In transit").
const OWN: Readonly<Record<string, Stage>> = {
  'shipment created, chit chats awaiting item': 'registered',
  'received by chit chats': 'accepted',
  'arrived at chit chats facility': 'in_transit',
  'departed from chit chats facility': 'in_transit',
  'in transit': 'in_transit',
};

// Partner scans relayed as the partner words them, which the shared rules
// misread: Canada Post's pickup notices. A final notice still waits at the
// post office; it is no return.
const RELAYED: Readonly<Record<string, Stage>> = {
  'received from chit chats': 'in_transit',
  'item available for pickup at post office': 'ready_for_pickup',
  'notice card left indicating where and when to pick up item': 'failed_attempt',
  'final notice; item will be returned to sender if not collected within 10 days': 'ready_for_pickup',
};

// The status Chit Chats files each scan under. Delivery and out-for-delivery
// are precise; the other two also cover notices and pickups, so they stage a
// scan only when its wording says nothing.
const PRECISE: Readonly<Record<string, Stage>> = { delivered: 'delivered', out_for_delivery: 'out_for_delivery' };
const COARSE: Readonly<Record<string, Stage>> = { in_transit: 'in_transit', pre_transit: 'registered' };

/** Whether a scan is in Chit Chats' own wording. */
export function chitChatsOwnWording(description: string): boolean {
  return Object.hasOwn(OWN, normalizeStatusWording(description));
}

/**
 * A scan's stage and how it was chosen: Chit Chats' and the relayed wordings
 * above, then a precise status, then the shared wording rules, then a coarse
 * status. Undefined when none of them knows the scan.
 */
export function chitChatsStage(code: string, description: string): { stage: Stage; source: string } | undefined {
  const wording = normalizeStatusWording(description);
  const mapped = (Object.hasOwn(OWN, wording) ? OWN[wording] : undefined)
    ?? (Object.hasOwn(RELAYED, wording) ? RELAYED[wording] : undefined)
    ?? (Object.hasOwn(PRECISE, code) ? PRECISE[code] : undefined);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const classified = classifyWording(description);
  if (classified.source !== 'none') return classified;
  return Object.hasOwn(COARSE, code) ? { stage: COARSE[code]!, source: 'carrier_map' } : undefined;
}

/** What the map says about one scan, by its status and wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const staged = chitChatsStage(code ?? '', wording);
    return staged?.source === 'carrier_map' ? staged.stage : undefined;
  },
  gaps: [],
};

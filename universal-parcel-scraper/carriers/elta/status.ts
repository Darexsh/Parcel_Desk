import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The English tracker's scan wording, mapped whole. Several of these read as
 * nothing or as the wrong milestone to the shared classifier, such as an item
 * out with a courier or waiting at a post office.
 */
export const ELTA_SCANS: Readonly<Record<string, Stage>> = {
  // The sender's label, then the item handed in at a post office, which the shared rules read as delivered.
  'Label printed by customer': 'registered',
  'Item deposited at ELTA': 'accepted',
  'Shipment in transit': 'in_transit',
  // At Athens airport's hub, then readied there to leave Greece.
  'Arrival at the airport': 'in_transit',
  'For dispatch abroad': 'in_transit',
  'With Courier for delivery': 'out_for_delivery',
  // The courier's attempt: the notice left and its reason, at the same minute.
  'Notification of attempted delivery': 'failed_attempt',
  'ADDRESSEE NOT AVAILABLE AT TIME OF DELIVERY': 'failed_attempt',
  // The recipient will collect the item instead of having it delivered.
  'ADDRESSEE REQUEST OWN PICK-UP': 'failed_attempt',
  // Waiting at the station the scan names, a post office or a courier agency.
  'Item at post office - Can be collected': 'ready_for_pickup',
  'Shipment delivered': 'delivered',
  'Item delivered': 'delivered',
};

// A message to the recipient: no movement, so the item keeps its stage.
const NOTICES = ['SMS text message sent for item to be collected'];

// "Arrival in" followed by the station the scan names.
const ARRIVAL = /^arrival in\b/;

const SCANS = new Map(Object.entries(ELTA_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const NOTICE_KEYS = new Set(NOTICES.map(normalizeStatusWording));

/** The stage ELTA's own wording gives a scan, if the map knows it. */
export function eltaScanStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return SCANS.get(key) ?? (ARRIVAL.test(key) ? 'in_transit' : undefined);
}

export function isEltaNotice(wording: string): boolean {
  return NOTICE_KEYS.has(normalizeStatusWording(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function eltaStage(wording: string): ClassifiedWording | null {
  const mapped = eltaScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only; notices are left without a stage on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : eltaScanStage(wording)),
  gaps: [...NOTICE_KEYS].map(wording => ({
    wording, note: 'A message to the recipient, not a movement: the item keeps the stage it had.',
  })),
};

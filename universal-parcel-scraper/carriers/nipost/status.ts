import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status keys of NIPOST's tracking page, the ones its own code knows:
 * it labels each scan with its key and sets its progress bar by it.
 */
export const NIPOST_KEYS: Readonly<Record<string, Stage>> = {
  AT_HUB: 'in_transit',
  IN_TRANSIT: 'in_transit',
  CUSTOMS_CLEARANCE: 'customs',
  // Sorted at the office that delivers it or hands it out, before the round.
  PROCESSED_FOR_DELIVERY: 'in_transit',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERY_ATTEMPTED: 'failed_attempt',
  DELIVERED: 'delivered',
};

/**
 * UPU event wordings that NIPOST's former tracker relayed from the sending
 * post, mapped whole, for a scan whose key the map does not know.
 */
export const NIPOST_WORDINGS: Readonly<Record<string, Stage>> = {
  'Receive item at office of exchange (Otb)': 'in_transit',
  'Insert item into bag (Otb)': 'in_transit',
  'Send item abroad (EDI-received)': 'in_transit',
};

const KEYS = new Map(Object.entries(NIPOST_KEYS));
const WORDINGS = new Map(Object.entries(NIPOST_WORDINGS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a status key, if it knows it. */
export function nipostKeyStage(key: string): Stage | undefined {
  return KEYS.get(key.trim().toUpperCase());
}

/** The stage the map gives a scan by its key, else by its wording. */
function mappedStage(key: string, wording: string): Stage | undefined {
  return nipostKeyStage(key) ?? WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its key or wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function nipostStage(key: string, wording: string): ClassifiedWording | null {
  const mapped = mappedStage(key, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The key sets the stage whatever the scan's wording; without a known key, a recorded wording does. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => mappedStage(code ?? '', wording),
  gaps: [
    {
      code: 'PENDING',
      note: "The page's first status, before an item reaches a hub. The key does not say whether the item was only announced or already taken in, so the scan's wording decides.",
    },
  ],
};

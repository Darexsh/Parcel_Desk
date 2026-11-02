import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const codes: Record<string, ClassifiedStatus> = {
  DEL: { status: 'delivered', stage: 'delivered' },
  NSR: { status: 'delivered', stage: 'delivered' },
  WC: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  DRP: { status: 'in_transit', stage: 'ready_for_pickup' },
  PIC: { status: 'in_transit', stage: 'accepted' },
  ARR: { status: 'in_transit', stage: 'in_transit' },
  DPT: { status: 'in_transit', stage: 'in_transit' },
  SRT: { status: 'in_transit', stage: 'in_transit' },
  COA: { status: 'in_transit', stage: 'in_transit' },
  // A handoff to a local partner, extra handling and weather delays keep the parcel moving.
  INO: { status: 'in_transit', stage: 'in_transit' },
  XC: { status: 'in_transit', stage: 'in_transit' },
  WXX: { status: 'in_transit', stage: 'in_transit' },
  MIS: { status: 'exception', stage: 'exception' },
  // Delayed at Facility (Retardé au centre de tri): seen after missed or failed
  // deliveries, then either a delivery later that day or no further scan.
  HLD: { status: 'exception', stage: 'exception' },
  NL: { status: 'exception', stage: 'failed_attempt' },
  NH: { status: 'exception', stage: 'failed_attempt' },
  RTN: { status: 'exception', stage: 'returned' },
};

export function canparStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}

/** The stage of each recorded wording through its code, left out where two codes word it alike with different stages. */
const STAGE_BY_WORDING = new Map<string, Stage | undefined>();
for (const { code, wording } of statuses.entries) {
  const key = normalizeStatusWording(wording);
  const stage = canparStatus(code)?.stage;
  STAGE_BY_WORDING.set(key, STAGE_BY_WORDING.has(key) && STAGE_BY_WORDING.get(key) !== stage ? undefined : stage);
}

/**
 * What the map says about one scan: its code, as the parser reads it, else, for a copy without
 * one, the English wording Canpar gives a recorded code.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? canparStatus(code)?.stage : STAGE_BY_WORDING.get(wording)),
  gaps: [],
};

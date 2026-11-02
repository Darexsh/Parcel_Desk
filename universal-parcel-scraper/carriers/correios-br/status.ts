import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Subtypes distinguish delivery from address problems and cancelled dispatches.
// BDE, BDI and BDR are the same delivery outcomes recorded by different units.
const codes: Record<string, ClassifiedStatus> = {
  'BDE/01': { status: 'delivered', stage: 'delivered' },
  'BDI/01': { status: 'delivered', stage: 'delivered' },
  'BDE/10': { status: 'exception', stage: 'failed_attempt' },
  'BDE/20': { status: 'exception', stage: 'failed_attempt' },
  'BDE/23': { status: 'exception', stage: 'returned' },
  'BDE/34': { status: 'exception', stage: 'exception' },
  'BDE/47': { status: 'exception', stage: 'exception' },
  'BDI/40': { status: 'exception', stage: 'exception' },
  'BDR/83': { status: 'exception', stage: 'exception' },
  'OEC/01': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  // Out for delivery back to the sender: the parcel is on its way back.
  'OEC/09': { status: 'exception', stage: 'returned' },
  'LDI/02': { status: 'in_transit', stage: 'ready_for_pickup' },
  'FC/82': { status: 'pending', stage: 'registered' },
  // A missorted item Correios has caught and will forward again.
  'FC/03': { status: 'in_transit', stage: 'in_transit' },
  'DO/01': { status: 'in_transit', stage: 'in_transit' },
  'RO/01': { status: 'in_transit', stage: 'in_transit' },
  'PAR/10': { status: 'in_transit', stage: 'in_transit' },
  // The sending post's office of exchange, before the flight to Brazil.
  'PAR/18': { status: 'in_transit', stage: 'in_transit' },
  // An item from abroad arriving in Brazil, after the sending post has accepted and dispatched it.
  'PAR/16': { status: 'in_transit', stage: 'in_transit' },
  'PO/01': { status: 'in_transit', stage: 'accepted' },
  'PO/09': { status: 'in_transit', stage: 'accepted' },
  'PAR/07': { status: 'in_transit', stage: 'in_transit' },
  'PAR/21': { status: 'in_transit', stage: 'customs' },
  // The import waits for the recipient's tax number before customs can clear it.
  'FC/16': { status: 'in_transit', stage: 'customs' },
  // The import waits for customs to settle the product's classification code.
  'FC/40': { status: 'in_transit', stage: 'customs' },
  'PAR/24': { status: 'exception', stage: 'returned' },
};

export function classifyCorreiosStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(codes, code) ? codes[code] : undefined;
}

/** The stage of each recorded wording through its code, left out where two codes word it alike with different stages. */
const STAGE_BY_WORDING = new Map<string, Stage | undefined>();
for (const { code, wording } of statuses.entries) {
  const key = normalizeStatusWording(wording);
  const stage = classifyCorreiosStatus(code)?.stage;
  STAGE_BY_WORDING.set(key, STAGE_BY_WORDING.has(key) && STAGE_BY_WORDING.get(key) !== stage ? undefined : stage);
}

// Correios's code and subtype, as the parser stores them (`BDE/01`).
const CORREIOS_CODE = /^[A-Z]{2,4}\/\d{2}$/;

/**
 * What the map says about one scan: its code, else, for a universal provider's copy without
 * one or under the provider's own code, the wording Correios gives a recorded code.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code && CORREIOS_CODE.test(code) ? classifyCorreiosStatus(code)?.stage : STAGE_BY_WORDING.get(wording)),
  gaps: [],
};

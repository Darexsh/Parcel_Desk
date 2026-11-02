import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const CODES: Record<string, ClassifiedStatus> = {
  '10601': { status: 'pending', stage: 'registered' },
  '10100': { status: 'in_transit', stage: 'accepted' },
  '20700': { status: 'in_transit', stage: 'in_transit' },
  '20800': { status: 'in_transit', stage: 'in_transit' },
  '21600': { status: 'in_transit', stage: 'in_transit' },
  '21700': { status: 'in_transit', stage: 'ready_for_pickup' },
  '2201': { status: 'in_transit', stage: 'in_transit' },
  '24300': { status: 'in_transit', stage: 'customs' },
  '27900': { status: 'in_transit', stage: 'in_transit' },
  '29200': { status: 'in_transit', stage: 'in_transit' },
  '29500': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  '31200': { status: 'exception', stage: 'exception' },
  '4006': { status: 'in_transit', stage: 'in_transit' },
  '4021': { status: 'in_transit', stage: 'in_transit' },
  '4024': { status: 'in_transit', stage: 'in_transit' },
  '4074': { status: 'in_transit', stage: 'in_transit' },
  '41000': { status: 'delivered', stage: 'delivered' },
  '48000': { status: 'delivered', stage: 'delivered' },
  '67300': { status: 'in_transit', stage: 'in_transit' },
  '70800': { status: 'in_transit', stage: 'in_transit' },
  '82700': { status: 'in_transit', stage: 'customs' },
  '82800': { status: 'in_transit', stage: 'in_transit' },
  '89000': { status: 'in_transit', stage: 'customs' },
  '89100': { status: 'in_transit', stage: 'in_transit' },
  '97700': { status: 'in_transit', stage: 'in_transit' },
  // UPU's events on an item from abroad, as Ukrposhta copies them: posted (EMA), at the origin's
  // outward office of exchange and leaving it (EMB, EMC), at Ukraine's inward office (EMD),
  // presented to customs and released (EDB, EDC), and leaving the inward office (EMF).
  '17100': { status: 'in_transit', stage: 'accepted' },
  '27200': { status: 'in_transit', stage: 'in_transit' },
  '77600': { status: 'in_transit', stage: 'in_transit' },
  '60700': { status: 'in_transit', stage: 'in_transit' },
  '80700': { status: 'in_transit', stage: 'customs' },
  '80800': { status: 'in_transit', stage: 'in_transit' },
  '90800': { status: 'in_transit', stage: 'in_transit' },
};

export function ukrposhtaStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

// "Returned to Sender" is the decision to start the journey back. The
// separate "Return: Delivered to Sender" scan confirms its completion.
export function ukrposhtaReturnCue(label: string): boolean {
  return /^Return: /i.test(label) || /^Returned to Sender(?:\s|\()/i.test(label) || /^Повернення[.:]/i.test(label);
}

/**
 * What the map says about one scan: its code, as the parser reads it, and a delivery whose own
 * wording starts a return, such as "Return: Delivered to Sender", as returned. The stored scan
 * keeps neither the reason code that makes a scan an exception (65 and 66) nor the earlier scan
 * that started a return leg, so a delivery in that leg worded as a delivery reads as delivered.
 * A code the table does not know stays open for the app's review; both sources give every scan a
 * code.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const stage = code === null ? undefined : ukrposhtaStatus(code)?.stage;
    return stage === 'delivered' && ukrposhtaReturnCue(wording) ? 'returned' : stage;
  },
  gaps: [],
};

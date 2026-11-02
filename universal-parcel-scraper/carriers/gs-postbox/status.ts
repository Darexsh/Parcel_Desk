import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { cjMappedStage } from '../cj-logistics/status.js';

/**
 * GS Networks' scan codes (`transCode`) for its own half-price parcels, which
 * travel from one GS25 store to another. Only codes seen in replies are
 * mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['C01', 'accepted'], // 점포에서 접수: the sender dropped the parcel at a GS25 store.
  ['C015', 'in_transit'], // 배송기사 인수: a driver collected it from the store.
  ['C02', 'in_transit'], // 점포 → (집화)일배 입고: arrived at the collecting depot.
  ['C03', 'in_transit'], // 집화센터에 도착: arrived at the collection centre.
  ['C04', 'in_transit'], // (집화)일배 → 허브 입고: arrived at the hub.
  ['C07', 'in_transit'], // 허브센터에 도착.
  ['C09', 'in_transit'], // 출고센터 배송준비중: at the outbound centre for the run to the destination store.
  ['C095', 'in_transit'], // 배송기사 인계: with the driver taking it to the destination store, not to the recipient.
  ['C10', 'ready_for_pickup'], // 점포에 도착: waiting at the destination store.
  ['C11', 'delivered'], // 고객에게 전달: the recipient collected it at the store.
]);

// GS Networks' codes start with C. CJ Logistics' codes, which the tracker
// relays for the parcels CJ carries, are digits or other letters.
const OWN_CODE = /^C\d/;

/** The delivery states GS Postbox's FAQ names, which come without a code. */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['배송중', 'in_transit'],
  ['점포도착', 'ready_for_pickup'],
  ['수령완료', 'delivered'],
  ['반송접수', 'returned'],
  ['반송중', 'returned'],
]);

/** The stage GS Networks' codes give a scan code. */
export function gsPostboxMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else a delivery state the FAQ names, else the shared wording rules, else nothing. */
export function gsPostboxStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = gsPostboxMappedStage(code) ?? (code ? undefined : STATES.get(wording.replace(/\s+/g, '')));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (!code) return STATES.get(wording.replace(/\s+/g, ''));
    return gsPostboxMappedStage(code) ?? (OWN_CODE.test(code.toUpperCase()) ? undefined : cjMappedStage(code));
  },
  gaps: [],
};

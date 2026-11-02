import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** The tracker's own states, which choose the headline the page shows over the history. */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['BEFORE_COLLECT', 'registered'],
  ['PREPARING_TO_SHIP', 'accepted'],
  ['SHIPPING', 'in_transit'],
  ['IN_DELIVERY', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['HOLDING_DELIVERY', 'failed_attempt'],
]);

/**
 * The page's wording: the rows of its history, the steps of its progress rail,
 * the headlines read when a parcel has no scan, and the delivery states of
 * To-Day's partner manual.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['픽업', 'accepted'],
  ['인수', 'accepted'], // The pickup row of a return.
  ['픽업완료', 'accepted'],
  ['도착', 'in_transit'],
  ['출발', 'in_transit'],
  ['배송시작', 'in_transit'],
  // The rail's third step: the parcel left its last station for the recipient.
  ['배송중', 'out_for_delivery'],
  ['도착지 배송 중', 'out_for_delivery'],
  ['배송완료', 'delivered'],
  // The headline of a parcel on its way to the recipient, which some stations also show earlier.
  ['최적경로로 배송중이에요', 'in_transit'],
  ['투데이가 출발지에서 물품을 픽업할 예정이에요', 'registered'],
  ['수거 접수가 완료되었어요', 'registered'],
  ['반품 접수가 완료되었어요', 'registered'],
  ['픽업 요청 전', 'registered'],
  ['픽업 요청됨', 'registered'],
  // The partner manual's state for the whole journey, not the page's last leg.
  ['배송 중', 'in_transit'],
  ['배송 완료', 'delivered'],
  ['배송 중단', 'exception'],
  ['취소/반송됨', 'returned'],
  ['반품', 'returned'],
]);

// Every headline of a parcel the driver could not deliver ends this way.
const HELD = /배송하지 못했어요\.?$/;

/** The stage of one of the tracker's states. */
export function todayStateStage(state: string): Stage | undefined {
  return STATES.get(state.toUpperCase());
}

/** The stage of the page's wording, in the app's lower-case, single-spaced form. */
export function todayStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (HELD.test(wording) ? 'failed_attempt' : undefined);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? todayStateStage(code) : undefined) ?? todayStage(wording),
  gaps: [],
};

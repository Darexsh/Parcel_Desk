import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's rows carry no code, only wording: ACI's own milestones in
 * Korean with an English line, then the delivering carrier's scans in Korea.
 * Korea Post's have an English line too; CJ Logistics' are in Korean only. The
 * tracker's English line is the scan's wording where it has one. The tracking
 * popup on ACI's delivery page words the same milestones its own way, and a
 * provider can relay either. Only wording seen on ACI's pages is mapped; other
 * wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The popup's first step, before ACI has the parcel.
  ['The product is being prepared for delivery locally', 'registered'],
  ['상품이 현지에서 배송 준비중입니다', 'registered'],
  ['Ready for warehousing', 'registered'], // ACI's former bill tracker.
  // ACI picked the parcel up abroad and it waits for its flight.
  ['Shipment pick up and waiting at the origin airport', 'accepted'],
  ['발송물이 픽업되어, 공항출항 대기중입니다', 'accepted'],
  ['발송물이 픽업되어, 공항 출항 대기중입니다', 'accepted'], // The popup's wording.
  ['Shipment picked up,waiting for departure', 'accepted'], // The older tracker's wording.
  ['발송물이 픽업되어, 공항출고 대기중입니다', 'accepted'],
  ['Shipment departed to Incheon International Airport', 'in_transit'],
  ['Incheon International Airport has the goods to the departure', 'in_transit'], // The older tracker's wording of the same flight.
  ['화물이 인천공항으로 출발하였습니다', 'in_transit'],
  ['Shipped the goods arrived at Incheon International Airport', 'in_transit'],
  ['화물이 인천공항에 도착하였습니다', 'in_transit'],
  // The popup's arrival, which it may show from the scheduled landing.
  ['Shipped the goods arrived(expected) at Incheon International Airport', 'in_transit'],
  ['화물이 인천공항에 도착(예정)하였습니다', 'in_transit'],
  // Cleared by Incheon customs, so the parcel moves on to the delivering carrier.
  ['Customs clearance is completed in the Republic of Korea', 'in_transit'],
  ['인천공항 세관에서 통관완료되었습니다', 'in_transit'],
  // The popup's step over the delivering carrier's scans.
  ['Shipment pick up and local delivery started', 'in_transit'],
  ['화물이 픽업되어 , 국내배송이 시작되었습니다', 'in_transit'],
  // Korea Post, which took the parcel over from ACI: a receipt, not the parcel's first acceptance.
  ['HANDED OVER TO KP', 'in_transit'],
  ['접수', 'in_transit'],
  ['MOVE TO DEPOT', 'in_transit'],
  ['발송', 'in_transit'],
  ['ARR. AT DEPOT', 'in_transit'],
  ['도착', 'in_transit'],
  ['HANDED OVER TO POST MAN', 'out_for_delivery'],
  ['배달준비', 'out_for_delivery'],
  ['DELIVERED TO CNEE', 'delivered'],
  ['배달완료', 'delivered'],
  // CJ Logistics, which collects the parcel from the bonded warehouse.
  ['집하처리', 'in_transit'],
  ['간선상차', 'in_transit'],
  ['간선하차', 'in_transit'],
  ['배송출발', 'out_for_delivery'],
  ['배송완료', 'delivered'],
] as const).map(([wording, stage]) => [key(wording), stage]));

/** A wording in the map's form: the app's normalized form, without a closing full stop. */
function key(wording: string): string {
  return normalizeStatusWording(wording).replace(/\.$/, '');
}

/** The stage the map gives a row's wording. */
export function aciExpressKrMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** A row's stage: its wording in the map, else the shared wording rules, else nothing. */
export function aciExpressKrStage(wording: string): ClassifiedWording | null {
  const mapped = aciExpressKrMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => aciExpressKrMappedStage(wording),
  gaps: [],
};

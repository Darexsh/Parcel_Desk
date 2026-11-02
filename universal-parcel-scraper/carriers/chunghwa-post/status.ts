import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDING = new Map<string, Stage>([
  ['交寄郵件', 'accepted'], ['運輸途中', 'in_transit'], ['安排投遞中', 'in_transit'],
  ['郵件投遞中', 'out_for_delivery'], ['到達出口互換局', 'in_transit'], ['已出口－資料詳如右方', 'in_transit'],
  ['郵袋接收', 'in_transit'], ['到達寄達國互換局', 'in_transit'], ['海關查驗', 'customs'], ['離開進口局', 'in_transit'],
  ['離開寄達國互換局', 'in_transit'], ['到達寄達國投遞局', 'in_transit'], ['投遞不成功', 'failed_attempt'], ['投遞成功', 'delivered'],
]);
export function chunghwaPostStage(wording: string): ClassifiedWording | null {
  const stage = WORDING.get(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDING.get(wording), gaps: [] };

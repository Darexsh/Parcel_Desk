import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The one-letter codes (`goodsTypeSP`) the tracking page draws a scan by. Only
 * codes seen in replies are mapped. The page's script also handles `G` and `N`,
 * which were not seen; their scans fall to the status lines and the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['A', 'accepted'], // 접수: the parcel was taken in for delivery.
  ['V', 'in_transit'], // 도착: arrived at the terminal that delivers it.
  ['Y', 'delivered'], // 완료: delivered.
]);

/** The status lines seen with those codes, for a scan that comes without its code. */
const LINES: ReadonlyMap<string, Stage> = new Map([
  ['배송 예정인 상품을 접수하였습니다.', 'accepted'],
  ['배송할 터미널에 도착하였습니다.', 'in_transit'],
  ['배송을 완료하였습니다.', 'delivered'],
]);

/** The stage Kunyoung's map gives a scan, by its code, else its status line. */
export function kunyoungMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? LINES.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function kunyoungStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = kunyoungMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its code and status line. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => kunyoungMappedStage(code, wording),
  gaps: [],
};

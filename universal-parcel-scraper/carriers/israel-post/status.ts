import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Categories of the native tracking history, not the summary's default StatusCode. */
const CATEGORIES: Readonly<Record<string, Stage>> = {
  '3': 'in_transit',
  '4': 'ready_for_pickup',
  '5': 'delivered',
  '6': 'exception',
  '23': 'accepted',
};

export function israelPostStage(code: string): Stage | undefined {
  return Object.hasOwn(CATEGORIES, code) ? CATEGORIES[code] : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: code => code ? israelPostStage(code) : undefined,
  gaps: [],
};

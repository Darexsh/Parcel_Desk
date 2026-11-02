import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// State codes of the official app's widget reply. The app names three more
// (0052, 0055, 0061) without saying what they mean, so they stay unmapped.
const STATES = new Map<string, ClassifiedStatus>([
  ['0051', { status: 'delivered', stage: 'delivered' }],
]);

export function sagawaState(code: string): ClassifiedStatus | undefined {
  return STATES.get(code);
}

/**
 * What the map says about the widget's state, by its code alone. The three
 * unexplained codes are not declared as intentional gaps: they stay unknown,
 * and open for review, until a reply shows what they mean.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? sagawaState(code)?.stage : undefined),
  gaps: [],
};

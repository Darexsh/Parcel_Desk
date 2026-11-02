/**
 * J&T Express Indonesia status vocabulary.
 *
 * Every scan from the app router carries a numeric scan code next to its
 * English label. The code is the key: one label stands for several codes
 * ("Pick-Up" is both a courier pick-up and a drop-off at a drop point), and
 * the customer sentence varies with the facility and the people involved.
 * Codes read live map to a stage; any other is left to the shared classifier.
 */
import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** The router's own scan codes, in English when asked with `lang=en`. */
export const JNT_CODES: Readonly<Record<string, ClassifiedStatus>> = {
  10: { status: 'in_transit', stage: 'accepted' },
  210: { status: 'in_transit', stage: 'accepted' },
  50: { status: 'in_transit', stage: 'in_transit' },
  92: { status: 'in_transit', stage: 'in_transit' },
  94: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  100: { status: 'delivered', stage: 'delivered' },
  110: { status: 'exception', stage: 'exception' },
};

/** The status and stage a scan code stands for, or undefined when the code is not mapped. */
export function jntCodeStatus(code: string): ClassifiedStatus | undefined {
  return Object.hasOwn(JNT_CODES, code) ? JNT_CODES[code] : undefined;
}

/** What the map says about one scan, by its code alone: every router scan carries one. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? jntCodeStatus(code)?.stage : undefined),
  gaps: [],
};

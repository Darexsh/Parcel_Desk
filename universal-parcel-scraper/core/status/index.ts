/**
 * Status vocabulary and the shared wording classifier.
 *
 * What it is: the product `Stage` vocabulary re-exported for adapters, the
 * `ClassifiedStatus` pair every carrier status map produces, and the
 * multilingual wording → stage rules used as a fallback when a carrier has no
 * explicit map for an event. What it is not: it never talks to a provider and
 * never persists anything; the host's sync decides precedence and records
 * where each stage came from.
 */
import type { CarrierStatus } from '../result/index.js';
import type { Stage } from '../../generated/catalog.js';

export type { Stage };
export { STAGES } from '../../generated/catalog.js';
export { trackingLanguageStage, languageStageStatus } from './language.js';
export { classifyWording, wordingStage } from './wording.js';
export type { ClassifiedWording } from './wording.js';
export { recipientAction, RECIPIENT_ACTIONS } from './action.js';
export type { RecipientAction } from './action.js';

/** What a carrier's explicit status map yields for one raw code or wording. */
export interface ClassifiedStatus {
  status: CarrierStatus;
  stage: Stage;
}

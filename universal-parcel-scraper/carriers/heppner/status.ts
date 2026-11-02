/**
 * Heppner milestone, state and event-code vocabulary → product stage.
 *
 * The public recipient endpoint sends three fields per scan: a `step` (the
 * milestone reached), a `state` (the shipment-level state) and an event `code`
 * whose prefix repeats the milestone. Mapping reads the milestone first and
 * the code prefix second, so a code we have not seen inside a known milestone
 * still lands on the right stage.
 *
 * The endpoint carries no human-readable wording, only these identifiers, so
 * each mapped entry also supplies the English description we display. Anything
 * unmapped keeps a neutral description and no explicit stage assignment beyond
 * the transit default the previous implementation used.
 *
 * The `SOL_` codes close the shipment for different reasons, which the portal's
 * own labels (`event_libelle_tracking` in its i18n files) spell out: REI and REO
 * return it to the sender, RXI sends it to a new address under a new
 * reference, and ANN, MAR and MQD cancel it. They are read one by one, before
 * the milestone, rather than by their prefix.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { cleanScalar } from '../../core/transport/text.js';
import type { Stage } from '../../generated/catalog.js';

export interface ClassifiedHeppnerEvent {
  status: CarrierStatus;
  stage: Stage;
  description: string;
}

/**
 * Normalize a provider step, state or event code. Values that are not an
 * upper-case identifier become '' so they can never reach a result field.
 */
export function heppnerCode(value: unknown): string {
  const normalized = cleanScalar(value, 64).toLocaleUpperCase('en-US');
  return /^[A-Z0-9]{2,32}(?:_[A-Z0-9]{2,32})*$/.test(normalized) ? normalized : '';
}

const REDIRECTED: ClassifiedHeppnerEvent = { status: 'in_transit', stage: 'in_transit', description: 'Forwarded to a new address under a new reference' };
const CANCELLED: ClassifiedHeppnerEvent = { status: 'exception', stage: 'exception', description: 'Shipment cancelled' };
const RETURNED: ClassifiedHeppnerEvent = { status: 'exception', stage: 'returned', description: 'Returned to sender' };
const DELIVERED: ClassifiedHeppnerEvent = { status: 'delivered', stage: 'delivered', description: 'Delivered' };
const INSTRUCTIONS_REQUIRED: ClassifiedHeppnerEvent = { status: 'exception', stage: 'exception', description: 'Delivery instructions required' };
const EXCEPTION: ClassifiedHeppnerEvent = { status: 'exception', stage: 'exception', description: 'Shipment exception' };
const OUT_FOR_DELIVERY: ClassifiedHeppnerEvent = { status: 'out_for_delivery', stage: 'out_for_delivery', description: 'Out for delivery' };
const COLLECTED: ClassifiedHeppnerEvent = { status: 'in_transit', stage: 'accepted', description: 'Shipment collected' };
const FORWARDED: ClassifiedHeppnerEvent = { status: 'in_transit', stage: 'in_transit', description: 'Shipment forwarded' };
const IN_TRANSIT: ClassifiedHeppnerEvent = { status: 'in_transit', stage: 'in_transit', description: 'In transit' };
const UPDATE: ClassifiedHeppnerEvent = { status: 'unknown', stage: 'in_transit', description: 'Heppner tracking update' };

/** Map one scan to a stage. Order matters: terminal milestones win over transit ones. */
export function classifyHeppnerEvent(
  stepValue: unknown,
  stateValue: unknown,
  codeValue: unknown,
): ClassifiedHeppnerEvent {
  const step = heppnerCode(stepValue);
  const state = heppnerCode(stateValue);
  const providerCode = heppnerCode(codeValue);

  if (providerCode === 'SOL_RXI') {
    return REDIRECTED;
  }
  if (/^SOL_(?:ANN|MAR|MQD)$/.test(providerCode)) {
    return CANCELLED;
  }
  if (step === 'MARCHANDISE_RETOURNEE' || /^SOL_RE[IO]$/.test(providerCode) || providerCode.startsWith('RET_')) {
    return RETURNED;
  }
  if (step === 'LIVREE' || /^(?:LIV|POD)_/.test(providerCode)) {
    return DELIVERED;
  }
  if (state === 'ANOMALIE' || step === 'EN_ATTENTE_INSTRUCTIONS') {
    return step === 'EN_ATTENTE_INSTRUCTIONS' ? INSTRUCTIONS_REQUIRED : EXCEPTION;
  }
  if (step === 'LIVRAISON' || providerCode.startsWith('MLV_')) {
    return OUT_FOR_DELIVERY;
  }
  if (step === 'PRISE_EN_CHARGE' || providerCode.startsWith('PCH_')) {
    return COLLECTED;
  }
  if (step === 'MARCHANDISE_REEXPEDIEE') {
    return FORWARDED;
  }
  if (step === 'ACHEMINEMENT') {
    return IN_TRANSIT;
  }
  return UPDATE;
}

/** The stage of the English wording each classified scan is stored with. */
const STORED = new Map([REDIRECTED, CANCELLED, RETURNED, DELIVERED, INSTRUCTIONS_REQUIRED, EXCEPTION, OUT_FOR_DELIVERY, COLLECTED, FORWARDED, IN_TRANSIT]
  .map(({ description, stage }) => [normalizeStatusWording(description), stage]));

/**
 * What the map says about one scan: the English wording the adapter stores for it, since the
 * endpoint sends identifiers only. The neutral update an unknown milestone gets stays open: the
 * stored scan keeps its code but not its milestone or state.
 */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => STORED.get(wording), gaps: [] };

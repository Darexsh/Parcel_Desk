import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * 17FEIA's own status labels. Each row carries one in Chinese whatever the
 * reply's language, so the label is the row's code and its English text only
 * a translation. The tracking page's progress rail names the older labels
 * (飞机起飞, 飞机落地, 成功签收).
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  // Written twelve hours after the order data: the parcel travels to 17FEIA's
  // warehouse, which does not have it yet.
  ['包裹在去设施路上', 'registered'],
  ['仓库收货', 'accepted'],
  // The warehouse has the parcel and the customer confirms the order.
  ['订单待客户确认', 'accepted'],
  ['订单已确认', 'accepted'],
  ['订单已出库', 'in_transit'],
  ['出口报关中', 'customs'],
  ['航班已起飞', 'in_transit'],
  ['飞机起飞', 'in_transit'],
  ['航班到达中转地', 'in_transit'],
  ['航班在中转地起飞', 'in_transit'],
  ['航班抵达清关港', 'in_transit'],
  ['飞机落地', 'in_transit'],
  // The broker takes the shipment to its warehouse for clearance; the shared
  // rules would read "delivered to warehouse" as a delivery.
  ['清关行提货到仓', 'customs'],
  ['清关中', 'customs'],
  ['清关完成', 'in_transit'],
  // Handed in at the partner's depot, before the partner's own first scan.
  ['已交仓，等待上网', 'in_transit'],
  ['成功签收', 'delivered'],
]);

/** The label on rows relayed from the delivering partner: their wording is the partner's. */
export const RELAYED_LABEL = '运输途中';
/** An estimate 17FEIA writes before the flight: no scan, so the adapter drops the row. */
export const ESTIMATE_LABEL = '预计起飞日期';
/** A delayed flight, written between the estimate and the take-off: the row keeps the stage of the one before it. */
export const DELAY_LABEL = '航班延误';
/** The order data, the one row that comes without a label. */
const DATA_WORDING = 'item information received.';

/** The stage 17FEIA's map gives a row's label, or its wording when it has none. */
export function seventeenFeiaLabelStage(label: string, wording: string): Stage | undefined {
  if (!label) return normalizeStatusWording(wording) === DATA_WORDING ? 'registered' : undefined;
  return LABELS.get(label);
}

/**
 * A relayed row's stage, from the partner's wording through the shared rules.
 * The partner takes the parcel after 17FEIA flew it out, so its receipt or
 * announcement is the journey going on, and so is wording no rule reads.
 */
function relayedStage(wording: string): ClassifiedWording {
  const worded = classifyWording(wording, 'pending');
  return worded.source === 'none' || ['pending', 'registered', 'accepted'].includes(worded.stage)
    ? { stage: 'in_transit', source: 'carrier_map' } : worded;
}

/**
 * A row's stage: 17FEIA's own label, a relayed row's partner wording, else
 * the shared rules on the wording. Null when nothing reads it.
 */
export function seventeenFeiaStage(label: string, wording: string): ClassifiedWording | null {
  if (label === DELAY_LABEL) return null;
  const mapped = seventeenFeiaLabelStage(label, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (label === RELAYED_LABEL) return relayedStage(wording);
  const worded = classifyWording(wording, 'pending');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => seventeenFeiaLabelStage(code ?? '', wording)
    ?? (code === RELAYED_LABEL ? relayedStage(wording).stage : undefined),
  gaps: [
    { code: ESTIMATE_LABEL, note: 'An estimated departure date written before the flight: no scan, so the adapter drops the row.' },
    { code: DELAY_LABEL, note: 'A delayed flight, not a movement: the parcel keeps the stage it had.' },
  ],
};

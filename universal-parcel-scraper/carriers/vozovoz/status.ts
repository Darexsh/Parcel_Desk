import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The adapter's wording for the order's creation date, which the tracker page labels «Дата создания». */
export const CREATED = 'Заказ создан';
/** The status the tracker gives an order whose cargo is issued, and the wording of its issue date. */
export const GIVEN = 'Груз выдан';

/** The order's status messages, and the creation the adapter words. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  [normalizeStatusWording(CREATED), 'registered'],
  [normalizeStatusWording(GIVEN), 'delivered'],
  // A group pickup collects several orders' cargo from one sender; each order travels on under its own number.
  ['групповой забор завершен', 'accepted'],
]);

/** The flags of the order's state, as the tracker reports them beside its status message. */
export interface VozovozFlags {
  isTaken: boolean;
  hasArrived: boolean;
  isGiven: boolean;
  isCanceled: boolean;
}

/** The stage the map gives a wording, if it knows it. */
export function vozovozMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/**
 * The stage the order's flags give it: cancelled, issued, arrived at the
 * destination terminal, taken from the sender, else only placed. The arrival
 * flag names no route, so it stays in transit.
 */
export function vozovozFlagStage(flags: VozovozFlags): Stage {
  if (flags.isCanceled) return 'exception';
  if (flags.isGiven) return 'delivered';
  if (flags.hasArrived) return 'in_transit';
  if (flags.isTaken) return 'accepted';
  return 'registered';
}

/** A status message's stage from the map, else the shared wording rules, else the order's flags. */
export function vozovozStage(wording: string, flags: VozovozFlags): ClassifiedWording {
  const mapped = wording ? vozovozMappedStage(wording) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = wording ? classifyWording(wording, 'in_transit') : null;
  if (worded && worded.source !== 'none') return worded;
  return { stage: vozovozFlagStage(flags), source: 'carrier_map' };
}

/** A message the map does not know takes its stage from the order's flags, so the map leaves it unknown. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => vozovozMappedStage(wording),
  gaps: [],
};

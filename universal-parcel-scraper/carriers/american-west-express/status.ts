import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap, type IntentionalStatusGap } from '../../core/status/statusMap.js';

/**
 * The milestones I-Trek dates, by the reply's own field names, which the
 * adapter keeps as each event's code. The tracker has no scan history.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['pickup_date', 'accepted'],
  // The arrival at the local hub of the final mile agent, before the home delivery is booked.
  ['atadp', 'in_transit'],
  ['ata_dest', 'delivered'],
]);

/** The steps of the page's progress rail, which come without a code. */
const STEPS: ReadonlyMap<string, Stage> = new Map([
  ['pickup', 'accepted'],
  ['in-transit', 'in_transit'],
  // The page says the final mile is the arrival at the local hub before the home delivery.
  ['last mile', 'in_transit'],
  ['delivered', 'delivered'],
]);

const GAPS: readonly IntentionalStatusGap[] = [
  { code: 'first_contacted_date', note: 'The first call to the customer to book the home delivery; it moves nothing.' },
];

/** The stage the map gives a milestone's code, else a rail step's wording, if it knows either. */
export function americanWestStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? (code ? undefined : STEPS.get(normalizeStatusWording(wording)));
}

/** What the map says about one milestone or rail step, by its code and wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => americanWestStage(code, wording),
  gaps: GAPS,
};

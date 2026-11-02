import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const each = (codes: readonly string[], stage: Stage) => codes.map(code => [code, stage] as const);

/**
 * FAN Courier's event codes, the same in every language. The names come from
 * the event list in FAN's API documentation; S56 and S65 are named only by the
 * tracker's own code. The shared wording rules misread several of them, such
 * as a parcel taken over for delivery.
 */
const CODES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // The courier collected the parcel from its sender.
  ['C0', 'accepted'],
  // Handed in at a FANbox locker or a collect point, for a courier to collect:
  // the tracker puts it on the same milestone as C0.
  ['S56', 'accepted'],
  // Line hauls, sorting and depot scans, and the depot a parcel waits in
  // between delivery rounds.
  ...each(['H0', 'H1', 'H2', 'H3', 'H4', 'H10', 'H11', 'H12', 'H13', 'H15', 'H17'], 'in_transit'),
  // Held for the next transport abroad, which the tracker counts as in transit.
  ['S65', 'in_transit'],
  // Redirected, resent for delivery or handed to an external partner: the
  // parcel goes on, a redirected one under its redirection AWB.
  ...each(['S9', 'S35', 'S47'], 'in_transit'),
  // Taken over for delivery, then on the round.
  ...each(['C1', 'S1'], 'out_for_delivery'),
  // Handed over on a delivery point, which FAN's documentation names for its FANbox lockers,
  // PayPoints and offices: the parcel waits there, and its collection is the delivery.
  ['S46', 'ready_for_pickup'],
  ['S2', 'delivered'],
  // A round that ended without a delivery: the recipient was notified or
  // could not be reached, the address was wrong or incomplete, or a later
  // delivery was agreed.
  ...each(['S3', 'S4', 'S5', 'S10', 'S11', 'S12', 'S14', 'S19', 'S20', 'S21', 'S22', 'S24', 'S25', 'S27', 'S28', 'S30', 'S42'],
    'failed_attempt'),
  // Refusals, returns and compensation: this AWB will not be delivered. A
  // return travels back to the sender under its own AWB, so none of these
  // says the sender has it.
  ...each(['S6', 'S7', 'S15', 'S16', 'S33', 'S37', 'S43', 'S50'], 'exception'),
]);

/** The stage of one event code, if the map gives it one. */
export function fanCourierStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/**
 * What the map says about one scan. Every scan carries its code, so wording
 * alone gets nothing. Codes whose meaning no source settles (S8, S38, S49)
 * stay unknown, open for review.
 */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? fanCourierStage(code) : undefined),
  gaps: [],
};

import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * DAI Post's scan codes and the stage each means. Its tracker rewrote the
 * wording of every code, so the code decides: "Customs cleared" became "All
 * clear! Your parcel's passed customs and is ready for the next leg."
 */
const CODES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // The shipper's label data, before DAI Post holds the parcel.
  ['CI02', 'registered'],
  // The first scan at DAI Post's origin hub.
  ['OA01', 'accepted'],
  ['OP01', 'in_transit'],
  ['OP03', 'in_transit'],
  // Departure and transit delays.
  ['AD01', 'in_transit'],
  ['AD02', 'in_transit'],
  ['OU01', 'in_transit'],
  ['DA08', 'in_transit'],
  ['OU02', 'in_transit'],
  ['DA01', 'in_transit'],
  ['DA05', 'in_transit'],
  ['DH01', 'customs'],
  // A clearance delay: customs still holds the parcel.
  ['DC11', 'customs'],
  ['DC01', 'in_transit'],
  ['OP07', 'in_transit'],
  ['DT01', 'in_transit'],
  ['OP08', 'in_transit'],
  ['FP03', 'in_transit'],
  ['FP05', 'out_for_delivery'],
  // Not safe to leave at the address.
  ['FD10', 'failed_attempt'],
  // The tracker links the scan's place to a map: the point holding the parcel.
  ['FD21', 'ready_for_pickup'],
  ['FD01', 'delivered'],
  // Left at the address with the recipient's authority.
  ['FD02', 'delivered'],
]);

/** The stage of a DAI Post scan code, if the map knows it. */
export function daiPostStage(code: string | null): Stage | undefined {
  return code === null ? undefined : CODES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: code => daiPostStage(code),
  gaps: [],
};

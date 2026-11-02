import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap, type IntentionalStatusGap } from '../../core/status/statusMap.js';

/**
 * The codes of Team Trac's status details. A row's code stages it; its wording
 * can carry a place, an appointment or a signer after the code's own words.
 * Only codes seen in replies are mapped; another code falls to its wording.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // The shipper's booking reached Team, by its system or by a pickup request; the freight is still with the shipper.
  ['ESN', 'registered'],
  ['NEW', 'registered'],
  ['CPR', 'registered'],
  ['REQ', 'registered'],
  ['ACK', 'registered'],
  ['APS', 'registered'],
  ['ATP', 'registered'],
  ['PKU', 'accepted'],
  // Booked on the airline or linehaul that carries the freight between stations.
  ['BKD', 'in_transit'],
  ['ITR', 'in_transit'],
  // Recovered from the airline or linehaul at the destination station, then on hand there.
  ['RCU', 'in_transit'],
  ['COH', 'in_transit'],
  // The destination station books the delivery with the consignee.
  ['ASD', 'in_transit'],
  ['ADS', 'in_transit'],
  ['OFD', 'out_for_delivery'],
  ['POD', 'delivered'],
]);

/** The header's status, over the history. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // Received from the shipper: the shipment's data, before any pickup row.
  ['rcvd fr shpr', 'registered'],
  ['in transit', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

const GAPS: readonly IntentionalStatusGap[] = [
  { code: 'FRE', note: 'A remark the station types, such as a rescheduled delivery; it can name people and is left out of the history.' },
  { code: 'CMT', note: 'The former code of the same remarks.' },
  { wording: '(see remarks)', note: 'The header\'s status when the newest row is a remark: it names no stage.' },
];
const GAP_CODES: ReadonlySet<string> = new Set(GAPS.flatMap((gap) => gap.code ?? []));
const GAP_WORDINGS: ReadonlySet<string> = new Set(GAPS.flatMap((gap) => gap.code ? [] : gap.wording ?? []));

/** Whether a row is a remark, which the adapter leaves out. */
export function teamHiddenRow(code: string): boolean {
  return GAP_CODES.has(code.toUpperCase());
}

/** The stage the map gives a row's code, else its wording, if it knows either. */
export function teamMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

/** A row's or the header's stage: the map, else nothing for a gap, else the shared wording rules, else nothing. */
export function teamStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = teamMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if ((code && GAP_CODES.has(code.toUpperCase())) || GAP_WORDINGS.has(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its code and wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => teamMappedStage(code, wording),
  gaps: GAPS,
};

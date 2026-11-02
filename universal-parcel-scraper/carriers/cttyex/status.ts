import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { linhanMappedStage } from '../linhan/status.js';

/**
 * CTTYEX's scans, in the English its tracker writes them. Each is one of
 * CTTYEX's own steps in China, from the order data to the flight out. The
 * tracker shows no codes.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['order information received', 'registered'], // The shipment data has arrived; CTTYEX does not hold the parcel yet.
  ['arrive at the cross border receiving point', 'accepted'], // Received at the cross-border receiving point in China.
  ['arrive at the receiving point', 'accepted'], // The receiving point's other wording, before the operation center.
  ['goods leave the operation center', 'in_transit'],
  ['arrival at domestic internationality airport', 'in_transit'], // At the departure airport in China.
  ['departure from the airport of origin domestic', 'in_transit'], // The flight has left China.
]);

/**
 * The steps after the flight, from the destination agent and the last-mile
 * network, worded as on LinHan's tracker, the same system: a step these do not
 * list takes the stage LinHan's map gives it. The parser moves a port's town,
 * or the recipient's town and state, out of the wording, which keeps them when
 * they are not read as a place; a processing center's town sits inside it.
 */
const ABROAD: readonly (readonly [RegExp, Stage])[] = [
  [/^arrive at the destination international airport$/, 'in_transit'],
  [/^(?:.+ )?import customs clearance$/, 'customs'], // No release yet.
  [/^leave the .+ processing center$/, 'in_transit'],
  // The last-mile network's scans, its name replaced by "logistics carrier".
  [/^arrived at logistics carrier facility in transit to next facility$/, 'in_transit'],
  // Its first scan near the recipient, not the acceptance: CTTYEX took the parcel in China.
  [/^(?:.+ )?accepted at logistics carrier regional destination facility$/, 'in_transit'],
  [/^(?:.+ )?arrive at the last mile sorting and distribution center$/, 'in_transit'],
  [/^(?:.+ )?leaving the sorting center$/, 'in_transit'],
  [/^delivered$/, 'delivered'],
];

/** The summary's status over the scans, in Chinese, or in English when the tracker is asked in English. */
const SUMMARIES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['运输途中', 'in_transit'],
  ['in transit', 'in_transit'],
]);

/** The tracker's status for a number it does not know, in Chinese and in English. */
export const CTTYEX_NOT_FOUND: readonly string[] = ['查询不到', 'Not Found'];

/** The stage CTTYEX's wording gives a scan or the summary. */
export function cttyexMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return SCANS.get(key) ?? SUMMARIES.get(key) ?? ABROAD.find(([pattern]) => pattern.test(key))?.[1] ?? linhanMappedStage(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function cttyexStage(wording: string): ClassifiedWording | null {
  const mapped = cttyexMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan or summary, by its wording: the tracker shows no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : cttyexMappedStage(wording)),
  gaps: CTTYEX_NOT_FOUND.map((wording) => ({ wording: normalizeStatusWording(wording),
    note: 'The tracker\'s status for a number it does not know, which the adapter reads as not found; never a scan.' })),
};

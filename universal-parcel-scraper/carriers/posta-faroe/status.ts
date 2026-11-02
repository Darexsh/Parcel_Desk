import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The stages of the scan codes (`eventTypeId`) whose wording has been seen,
 * by what that wording says. The wording comes in Faroese whatever language
 * the lookup asks for.
 */
const WORDED: ReadonlyMap<number, Stage> = new Map([
  [37, 'accepted'], // Móttikið frá kunda: received from the sender, at home or by the post abroad.
  [44, 'in_transit'], // Gjørt klárt at senda: made ready for dispatch.
  [52, 'in_transit'], // Móttikið á høvuðsposthús: arrived at the main post office.
  [53, 'customs'], // Farið til tollingar: sent to customs.
  [57, 'in_transit'], // Aftur frá tolling: back from customs, a release.
  [81, 'in_transit'], // Móttikið á posthús: received at the delivering post office.
  [84, 'in_transit'], // Sent til næsta útberingarstað: sent on to the delivery office.
  [100, 'customs'], // Faktura vantar: customs waits for the invoice.
  [108, 'customs'], // Undir tollviðger: being cleared.
  [116, 'customs'], // Eftirlit hjá TAKS: checked by the Faroese tax and customs authority.
]);

/**
 * The tracking page files every code under a heading; these are the headings
 * that settle a stage. Its "Delayed" and "Pay attention" headings mix
 * customs holds with notices, and its "In transit / See update" also heads
 * the codes it marks as confirmed, so those decide nothing on their own.
 */
const HEADINGS: ReadonlyArray<readonly [Stage, readonly number[]]> = [
  ['delivered', [3, 4, 5, 121]],
  ['failed_attempt', [6, 7, 14, 34, 35, 83]],
  ['returned', [8, 10, 85]],
  ['ready_for_pickup', [27]],
  ['exception', [9, 11, 16, 17, 18, 20, 21, 25, 26, 28, 29, 32, 33, 51, 98, 99, 104, 105, 107, 112, 118]],
  ['in_transit', [38, 39, 40, 41, 43, 45, 46, 47, 48, 49, 50, 54, 55, 56, 58, 59, 60, 61, 62, 64, 65, 66, 67, 68,
    69, 70, 71, 72, 75, 76, 77, 78, 86, 87, 88, 89, 90, 91, 94, 97, 113, 117, 120, 124]],
];

const CODES: ReadonlyMap<string, Stage> = new Map([
  ...[...WORDED].map(([code, stage]) => [String(code), stage] as const),
  ...HEADINGS.flatMap(([stage, codes]) => codes.filter((code) => !WORDED.has(code)).map((code) => [String(code), stage] as const)),
]);

// "Cancelled" on the page, without saying whether a booking, a delivery or the item.
const CANCELLED = new Set(['2', '93']);

/** The stage Posta's codes give a scan code. */
export function postaFaroeMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else the shared wording rules, else nothing, which keeps it visible for review. */
export function postaFaroeStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = postaFaroeMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (CANCELLED.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? postaFaroeMappedStage(code) : undefined),
  gaps: [...CANCELLED].map((code) => ({
    code, note: 'The tracking page heads it "Cancelled" without saying whether a booking, a delivery or the item was cancelled.',
  })),
};

import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * GMS Worldwide Express's scans and summary come without a code, so their
 * wordings stage them. Most name a GMS office or town after their first words:
 * "BOOKED AT <city>", "RECEIVED BY <office>", "Forwarded TO <office>". The
 * shared rules know none of those three.
 */
const WORDINGS: ReadonlyArray<readonly [RegExp, Stage]> = [
  // The office that booked the consignment, which was handed in there.
  [/^booked at\b/, 'accepted'],
  [/^received by\b/, 'in_transit'],
  // To the next office, or from the last one to the destination's town.
  [/^forwarded to\b/, 'in_transit'],
  [/^in transit$/, 'in_transit'],
  [/^(?:consignment )?out for delivery$/, 'out_for_delivery'],
  // "NOT delivered - ADDRESS NOT FOUND", with the reason.
  [/^not delivered\b/, 'failed_attempt'],
  // "Delivered (POD)", "Consignment delivered", "Delivered AT <city>".
  [/^(?:consignment )?delivered\b/, 'delivered'],
];

/** The stage GMS Worldwide Express's own wording gives a scan or the summary. */
export function gmsMappedStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A wording's stage: GMS's own, else the shared wording rules, else nothing. */
export function gmsStage(wording: string): ClassifiedWording | null {
  const mapped = gmsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen moves the consignment. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => gmsMappedStage(wording),
  gaps: [],
};

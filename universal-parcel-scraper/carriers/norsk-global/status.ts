import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Norsk's own status codes. The page prints `POD` as "Delivered - Signed by"
 * the signatory, so it is a delivery. Other statuses are free text, staged by
 * the shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([['POD', 'delivered']]);
const TERMINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
// The tracker has written a scan as "Status changed to: " and the new status, which can be a code.
const CHANGED = /^\s*status changed to\s*:\s*/i;

function status(wording: string): string {
  return wording.replace(CHANGED, '').trim();
}

/** The stage Norsk's own status codes give. */
export function norskGlobalMappedStage(code: string): Stage | undefined {
  return CODES.get(status(code).toUpperCase());
}

/** The shipment's summary stage: its code, else a delivery or return its wording names. */
export function norskGlobalSummaryStage(summary: string): Stage | undefined {
  if (!summary) return undefined;
  const mapped = norskGlobalMappedStage(summary);
  if (mapped) return mapped;
  const worded = classifyWording(status(summary), 'in_transit');
  return worded.source !== 'none' && TERMINAL.has(worded.stage) ? worded.stage : undefined;
}

/** A scan's stage. Scans carry wording only: a status code in it is read first, then the shared rules. */
export function norskGlobalScanStage(wording: string): ClassifiedWording | null {
  const mapped = norskGlobalMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(status(wording), 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? norskGlobalMappedStage(code) : undefined) ?? norskGlobalMappedStage(wording),
  gaps: [],
};

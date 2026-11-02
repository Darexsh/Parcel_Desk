import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * JNE's history gives each scan an English phrase and no code. The phrase for a
 * leg is stable; the station it names travels in brackets, which the parser
 * reads as the scan's location. The rules match the phrase in
 * `normalizeStatusWording` form, most specific first, so a plain "received at
 * <hub>" falls to transit only after the named facilities are tried.
 */
const RULES: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^delivered\b/, 'delivered'],
  [/^with delivery courier\b/, 'out_for_delivery'],
  [/^shipment received by jne counter officer\b/, 'accepted'],
  [/^shipment received at\b/, 'accepted'],
  [/^shipment picked up by jne courier\b/, 'accepted'],
  [/^manifested\b/, 'accepted'],
  [/^received at sorting center\b/, 'in_transit'],
  [/^processed at sorting center\b/, 'in_transit'],
  [/^process and forward to\b/, 'in_transit'],
  [/^on process\b/, 'in_transit'],
  [/^received at origin gateway\b/, 'in_transit'],
  [/^departed from transit\b/, 'in_transit'],
  [/^on transit\b/, 'in_transit'],
  [/^received at warehouse\b/, 'in_transit'],
  [/^shipment forwarded to destination\b/, 'in_transit'],
  [/^received on destination\b/, 'in_transit'],
  [/^received at\b/, 'in_transit'],
  [/\bconsignee unknown\b|^cneee unknown\b/, 'failed_attempt'],
  [/\bbox undel/, 'failed_attempt'],
  [/\bbad address\b/, 'failed_attempt'],
  [/\bcriss cross\b/, 'exception'],
  [/^retur origin\b/, 'returned'],
];

/** The stage JNE's own scan phrase gives, or undefined when no rule claims it. */
export function jneMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  for (const [pattern, stage] of RULES) if (pattern.test(normalized)) return stage;
  return undefined;
}

/** A scan's stage: JNE's own phrase, else the shared wording rules, else nothing. */
export function jneStage(wording: string): ClassifiedWording | null {
  const mapped = jneMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => jneMappedStage(wording),
  gaps: [],
};

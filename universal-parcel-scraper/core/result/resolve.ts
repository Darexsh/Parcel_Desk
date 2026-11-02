import { STAGES, type Stage } from '../../generated/catalog.js';
import { classifyWording } from '../status/index.js';
import { explicitOffsetTime } from '../time/index.js';
import { normalizeCarrierResult, type CarrierEvent, type CarrierResult } from './index.js';
import { readLateRegistrations } from './registration.js';

const stages = new Set<string>(STAGES);

export function resultStage(result: CarrierResult): Stage | null {
  if (stages.has(result.current_stage ?? '')) return result.current_stage as Stage;
  const fallback: Partial<Record<NonNullable<CarrierResult['status']>, Stage>> = {
    pending: 'pending', in_transit: 'in_transit', out_for_delivery: 'out_for_delivery',
    delivered: 'delivered', exception: 'failed_attempt',
  };
  const base = fallback[result.status ?? 'unknown'];
  if (!base) return newestScanStage(result.events ?? []);
  const stage = classifyWording(result.last_status_text ?? '', base).stage;
  const first = result.events?.[0]?.stage;
  return stage === 'pending' && stages.has(first ?? '') ? first as Stage : stage;
}

/**
 * The stage of the newest scan that has one, for a result that states no status: a carrier can
 * leave its newest scans without a stage. Not a delivery or a return, which the scans after it may
 * have undone.
 */
function newestScanStage(events: readonly CarrierEvent[]): Stage | null {
  let newest: Stage | null = null;
  let newestAt = -Infinity;
  for (const event of events) {
    const at = Date.parse(event.time ?? event.local_time ?? '');
    if (stages.has(event.stage ?? '') && at > newestAt) [newest, newestAt] = [event.stage as Stage, at];
  }
  return newest === 'delivered' || newest === 'returned' ? null : newest;
}

export function resultHasUpdate(result: CarrierResult): boolean {
  const stage = resultStage(result);
  return Boolean(stage && stage !== 'pending') || (result.events ?? []).some(event => {
    const declared = stages.has(event.stage ?? '') ? event.stage as Stage : undefined;
    return Boolean(declared && declared !== 'pending')
      || Boolean(event.description && classifyWording(event.description, 'pending').stage !== 'pending');
  });
}

export function classifyStage(text: string, fallback = 'in_transit') {
  return classifyWording(text, fallback as Stage);
}

export function inferStage(text: string, fallback = 'in_transit'): string {
  return classifyStage(text, fallback).stage;
}

export function stageSource(declaredStage: string, description: string, source?: unknown): string {
  if (!stages.has(declaredStage)) return classifyStage(description).source;
  if (typeof source === 'string' && source.length <= 100
    && (source === 'none' || source === 'carrier_map' || /^wording:[a-z0-9_]+$/.test(source))) return source;
  return 'carrier_map';
}

export interface ResolvedEvent extends CarrierEvent {
  stage: Stage;
  stage_source: string;
  /** Null for a date or local clock whose offset the feed did not establish. */
  instant: string | null;
}

export interface ResolvedResult extends CarrierResult {
  events: ResolvedEvent[];
}

/** Classify wording and expose verified instants while retaining the feed's clocks. */
export function resolveResult(input: unknown): ResolvedResult {
  const result = readLateRegistrations(normalizeCarrierResult(input));
  const current = resultStage(result);
  const events = (result.events ?? []).map((event): ResolvedEvent => {
    const declared = stages.has(event.stage ?? '') ? event.stage as Stage : undefined;
    const classified = classifyWording(event.description ?? '', 'in_transit');
    return { ...event, stage: declared ?? classified.stage,
      stage_source: declared ? stageSource(declared, event.description ?? '', event.stage_source) : classified.source,
      instant: explicitOffsetTime(event.time)?.iso ?? null };
  });
  return { ...result, ...(current ? { current_stage: current } : {}), events };
}

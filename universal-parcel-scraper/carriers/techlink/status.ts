import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage?: string };

/** The stage each scan code seen on Techlink's tracker gives. */
const CODES = new Map<string, Stage>((statuses.entries as readonly Entry[]).filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));

/** The stage Techlink's map gives a scan code. */
export function techlinkMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else the shared wording rules, else none. */
export function techlinkStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = code ? techlinkMappedStage(code) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every scan carries its code: the map reads it, whatever the wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? techlinkMappedStage(code) : undefined),
  gaps: [],
};

import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage?: string };

/**
 * SmartTrack's Status column, the tracker's own label for each scan, seen in
 * its histories. One label covers several scans: `In Transit` is a hand-over,
 * a sort and a departure, which the shared rules would read differently.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map((statuses.entries as readonly Entry[])
  .filter((entry) => entry.code && entry.stage).map((entry) => [entry.code!.toLowerCase(), entry.stage as Stage]));

/** The stage SmartTrack's Status column label gives a scan. */
export function oneWorldExpressLabelStage(label: string): Stage | undefined {
  return LABELS.get(label.trim().toLowerCase());
}

/**
 * A scan's stage: its Status column label, else the shared wording rules on
 * its description, then on the label, else nothing.
 */
export function oneWorldExpressStage(label: string, wording: string): ClassifiedWording | null {
  const mapped = oneWorldExpressLabelStage(label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const text of [wording, label]) {
    const worded = text ? classifyWording(text, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? oneWorldExpressLabelStage(code) : undefined),
  gaps: [],
};

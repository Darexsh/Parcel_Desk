import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { escapeRegExp } from '../../core/transport/text.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * The scan wordings of FMX's tracker, which carry no code. An entry's `…`
 * stands for what the tracker fills in, such as a station's code and name.
 * Another wording falls to the shared wording rules.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = (statuses.entries as readonly { wording: string; stage: string }[])
  .map((entry) => [
    new RegExp(`^${normalizeStatusWording(entry.wording).split('…').map(escapeRegExp).join('.+')}$`, 'u'),
    entry.stage as Stage,
  ]);

/** The stage FMX's map gives a wording in `normalizeStatusWording` form; one it does not list has none. */
export function fmxMappedStage(wording: string): Stage | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function fmxStage(wording: string): ClassifiedWording | null {
  const mapped = fmxMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => fmxMappedStage(wording),
  gaps: [],
};

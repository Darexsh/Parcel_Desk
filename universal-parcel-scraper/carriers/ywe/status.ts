import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// A hub's code ("LAX01"), a failed delivery's reason ("[Restricted Address]") and the place a
// delivery was left ("(Front door)") vary within one wording, and a failed delivery's second
// sentence follows its full stop with or without a space.
const HUB = /\b[a-z]{3}\d{2}\b/g;
const REASON = /\[[^\]]{1,80}\]/g;
const PLACE = /\([^)]{1,80}\)/g;
const SENTENCE = /\.\s+(?=\S)/g;
const key = (normalized: string) => normalized.replace(HUB, '<hub>').replace(REASON, '[<reason>]').replace(PLACE, '(<place>)')
  .replace(SENTENCE, '.');

/**
 * YWE's scans are English wording from its US hubs and delivery stations.
 * The map is the wording recorded in `statuses.json`, whatever hub, reason or
 * place it names; other wording goes to the shared rules. The tracker's category
 * is not read: it files a delivery station's receipt under Alert.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.wording && entry.stage)
  .map((entry) => [key(normalizeStatusWording(entry.wording!)), entry.stage as Stage]));

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function yweStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(key(normalizeStatusWording(wording)));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Scan codes repeat across wordings, so the map reads the wording alone. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => WORDINGS.get(key(wording)),
  gaps: [],
};

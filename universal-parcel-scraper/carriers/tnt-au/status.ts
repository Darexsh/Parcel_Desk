import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const entries = statuses.entries as readonly { wording: string; stage?: string }[];

/** The scan wordings of TNT Australia's tracker, which carry no code. Another wording falls to the shared wording rules. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(entries.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// The delivery booking a business recipient asks for and TNT arranges. Neither moves the parcel;
// the arrangement can come after the delivery.
const NOTICES: ReadonlySet<string> = new Set(entries.filter((entry) => !entry.stage).map((entry) => normalizeStatusWording(entry.wording)));

/** The stage TNT Australia's map gives a wording in `normalizeStatusWording` form; one it does not list has none. */
export function tntAuMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** Whether a wording is a notice about the delivery booking, which keeps the stage the parcel had. */
export function isTntAuNotice(wording: string): boolean {
  return NOTICES.has(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function tntAuStage(wording: string): ClassifiedWording | null {
  const mapped = tntAuMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => tntAuMappedStage(wording),
  gaps: [...NOTICES].map((wording) => ({
    wording, note: 'A notice about the delivery booking, not a scan: it keeps the stage the parcel already had.',
  })),
};

import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { wording: string; stage?: string; note?: string };

const ENTRIES = statuses.entries as readonly Entry[];

/**
 * The tracker's event names, its own lower-case vocabulary for Pro Carrier's
 * scans and the partners' scans it relays. On a return from the US, USPS's
 * out-for-delivery and delivery scans go to Pro Carrier's returns address under
 * "arriving at" and "arrived at processing centre", which the shared rules
 * would read as a delivery.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .filter((entry) => entry.stage).map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// Messages to the recipient: the parcel keeps the stage of the scan before them.
const NOTICES: ReadonlySet<string> = new Set(ENTRIES
  .filter((entry) => !entry.stage).map((entry) => normalizeStatusWording(entry.wording)));

/** The stage the tracker's map gives an event name. */
export function proCarrierMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** An event's stage: the tracker's map, else the shared wording rules, else nothing. */
export function proCarrierStage(wording: string): ClassifiedWording | null {
  const mapped = proCarrierMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => proCarrierMappedStage(wording),
  gaps: ENTRIES.filter((entry) => !entry.stage)
    .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? 'A message to the recipient; it moves nothing.' })),
};

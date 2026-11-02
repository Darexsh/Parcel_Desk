import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

const key = (code: string | null, wording: string) => `${code ?? ''}\u0000${normalizeStatusWording(wording)}`;

/** The scans recorded in `statuses.json`, by event code and wording; a delivery has no code. */
const PAIRS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.wording.includes('<'))
  .map((entry) => [key(entry.code ?? null, entry.wording), entry.stage as Stage]));

/**
 * A scan's stage. Code 218 is the shipper's side of the journey and names the
 * shipper: "EXPECTED FROM" it is a label, "DEPARTED" it is FedEx collecting the
 * parcel. Another code's wording is read only as recorded.
 */
export function ficStage(code: string | null, wording: string): ClassifiedWording | null {
  const text = normalizeStatusWording(wording);
  if (code === '218' && /^expected from \S/.test(text)) return { stage: 'registered', source: 'carrier_map' };
  if (code === '218' && /^departed \S/.test(text)) return { stage: 'accepted', source: 'carrier_map' };
  const stage = PAIRS.get(key(code, text));
  return stage ? { stage, source: 'carrier_map' } : null;
}

/** By event code and wording. */
export const statusMap: CarrierStatusMap = { stage: (code, wording) => ficStage(code, wording)?.stage, gaps: [] };

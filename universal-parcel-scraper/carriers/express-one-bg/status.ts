import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The statuses of Express One Bulgaria's tracker, which carry no code, in the
 * English page's wording. A parcel waiting at an office or a partner pickup
 * point is ready for pickup there. "Parcel is in ExpressOne office" is the
 * delivery office's scan, both before the van and after a failed attempt.
 * Another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Data received - shipment pending', 'registered'],
  ['HUB Inbound', 'in_transit'],
  ['Parcel is in ExpressOne office', 'in_transit'],
  ['The shipment has been loaded to the van', 'out_for_delivery'],
  ['Not delivered', 'failed_attempt'],
  ['Available for office pickup', 'ready_for_pickup'],
  ['Confirmed for delivery by PUDO', 'ready_for_pickup'],
  ['Confirmed for delivery by PUP', 'ready_for_pickup'],
  ['Delivered', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/**
 * Statuses that move nothing. "Finalized" closes a shipment's record after its
 * last move, so the parcel keeps the stage of the status before it.
 */
const QUIET = new Map<string, string>([
  [normalizeStatusWording('Finalized'), 'Closes the shipment after its last move, a delivery so far; it moves nothing.'],
]);

// "Delivered - Office | TOWN", "Available for office pickup - | TOWN": the wording, the office and the town.
const TOWN = /^(.*) \|(?: ([^|]+))?$/;
const DASH = / -(?= |$)/g;

/** A status split into its wording and, when it names them, the office and town it happened in. */
export function expressOneBgPlace(text: string): { wording: string; office?: string; town?: string } {
  const placed = TOWN.exec(text);
  if (!placed) return { wording: text };
  const left = placed[1]!;
  const dashes = [...left.matchAll(DASH)].map((match) => match.index);
  if (!dashes.length) return { wording: text };
  // A wording that has a dash of its own is known by its whole.
  const known = (end: number) => {
    const wording = normalizeStatusWording(left.slice(0, end));
    return WORDINGS.has(wording) || QUIET.has(wording);
  };
  const end = dashes.find(known) ?? dashes[0]!;
  const office = left.slice(end + 2).trim();
  const town = placed[2]?.trim();
  return { wording: left.slice(0, end), ...(office ? { office } : {}), ...(town ? { town } : {}) };
}

/** The stage Express One Bulgaria's map gives a wording in `normalizeStatusWording` form. */
export function expressOneBgMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A wording's stage: the map, nothing for a status that moves nothing, else the shared wording rules. */
export function expressOneBgStage(wording: string): ClassifiedWording | null {
  const normalized = normalizeStatusWording(wording);
  const mapped = expressOneBgMappedStage(normalized);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (QUIET.has(normalized)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => expressOneBgMappedStage(wording),
  gaps: [...QUIET].map(([wording, note]) => ({ wording, note })),
};

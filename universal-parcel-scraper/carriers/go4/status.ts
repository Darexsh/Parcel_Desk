import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The words GO4's tracking page heads a record's milestones with, which name
 * the scans built from them. The page lists failed attempts under
 * "Predchádzajúce pokusy o doručenie", each with its reason.
 */
export const GO4_WORDING = {
  ordered: 'Objednaná',
  collected: 'Na doručení',
  attempt: 'Pokus o doručenie',
  delivered: 'Doručená',
} as const;

/**
 * Milestone words and the main statuses seen in the tracker's script, in
 * lower case. The page heads the courier's collection time "Na doručení od"
 * (on delivery since); a delivery can follow the next day, so it is the
 * parcel's acceptance.
 */
const WORDS: ReadonlyMap<string, Stage> = new Map([
  ['objednaná', 'registered'],
  ['na doručení', 'accepted'],
  ['doručená', 'delivered'],
  ['delivered', 'delivered'], // The main status of the sample record bundled in the tracker's script.
]);
const ATTEMPT = /^pokus o doručenie(?::|$)/;

/** The stage GO4's own words give a scan or a main status, or undefined for other text. */
export function go4MappedStage(wording: string): Stage | undefined {
  const lower = wording.normalize('NFC').toLocaleLowerCase('sk').trim().split(/\s+/).join(' ');
  if (ATTEMPT.test(lower)) return 'failed_attempt';
  return WORDS.get(lower);
}

/** A scan's or a main status's stage: GO4's own words, else the shared wording rules, else nothing. */
export function go4Stage(wording: string): ClassifiedWording | null {
  const mapped = go4MappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => go4MappedStage(wording),
  gaps: [],
};

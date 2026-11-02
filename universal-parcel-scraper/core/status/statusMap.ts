/**
 * What a carrier's own status map says about one scan, asked by its provider
 * code and wording instead of a whole reply. A carrier declares this next to
 * its map; `core/catalog/statusMaps.ts` collects the declarations for the
 * parcel app, which reviews the wording no map staged.
 */
import type { Stage } from '../../generated/catalog.js';

/** A code or wording the carrier's map gives no stage on purpose. */
export interface IntentionalStatusGap {
  /** The provider code. Without one, the gap covers only wording that came without a code. */
  readonly code?: string;
  /** The wording in `normalizeStatusWording` form. Without one, the gap covers every wording of its code. */
  readonly wording?: string;
  /**
   * Why the map leaves it without a stage. A notice the adapter gives no stage
   * says it keeps the stage of the scan before it: the parcel app restages the
   * scans it stored on those words.
   */
  readonly note: string;
}

export interface CarrierStatusMap {
  /** The part of a provider code the map reads, when not the whole code. Gaps name codes in this form. */
  readonly codeKey?: (code: string) => string;
  /**
   * The stage the map gives a scan with this provider code (null without one)
   * and wording in `normalizeStatusWording` form, or undefined when the code
   * and wording alone do not get one.
   */
  readonly stage: (code: string | null, wording: string) => Stage | undefined;
  readonly gaps: readonly IntentionalStatusGap[];
  /**
   * Why the map leaves a scan without a stage on purpose, by the same code and
   * wording, for gaps `gaps` cannot list one by one, such as a notice that
   * carries a date; undefined for any other scan.
   */
  readonly gapNote?: (code: string | null, wording: string) => string | undefined;
}

/** Lower case, single spaces and at most 500 characters: the form the app keys its observations on. */
export function normalizeStatusWording(description: string): string {
  return description.toLocaleLowerCase('en-US').trim().split(/\s+/).join(' ').slice(0, 500);
}

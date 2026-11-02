
import type { Recognition, TrackingContext } from '../adapter/index.js';
import { carrierBrand } from '../catalog/networks.js';
import { followsPartnerNumbers } from '../catalog/partners.js';
import type { RecognitionCandidate } from '../catalog/recognition.js';
import { isoTime } from '../time/index.js';
import { CARRIER_RECOGNITION_RANKS } from '../../generated/recognition.js';

export {
  MAX_RECOGNITIONS,
  recognitionCandidates,
  recognitionNumberShape,
  type RecognitionCandidate,
  type RecognitionOptions,
} from '../catalog/recognition.js';

/**
 * Carrier recognition: when a number's shape fits several carriers or names
 * only an international postal item, ask the
 * ones that can answer cheaply whether they know it. The Add sheet runs it
 * while the user is still in the form, the first sync runs it again after
 * saving, and routing keeps retrying it while the filed carrier cannot track
 * the number. Which carriers qualify is shared with the Add sheets
 * (`@carriers/core/catalog/recognition`), which name them while they answer.
 */

/** An answer for a parcel quiet this long is taken for an older parcel that reused the number. */
const RECENT_ACTIVITY_MS = 60 * 24 * 3_600_000;
/** A local wall time names an instant at most this much later, in the zones from UTC−12 to UTC+14. */
const WALL_CLOCK_SLACK_MS = 12 * 3_600_000;

export type RecognitionStatus = 'known' | 'unknown' | 'failed';

export interface RecognitionOutcome extends RecognitionCandidate {
  status: RecognitionStatus;
  lastActivityAt: string | null;
  lastActivityLocal?: string | null;
}

/**
 * Ask every candidate at once. A candidate that throws, or has not answered
 * when the budget runs out, is `failed`. The callback receives the deadline
 * and cancellation signal; answers after either are ignored.
 */
export async function recognizeAll(
  candidates: readonly RecognitionCandidate[],
  recognize: (carrier: string, context: TrackingContext) => Promise<Recognition>,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<RecognitionOutcome[]> {
  const outcomes: RecognitionOutcome[] = candidates.map((candidate) => ({ ...candidate, status: 'failed', lastActivityAt: null }));
  signal?.throwIfAborted();
  if (budgetMs <= 0 || candidates.length === 0) return outcomes;
  const controller = new AbortController();
  const context: TrackingContext = { signal: controller.signal, budgetMs };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => undefined;
  const deadline = new Promise<void>((resolve) => {
    stop = () => { controller.abort(); resolve(); };
    timer = setTimeout(stop, budgetMs);
    signal?.addEventListener('abort', stop, { once: true });
  });
  const asked = candidates.map(async (candidate, index) => {
    try {
      const answer = await recognize(candidate.carrier, context);
      if (controller.signal.aborted) return;
      outcomes[index] = { ...candidate, status: answer.known ? 'known' : 'unknown', lastActivityAt: answer.lastActivityAt ?? null,
        ...(answer.lastActivityLocal ? { lastActivityLocal: answer.lastActivityLocal } : {}) };
    } catch {
      // Stays failed: an outage is no answer about the number.
    }
  });
  try {
    await Promise.race([Promise.all(asked), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  signal?.throwIfAborted();
  return outcomes.map((outcome) => ({ ...outcome }));
}

/** How long the parcel has been quiet, at least, or null when the answer states no clock. */
function quietFor(outcome: RecognitionOutcome, now: Date): number | null {
  const at = Date.parse(outcome.lastActivityAt ?? '');
  if (Number.isFinite(at)) return now.getTime() - at;
  const wall = isoTime(outcome.lastActivityLocal, 'UTC')?.timestamp;
  return wall === undefined ? null : now.getTime() - wall - WALL_CLOCK_SLACK_MS;
}

const COUNTRY_MATCH_SCORES = { home: 2, served: 1 } as const;

function countryMatchScore(outcome: RecognitionOutcome): number {
  return outcome.countryMatch ? COUNTRY_MATCH_SCORES[outcome.countryMatch] : 0;
}

/**
 * The carrier the answers settle on: the only recent one, else the one that
 * follows parcels under its delivery carrier's number, else the only one
 * number evidence backs, unless that evidence is a check digit another
 * answer's number passes too, else, when every answer comes from one brand's
 * networks, one that tracks without the user's input, then the one serving the
 * caller's country (its home country first), then the most popular. The
 * caller's country is only a guess at where the parcel goes, so it never
 * outweighs a network that knows the number and can track it at once. The
 * country is the hint given to `recognitionCandidates`, carried on each
 * outcome. Other unrelated carriers that all know the number stay a choice for
 * the user.
 */
export function settleRecognition(outcomes: readonly RecognitionOutcome[], now = new Date()): { carrier?: string; choices: string[] } {
  const answers = outcomes.filter((outcome) => outcome.status === 'known').map((outcome) => ({ outcome, quiet: quietFor(outcome, now) }));
  const recent = answers.filter(({ quiet }) => quiet !== null && quiet < RECENT_ACTIVITY_MS);
  // An answer without a clock is of unknown age: it counts only when no dated answer is recent.
  const known = (recent.length ? recent : answers.filter(({ quiet }) => quiet === null)).map(({ outcome }) => outcome);
  if (known.length === 0) return { choices: [] };
  if (known.length === 1) return { carrier: known[0]!.carrier, choices: [] };
  // The other answers are the delivery leg of the journey this carrier started.
  // It holds the scans before the border, and a hand-off brings the delivery carrier in.
  const origins = known.filter((outcome) => followsPartnerNumbers(outcome.carrier));
  if (origins.length === 1) return { carrier: origins[0]!.carrier, choices: [] };
  const backed = known.filter((outcome) => outcome.preferred);
  // A check digit alone backs no answer over one whose own check digit passes:
  // DHL Express's waybills and ACS's vouchers share theirs.
  const shared = backed.length === 1
    && known.some((outcome) => backed[0]!.checkDigitPeers?.includes(outcome.carrier));
  if (backed.length === 1 && !shared) return { carrier: backed[0]!.carrier, choices: [] };
  const brands = new Set(known.map((outcome) => carrierBrand(outcome.carrier) ?? outcome.carrier));
  if (brands.size === 1) {
    const [best] = [...known].sort((left, right) => Number(!right.needsInput) - Number(!left.needsInput)
      || countryMatchScore(right) - countryMatchScore(left)
      || (CARRIER_RECOGNITION_RANKS[right.carrier] ?? 0) - (CARRIER_RECOGNITION_RANKS[left.carrier] ?? 0));
    return { carrier: best!.carrier, choices: [] };
  }
  return { choices: known.map((outcome) => outcome.carrier) };
}

/**
 * Which carriers recognition asks about an ambiguous number.
 *
 * What it is: the ranked candidates whose adapter can cheaply say whether it
 * knows a number. The detect route and routing ask them; the Add sheets name
 * them while the answer is on its way.
 * What it is not: no provider I/O. Asking the carriers is the server's job
 * (`src/server/carrierRecognition.ts`).
 */
import { CARRIER_RECOGNITION_RANKS } from '../../generated/recognition.js';
import type { CarrierId } from '../../generated/catalog.js';
import { CHECKSUMS } from '../detection/checksums.js';
import { detectCarrierMatch } from '../detection/detect.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { isPhoneNumber } from '../detection/phone.js';
import { ruleFits } from '../detection/rules.js';
import { AUTOMATIC_CARRIER_IDS, CARRIER_DEFINITIONS, carrierAdapter, requiredRequirements } from './definitions.js';
import { carrierBrand } from './networks.js';
import type { CarrierInputField } from './types.js';

/** Carriers asked at once. */
export const MAX_RECOGNITIONS = 5;

export interface RecognitionCandidate {
  carrier: string;
  /** The first input the carrier needs before it can track, if any. */
  needsInput: CarrierInputField | null;
  /** A preferred detection rule backs it with number evidence. */
  preferred: boolean;
  /**
   * When its preference rests on a check digit alone, its rule taking any run
   * of digits of its length: the other candidates whose own check digit passes.
   */
  checkDigitPeers?: string[];
  /**
   * The caller's country hint is the carrier's home country, or one it also
   * serves. Absent without a hint or a match.
   */
  countryMatch?: 'home' | 'served';
}

export interface RecognitionOptions {
  hint?: string;
  skip?: (carrier: string) => boolean;
  phase?: 'http' | 'browser';
  /**
   * A caller's country orders the queries, and settles between one brand's
   * networks that all know the number. It never confirms a carrier.
   */
  countryHint?: string | null;
  /** Caller-owned aggregate scores; larger finite, nonnegative values run first. */
  priorities?: Readonly<Record<string, number>>;
}

/** A coarse whole-number shape, with no identifier characters retained. */
export function recognitionNumberShape(number: string): string | undefined {
  const normalized = normalizeTrackingNumber(number);
  if (!/^[A-Z0-9]{4,40}$/.test(normalized)) return undefined;
  return normalized.match(/[A-Z]+|[0-9]+/g)!
    .map((run) => `${/^[0-9]/.test(run) ? 'D' : 'A'}${run.length}`).join('');
}

/** A rule whose pattern is a bare run of digits: only its check digit points to its carrier. */
const BARE_DIGITS = /^\^(?:\\d|\[0-9\])\{\d+\}\$$/;

/** Whether the rule that offered a carrier for this number passed a check digit, and backs it with nothing more. */
function checkDigit(carrier: string, normalized: string, printed: string): 'passes' | 'backs' | undefined {
  const rule = CARRIER_DEFINITIONS[carrier as CarrierId]?.detectionRules.find((candidate) =>
    ruleFits(candidate, normalized, printed)
    && (!candidate.checksum || CHECKSUMS[candidate.checksum](normalized)));
  if (rule?.checksum === undefined) return undefined;
  return rule.preferred && BARE_DIGITS.test(rule.pattern) ? 'backs' : 'passes';
}

const BROWSER_RECOGNITION_RANKS: Readonly<Record<string, number | undefined>> = Object.fromEntries(
  Object.entries(CARRIER_DEFINITIONS).map(([id, definition]) => [id, definition.tracking.browserRecognitionRank]));

const RECOGNITION_PATTERNS: ReadonlyMap<string, RegExp> = new Map(Object.entries(CARRIER_DEFINITIONS)
  .flatMap(([id, { tracking }]) => tracking.recognitionPattern === undefined ? [] : [[id, new RegExp(tracking.recognitionPattern)] as const]));

/**
 * The low-confidence candidates worth asking, best first: the carrier a
 * universal provider named, then the ones number evidence backs, then the
 * country hint, caller-owned priorities, a passing check digit and the
 * catalog's popularity rank. These hints only order existing candidates. HTTP is the default; `phase: 'browser'` selects
 * the separate opt-in browser catalog. A high-confidence dedicated carrier needs no recognition; the
 * unknown postal carrier still needs a direct carrier to confirm it. A carrier whose catalog
 * entry names the numbers its HTTP recognition answers is asked only about those.
 */
export function recognitionCandidates(
  number: string,
  options: RecognitionOptions = {},
): RecognitionCandidate[] {
  // A mobile number of the caller's country is no carrier's to confirm.
  if (isPhoneNumber(number, options.countryHint)) return [];
  const detected = detectCarrierMatch(number);
  const unknownPostalCarrier = detected.carrier === 'intl-post';
  if (detected.confidence !== 'low' && !unknownPostalCarrier) return [];
  // The high-confidence S10 fallback hides low-confidence carrier rules from
  // detection. Recover those candidates without assigning the issuer's
  // postal carrier as the deliverer: each candidate must confirm this number.
  // intl-post already checked the S10 checksum, so only S10 or shape-only rules
  // can contribute here.
  const normalized = normalizeTrackingNumber(number);
  const printed = number.trim().toUpperCase();
  const postalMatches = unknownPostalCarrier ? Object.entries(CARRIER_DEFINITIONS)
    .flatMap(([carrier, definition]) => {
      const rule = definition.detectionRules.find((candidate) => candidate.confidence === 'low'
        && (!candidate.checksum || candidate.checksum === 's10')
        && ruleFits(candidate, normalized, printed));
      return rule ? [{ carrier, preferred: rule.preferred === true }] : [];
    }) : [];
  const candidates: readonly string[] = unknownPostalCarrier ? postalMatches.map(({ carrier }) => carrier) : detected.candidates;
  const preferred: readonly string[] = unknownPostalCarrier
    ? postalMatches.filter((match) => match.preferred).map(({ carrier }) => carrier) : detected.preferred;
  const ranks = options.phase === 'browser' ? BROWSER_RECOGNITION_RANKS : CARRIER_RECOGNITION_RANKS;
  // A carrier the number points to but that cannot be asked (DPD France) keeps
  // its brand's other networks out: DPD's guest API also answers for DPD
  // France parcels, and would file one under DPD Switzerland.
  const shadowed = new Set(preferred
    .filter((carrier) => ranks[carrier] === undefined)
    .map((carrier) => carrierBrand(carrier)).filter(Boolean));
  const country = options.countryHint?.trim().toUpperCase();
  const countryScore = (carrier: string) => {
    if (!country || !/^[A-Z]{2}$/.test(country)) return 0;
    const countries = CARRIER_DEFINITIONS[carrier as CarrierId]?.countries ?? [];
    return countries[0] === country ? 2 : countries.includes(country) ? 1 : 0;
  };
  const priorityScore = (carrier: string) => {
    const priority = options.priorities?.[carrier];
    return typeof priority === 'number' && Number.isFinite(priority) && priority >= 0 ? priority : 0;
  };
  // A carrier whose recognition answers fewer numbers than its rules offer is
  // only suggested for the rest: Saia's reply cannot bind a twelfth digit.
  // A carrier whose numbers are bare runs that carriers elsewhere print too is
  // only asked for its own countries: Coordinadora's eleven digits are GLS's abroad.
  const answers = (carrier: string) => {
    if (options.phase === 'browser') return true;
    const tracking = CARRIER_DEFINITIONS[carrier as CarrierId]?.tracking;
    if (tracking?.recognitionServedCountriesOnly && countryScore(carrier) === 0) return false;
    return RECOGNITION_PATTERNS.get(carrier)?.test(normalized) ?? true;
  };
  const asked = candidates.filter((carrier) => ranks[carrier] !== undefined && AUTOMATIC_CARRIER_IDS.has(carrier)
    && carrierAdapter(carrier) !== 'universal' && answers(carrier) && !shadowed.has(carrierBrand(carrier)) && !options.skip?.(carrier));
  const checks = new Map(asked.map((carrier) => [carrier, checkDigit(carrier, normalized, printed)]));
  // A check digit other candidates' numbers pass too tells them apart from the rest, not from each other.
  const peers = (carrier: string) => checks.get(carrier) === 'backs'
    ? asked.filter((other) => other !== carrier && checks.get(other)) : [];
  const score = (carrier: string) => [
    carrier === options.hint ? 1 : 0,
    preferred.includes(carrier) ? 1 : 0,
    countryScore(carrier),
    priorityScore(carrier),
    checks.get(carrier) ? 1 : 0,
    ranks[carrier] ?? 0,
  ];
  return asked
    .map((carrier) => ({ carrier, score: score(carrier) }))
    // Array#sort is stable: equal scores keep the catalog order.
    .sort((left, right) => {
      for (let index = 0; index < left.score.length; index++) {
        const difference = right.score[index]! - left.score[index]!;
        if (difference) return difference;
      }
      return 0;
    })
    .map(({ carrier, score: [, , match] }): RecognitionCandidate => {
      const shared = peers(carrier);
      return {
        carrier,
        needsInput: requiredRequirements(carrier, number)[0]?.field ?? null,
        preferred: preferred.includes(carrier),
        ...(shared.length ? { checkDigitPeers: shared } : {}),
        ...(match ? { countryMatch: match === 2 ? 'home' : 'served' } : {}),
      };
    }).filter((candidate) => options.phase !== 'browser' || !candidate.needsInput);
}

/** The carriers the detect route asks about a number, best first; empty when none can answer. */
export function recognitionAskedCarriers(number: string, options: RecognitionOptions = {}): string[] {
  return recognitionCandidates(number, options).slice(0, MAX_RECOGNITIONS).map(({ carrier }) => carrier);
}

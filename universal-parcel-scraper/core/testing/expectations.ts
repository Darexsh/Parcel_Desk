/**
 * The expectation refresh.
 *
 * What it is: after a deliberate rule change that makes detection offer more
 * carriers, the rewrite of what those carriers alone explain. A record whose
 * answer only gained them as candidates records them, a collision declaration
 * whose overlap only gained them names them, and a gap of theirs that no record
 * needs any more goes.
 * What it is not: no judgement. A record whose answer changed any other way, a
 * negative sample detection had no answer for and an overlap without a
 * declaration to extend are listed for review and left as they are.
 *
 *   npm run generate:expectations -- <carrier-id> [<carrier-id> ...]
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectCarrierMatch } from '../detection/index.js';
import { matchingCarriers } from './catalogRules.js';
import {
  CARRIERS_DIRECTORY,
  carrierFolders,
  loadNumberCorpusFiles,
  type CorpusRecord,
  type NumberCorpusFile,
  type NumberExpectation,
} from './corpus.js';
import {
  collisionKey,
  gapCovers,
  gapRecords,
  readCollisions,
  readGaps,
  writeDeclarations,
  type CollisionDeclaration,
  type GapDeclaration,
} from './declarations.js';

/** What detection answers for a number. */
export interface DetectedAnswer {
  readonly carrier: string;
  readonly confidence: 'high' | 'low' | 'none';
  readonly candidates: readonly string[];
}

export interface ExpectationRefresh {
  /** The `numbers.json` documents that change, by carrier folder. */
  readonly files: ReadonlyMap<string, NumberCorpusFile>;
  readonly records: number;
  readonly collisions: readonly CollisionDeclaration[];
  readonly gaps: readonly GapDeclaration[];
  /** What the named carriers do not explain, to settle by hand. */
  readonly left: readonly string[];
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((carrier, index) => carrier === right[index]);
}

function answer(result: DetectedAnswer | NumberExpectation): string {
  const candidates = 'candidates' in result ? result.candidates : [];
  return `${result.carrier} ${result.confidence}${candidates.length > 0 ? ` (${candidates.join(', ')})` : ''}`;
}

/**
 * The record's expectation with the added carriers: the recorded one when
 * detection still gives it, the detected one when the answer only gained added
 * carriers as candidates, and null for any other change. A negative sample
 * that had no answer is a number nothing should be suggested for.
 */
export function refreshedExpectation(
  recorded: NumberExpectation,
  detected: DetectedAnswer,
  added: ReadonlySet<string>,
  negative = false,
): NumberExpectation | null {
  if (detected.confidence === 'high') {
    return recorded.confidence === 'high' && recorded.carrier === detected.carrier ? recorded : null;
  }
  if (detected.confidence === 'none') return recorded.confidence === 'none' ? recorded : null;
  if (recorded.confidence === 'high' || detected.carrier !== 'unknown') return null;
  const before = recorded.confidence === 'low' ? recorded.candidates : [];
  const gained = detected.candidates.filter((carrier) => !before.includes(carrier));
  if (gained.some((carrier) => !added.has(carrier))) return null;
  if (!sameOrder(detected.candidates.filter((carrier) => before.includes(carrier)), before)) return null;
  if (gained.length === 0) return recorded;
  if (negative && recorded.confidence === 'none') return null;
  // A record that rules a carrier out is a number that carrier's rules must not take.
  if (recorded.not?.some((carrier) => gained.includes(carrier))) return null;
  return {
    carrier: 'unknown',
    confidence: 'low',
    candidates: [...detected.candidates],
    ...(recorded.not ? { not: recorded.not } : {}),
  };
}

/**
 * The collision declarations with the added carriers. An overlap that only
 * gained added carriers copies the declaration it grew from, which goes once
 * no record produces it. `produced` maps each overlap the corpus produces to
 * an example number.
 */
export function refreshedCollisions(
  declared: readonly CollisionDeclaration[],
  produced: ReadonlyMap<string, string>,
  added: ReadonlySet<string>,
): { collisions: CollisionDeclaration[]; left: string[] } {
  const byKey = new Map(declared.map((entry) => [collisionKey(entry.carriers), entry]));
  const grown = new Map<CollisionDeclaration, CollisionDeclaration[]>();
  const left: string[] = [];
  for (const [key, example] of produced) {
    if (byKey.has(key)) continue;
    const carriers = key.split(',');
    const base = byKey.get(collisionKey(carriers.filter((carrier) => !added.has(carrier))));
    if (!base) {
      left.push(`declare the overlap ${key}, e.g. ${example}`);
      continue;
    }
    const extra = carriers.filter((carrier) => !base.carriers.includes(carrier));
    grown.set(base, [...(grown.get(base) ?? []), { ...base, carriers: [...base.carriers, ...extra] }]);
  }
  const collisions = declared.flatMap((entry) => {
    const successors = grown.get(entry) ?? [];
    if (produced.has(collisionKey(entry.carriers))) return [entry, ...successors];
    if (successors.length === 0) left.push(`no record produces the declared overlap ${collisionKey(entry.carriers)}`);
    return successors.length > 0 ? successors : [entry];
  });
  return { collisions, left };
}

/**
 * The gap declarations with the added carriers: a gap of theirs that no
 * record needs goes. `unoffered` are the records whose own carrier detection
 * does not offer.
 */
export function refreshedGaps(
  declared: readonly GapDeclaration[],
  unoffered: readonly CorpusRecord[],
  added: ReadonlySet<string>,
): { gaps: GapDeclaration[]; left: string[] } {
  const left = unoffered.filter((record) => !declared.some((gap) => gapCovers(gap, record)))
    .map((record) => `declare the gap for ${record.carrier} ${record.number}`);
  const gaps = declared.filter((gap) => {
    if (unoffered.some((record) => gapCovers(gap, record))) return true;
    if (added.has(gap.carrier)) return false;
    left.push(`no record needs the ${gap.carrier} gap ${gap.pattern ?? 'for every record'}`);
    return true;
  });
  return { gaps, left };
}

/** Replays the corpus and works out what the named carriers explain. */
export function refreshExpectations(carriers: readonly string[]): ExpectationRefresh {
  const folders = carrierFolders();
  const unknown = carriers.filter((carrier) => !folders.includes(carrier));
  if (carriers.length === 0 || unknown.length > 0) {
    throw new Error(`Name the carriers whose detection rules changed${unknown.length > 0 ? `; no folder for ${unknown.join(', ')}` : ''}`);
  }
  const added = new Set(carriers);
  const left: string[] = [];
  const files = new Map<string, NumberCorpusFile>();
  let rewritten = 0;
  const corpus = loadNumberCorpusFiles();
  for (const file of corpus) {
    let changed = false;
    const records = file.records.map((record) => {
      const detected = detectCarrierMatch(record.number);
      const expectation = refreshedExpectation(record.expect, detected, added, record.role === 'negative');
      if (expectation === record.expect) return record;
      if (expectation === null) {
        left.push(`${file.carrier} ${record.number}: recorded ${answer(record.expect)}, detected ${answer(detected)}`);
        return record;
      }
      changed = true;
      rewritten += 1;
      return { ...record, expect: expectation };
    });
    if (changed) files.set(file.carrier, { ...file, records });
  }
  const records: CorpusRecord[] = corpus.flatMap((file) => file.records.map((record) => ({ ...record, carrier: file.carrier })));
  const produced = new Map<string, string>();
  for (const record of records) {
    const overlap = matchingCarriers(record.number);
    if (overlap.length > 1 && !produced.has(collisionKey(overlap))) produced.set(collisionKey(overlap), record.number);
  }
  const collisions = refreshedCollisions(readCollisions(), produced, added);
  const gaps = refreshedGaps(readGaps(), gapRecords(records), added);
  return {
    files,
    records: rewritten,
    collisions: collisions.collisions,
    gaps: gaps.gaps,
    left: [...left, ...collisions.left, ...gaps.left],
  };
}

export function writeExpectationRefresh(refresh: ExpectationRefresh): void {
  for (const [carrier, file] of refresh.files) {
    writeFileSync(path.join(CARRIERS_DIRECTORY, carrier, 'numbers.json'), `${JSON.stringify(file, null, 2)}\n`);
  }
  writeDeclarations(refresh.collisions, refresh.gaps);
}

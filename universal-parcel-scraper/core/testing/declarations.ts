/**
 * The corpus's declared collisions and gaps.
 *
 * What it is: the readers and writers for `core/detection/collisions.json` and
 * `gaps.json`, and the rules the detection sweep and the expectation refresh
 * share: which carriers a collision declaration names, and which records a
 * gap declaration has to cover.
 * What it is not: no declaration of its own. Each shape and reason is written
 * by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectCarrierMatch, isValidS10TrackingNumber, normalizeTrackingNumber } from '../detection/index.js';
import type { CorpusRecord } from './corpus.js';

export interface CollisionDeclaration {
  readonly shape: string;
  readonly carriers: readonly string[];
  readonly reason: string;
}

/** `open` is the worklist; the other kinds say why the gap stays. */
export interface GapDeclaration {
  readonly carrier: string;
  readonly pattern?: string;
  readonly kind: 'by_design' | 'collision' | 'open';
  readonly reason: string;
}

const detectionDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'detection');
export const COLLISIONS_PATH = path.join(detectionDirectory, 'collisions.json');
export const GAPS_PATH = path.join(detectionDirectory, 'gaps.json');

export function readCollisions(): CollisionDeclaration[] {
  return JSON.parse(readFileSync(COLLISIONS_PATH, 'utf8')) as CollisionDeclaration[];
}

export function readGaps(): GapDeclaration[] {
  return JSON.parse(readFileSync(GAPS_PATH, 'utf8')) as GapDeclaration[];
}

export function writeDeclarations(collisions: readonly CollisionDeclaration[], gaps: readonly GapDeclaration[]): void {
  writeFileSync(COLLISIONS_PATH, `${JSON.stringify(collisions, null, 2)}\n`);
  writeFileSync(GAPS_PATH, `${JSON.stringify(gaps, null, 2)}\n`);
}

/** A declaration's carriers in any order name one overlap. */
export function collisionKey(carriers: readonly string[]): string {
  return [...carriers].sort().join(',');
}

function offered(record: CorpusRecord): boolean {
  const match = detectCarrierMatch(record.number);
  return match.carrier === record.carrier || (match.candidates as readonly string[]).includes(record.carrier);
}

/**
 * Records whose own carrier detection does not offer. An S10 number names its
 * issuing post and a label barcode is not typed, so neither is a gap.
 */
export function gapRecords(records: readonly CorpusRecord[]): CorpusRecord[] {
  return records.filter((record) => record.quarantine !== true
    && record.role !== 'negative' && record.role !== 'full_barcode'
    && !isValidS10TrackingNumber(normalizeTrackingNumber(record.number)) && !offered(record));
}

export function gapCovers(gap: GapDeclaration, record: CorpusRecord): boolean {
  return gap.carrier === record.carrier
    && (gap.pattern === undefined || new RegExp(gap.pattern).test(normalizeTrackingNumber(record.number)));
}

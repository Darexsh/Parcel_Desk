/**
 * The detection sweep.
 *
 * What it does: replays every record in `carriers/<id>/numbers.json` through the
 * detection engine and asserts the recorded answer, checks that no second
 * carrier claims a positive record and that no earlier rule hides a carrier's
 * high-confidence rule, reports detection rules that still have no
 * sample, requires every carrier overlap to be declared in `collisions.json`
 * and every record whose own carrier is not offered to be declared in
 * `gaps.json`, fails on declarations in either list that no record needs, and
 * compares the committed Swift golden file with the computed one.
 *
 * The corpus is a characterization of today's engine. A failure here means
 * detection changed: decide whether that change was intended, then update the
 * records (`npm run generate:expectations -- <carrier-id>` when a rule only
 * added a carrier) and the golden file (`npm run generate:golden`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_RECOGNITIONS, recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../detection/index.js';
import { RULES, highConfidenceCarriers, matchingCarriers, matchingRules, type DetectionRule } from './catalogRules.js';
import {
  carrierFolders,
  loadNumberCorpus,
  loadNumberCorpusFiles,
  positiveRecords,
  type CorpusRecord,
} from './corpus.js';
import { collisionKey, gapCovers, gapRecords, readCollisions, readGaps } from './declarations.js';
import { buildDetectionGolden, readDetectionGolden, writeDetectionGolden } from './golden.js';

const coverageBaseline: { maxUncoveredRules: number } = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'detection', 'coverage-baseline.json'), 'utf8'),
);
const collisions = readCollisions();
const gaps = readGaps();

const records = loadNumberCorpus();
const folders = carrierFolders();

function observed(record: CorpusRecord) {
  const match = detectCarrierMatch(record.number);
  return match.confidence === 'high'
    ? { number: record.number, carrier: match.carrier, confidence: match.confidence }
    : match.confidence === 'low'
      ? {
        number: record.number,
        carrier: match.carrier,
        confidence: match.confidence,
        candidates: match.candidates,
      }
      : { number: record.number, carrier: match.carrier, confidence: match.confidence };
}

function recorded(record: CorpusRecord) {
  const { carrier, confidence } = record.expect;
  return confidence === 'low'
    ? { number: record.number, carrier, confidence, candidates: [...record.expect.candidates] }
    : { number: record.number, carrier, confidence };
}

describe('number corpus', () => {
  it('covers every carrier folder', () => {
    expect(loadNumberCorpusFiles().map((file) => file.carrier)).toEqual(folders);
  });

  it('states a gap for every carrier without a record', () => {
    const unexplained = loadNumberCorpusFiles()
      .filter((file) => file.records.length === 0 && !file.gap)
      .map((file) => file.carrier);
    expect(unexplained).toEqual([]);
  });

  it('keeps every number distinct inside its carrier folder', () => {
    for (const file of loadNumberCorpusFiles()) {
      const normalized = file.records.map((record) => normalizeTrackingNumber(record.number));
      expect(`${file.carrier}: ${new Set(normalized).size}`).toBe(`${file.carrier}: ${normalized.length}`);
    }
  });

  it('binds reported relationships to distinct identifiers in the same corpus', () => {
    for (const file of loadNumberCorpusFiles()) {
      const numbers = new Set(file.records.map((record) => normalizeTrackingNumber(record.number)));
      for (const record of file.records) {
        for (const relationship of record.relationships ?? []) {
          const target = normalizeTrackingNumber(relationship.number);
          expect(numbers.has(target), `${file.carrier}: relationship target is absent`).toBe(true);
          expect(target, `${file.carrier}: relationship points to itself`).not.toBe(normalizeTrackingNumber(record.number));
        }
      }
    }
  });
});

describe('detection expectations', () => {
  it.each(folders)('%s numbers detect as recorded', (folder) => {
    const forCarrier = records.filter((record) => record.carrier === folder);
    expect(forCarrier.map(observed)).toEqual(forCarrier.map(recorded));
  });

  it('agrees with a rule-by-rule replay of the catalog', () => {
    const drift = records.filter((record) => {
      const high = highConfidenceCarriers(record.number);
      const match = detectCarrierMatch(record.number);
      return match.confidence === 'high'
        ? high.length !== 1 || high[0] !== match.carrier
        : high.length === 1;
    });
    expect(drift.map((record) => record.number)).toEqual([]);
  });

  it('never lets a second carrier claim a positive record', () => {
    const contested = positiveRecords(records)
      .map((record) => ({ record, high: highConfidenceCarriers(record.number) }))
      .filter(({ record, high }) => high.length !== 1 || high[0] !== record.expect.carrier)
      .map(({ record, high }) => `${record.number} → ${high.join(', ')}`);
    expect(contested).toEqual([]);
  });

  // A carrier's first matching rule sets its confidence, so a broader rule listed before a
  // high-confidence one hides it. Every rule has a sample, so a hidden rule never decides the
  // numbers it takes. An earlier rule that takes only some of them is a deliberate exception.
  it('lists each high-confidence rule before any broader rule of its carrier', () => {
    const deciders = new Map<string, Set<DetectionRule>>();
    for (const record of records) {
      const own = new Map<string, DetectionRule[]>();
      for (const { carrier, rule } of matchingRules(record.number)) own.set(carrier, [...(own.get(carrier) ?? []), rule]);
      for (const [carrier, rules] of own) {
        for (const rule of rules.filter(({ confidence }) => confidence === 'high')) {
          const key = `${carrier}: ${rule.id}`;
          deciders.set(key, (deciders.get(key) ?? new Set()).add(rules[0]!));
        }
      }
    }
    const hidden = [...deciders]
      .filter(([, rules]) => [...rules].every(({ confidence }) => confidence !== 'high'))
      .map(([key, rules]) => `${key} behind ${[...rules].map(({ id }) => id).join(', ')}`);
    expect(hidden).toEqual([]);
  });

  it('honours the carriers a negative record rules out', () => {
    const broken: string[] = [];
    for (const record of records) {
      const forbidden = 'not' in record.expect ? record.expect.not ?? [] : [];
      const claimed = matchingCarriers(record.number);
      for (const carrier of forbidden) {
        if (claimed.includes(carrier)) broken.push(`${record.number} still matches ${carrier}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('rule coverage', () => {
  it('keeps the number of rules without a sample at or below the baseline', () => {
    const covered = new Set(records.flatMap((record) => matchingRules(record.number).map(({ rule }) => rule.id)));
    const uncovered = RULES.filter(({ rule }) => !covered.has(rule.id))
      .map(({ carrier, rule }) => `${rule.id} (${carrier}): ${rule.pattern}`);
    if (uncovered.length > 0) {
      console.warn(`Detection rules with no sample number (${uncovered.length}):\n  ${uncovered.join('\n  ')}`);
    }
    expect(uncovered.length).toBeLessThanOrEqual(coverageBaseline.maxUncoveredRules);
  });
});

describe('declared collisions', () => {
  const declared = new Map(collisions.map((entry) => [collisionKey(entry.carriers), entry]));

  it('declares every carrier overlap the corpus produces', () => {
    const undeclared = new Map<string, string>();
    for (const record of records) {
      const carriers = matchingCarriers(record.number);
      if (carriers.length < 2) continue;
      const key = collisionKey(carriers);
      if (!declared.has(key)) undeclared.set(key, record.number);
    }
    expect([...undeclared].map(([key, number]) => `${key} (e.g. ${number})`)).toEqual([]);
  });

  it('gives every declared collision a shape, carriers and a reason', () => {
    for (const entry of collisions) {
      expect(entry.carriers.length).toBeGreaterThan(1);
      expect(entry.shape.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      for (const carrier of entry.carriers) expect(folders).toContain(carrier);
    }
    expect(declared.size).toBe(collisions.length);
  });

  it('drops a declaration once no record produces it', () => {
    const seen = new Set(records
      .map((record) => collisionKey(matchingCarriers(record.number)))
      .filter((key) => key.includes(',')));
    const stale = [...declared.keys()].filter((key) => !seen.has(key));
    expect(stale).toEqual([]);
  });
});

describe('declared gaps', () => {
  const unoffered = gapRecords(records);

  it('declares every record whose own carrier detection does not offer', () => {
    const undeclared = unoffered.filter((record) => !gaps.some((gap) => gapCovers(gap, record)))
      .map((record) => `${record.carrier} ${record.number}`);
    expect(undeclared).toEqual([]);
  });

  it('drops a declaration once detection offers the carrier', () => {
    const stale = gaps.filter((gap) => !unoffered.some((record) => gapCovers(gap, record)))
      .map((gap) => `${gap.carrier} ${gap.pattern ?? 'every record'}`);
    expect(stale).toEqual([]);
  });

  it('gives every declared gap a carrier, a kind and a reason', () => {
    for (const gap of gaps) {
      expect(folders).toContain(gap.carrier);
      expect(['by_design', 'collision', 'open']).toContain(gap.kind);
      expect(gap.reason.length).toBeGreaterThan(0);
    }
    const open = gaps.filter((gap) => gap.kind === 'open').map((gap) => `${gap.carrier} ${gap.pattern ?? ''}: ${gap.reason}`);
    if (open.length > 0) console.warn(`Detection gaps still open (${open.length}):\n  ${open.join('\n  ')}`);
  });
});

// Both tests recognize every corpus number, which takes seconds alone and far
// longer while other suites load the machine.
describe('swift golden file', { timeout: 180_000 }, () => {
  it('matches the committed data/detection-golden.json', () => {
    if (process.env.UPDATE_DETECTION_GOLDEN) {
      expect(writeDetectionGolden().length).toBe(buildDetectionGolden().length);
      return;
    }
    expect(readDetectionGolden(), 'Rewrite it with npm run generate:golden once the change is deliberate').toEqual(buildDetectionGolden());
  });

  it('records the carriers the app asks: the first recognition candidates', () => {
    for (const { input, asked } of readDetectionGolden()) {
      const first = recognitionCandidates(input).slice(0, MAX_RECOGNITIONS).map(({ carrier }) => carrier);
      expect(recognitionAskedCarriers(input)).toEqual(first);
      expect(asked ?? []).toEqual(first);
    }
  });
});

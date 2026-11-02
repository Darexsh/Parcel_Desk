import { describe, expect, it } from 'vitest';
import type { CorpusRecord, NumberExpectation } from './corpus.js';
import { readCollisions, readGaps, type CollisionDeclaration, type GapDeclaration } from './declarations.js';
import {
  refreshExpectations,
  refreshedCollisions,
  refreshedExpectation,
  refreshedGaps,
  writeExpectationRefresh,
} from './expectations.js';

const added = new Set(['newco']);

function low(candidates: string[], not?: string[]): NumberExpectation {
  return { carrier: 'unknown', confidence: 'low', candidates, ...(not ? { not } : {}) };
}

function record(carrier: string, number: string): CorpusRecord {
  return {
    carrier,
    number,
    role: 'shipment',
    evidence: 'synthetic',
    derivedFrom: 'invented',
    expect: { carrier: 'unknown', confidence: 'none' },
  };
}

describe('refreshed expectations', () => {
  it('records a carrier the answer only gained, in detection order', () => {
    expect(refreshedExpectation(low(['alpha', 'beta']), { carrier: 'unknown', confidence: 'low', candidates: ['alpha', 'newco', 'beta'] }, added))
      .toEqual(low(['alpha', 'newco', 'beta']));
  });

  it('turns an unknown shape into a suggestion of the added carrier and keeps what it rules out', () => {
    const recorded: NumberExpectation = { carrier: 'unknown', confidence: 'none', not: ['gamma'] };
    expect(refreshedExpectation(recorded, { carrier: 'unknown', confidence: 'low', candidates: ['newco'] }, added))
      .toEqual(low(['newco'], ['gamma']));
  });

  it('suggests the added carrier for a negative sample only if it was a suggestion already', () => {
    const detected = { carrier: 'unknown', confidence: 'low' as const, candidates: ['alpha', 'newco'] };
    expect(refreshedExpectation(low(['alpha'], ['gamma']), detected, added, true)).toEqual(low(['alpha', 'newco'], ['gamma']));
    expect(refreshedExpectation({ carrier: 'unknown', confidence: 'none' }, { ...detected, candidates: ['newco'] }, added, true)).toBeNull();
  });

  it('keeps the recorded expectation when detection still gives it', () => {
    const recorded = low(['alpha']);
    expect(refreshedExpectation(recorded, { carrier: 'unknown', confidence: 'low', candidates: ['alpha'] }, added)).toBe(recorded);
  });

  it('leaves any other change for review', () => {
    const detected = (candidates: string[]) => ({ carrier: 'unknown', confidence: 'low' as const, candidates });
    expect(refreshedExpectation(low(['alpha']), detected(['alpha', 'beta']), added)).toBeNull();
    expect(refreshedExpectation(low(['alpha', 'beta']), detected(['alpha', 'newco']), added)).toBeNull();
    expect(refreshedExpectation(low(['alpha', 'beta']), detected(['beta', 'alpha', 'newco']), added)).toBeNull();
    expect(refreshedExpectation(low(['alpha'], ['newco']), detected(['alpha', 'newco']), added)).toBeNull();
    expect(refreshedExpectation(low(['alpha']), { carrier: 'newco', confidence: 'high', candidates: ['newco'] }, added)).toBeNull();
    expect(refreshedExpectation({ carrier: 'alpha', confidence: 'high' }, detected(['alpha', 'newco']), added)).toBeNull();
  });
});

describe('refreshed collisions', () => {
  const pair: CollisionDeclaration = { shape: 'Twelve digits', carriers: ['beta', 'alpha'], reason: 'Both take any twelve digits.' };

  it('names the added carrier in the declaration its overlap grew from', () => {
    const result = refreshedCollisions([pair], new Map([['alpha,beta,newco', 'X1']]), added);
    expect(result).toEqual({ collisions: [{ ...pair, carriers: ['beta', 'alpha', 'newco'] }], left: [] });
  });

  it('keeps the declaration while another record still produces it', () => {
    const result = refreshedCollisions([pair], new Map([['alpha,beta', 'X1'], ['alpha,beta,newco', 'X2']]), added);
    expect(result.collisions).toEqual([pair, { ...pair, carriers: ['beta', 'alpha', 'newco'] }]);
    expect(result.left).toEqual([]);
  });

  it('leaves an overlap without a declaration to extend, and one no record produces', () => {
    const result = refreshedCollisions([pair], new Map([['gamma,newco', 'X3']]), added);
    expect(result.collisions).toEqual([pair]);
    expect(result.left).toEqual(['declare the overlap gamma,newco, e.g. X3', 'no record produces the declared overlap alpha,beta']);
  });
});

describe('refreshed gaps', () => {
  const ownGap: GapDeclaration = { carrier: 'newco', kind: 'open', reason: 'No rule takes its numbers.' };
  const otherGap: GapDeclaration = { carrier: 'alpha', pattern: '^AQ', kind: 'collision', reason: 'Shared shape.' };

  it('drops a gap of the added carrier that no record needs', () => {
    expect(refreshedGaps([ownGap, otherGap], [record('alpha', 'AQ0000000001')], added))
      .toEqual({ gaps: [otherGap], left: [] });
  });

  it('leaves other gaps no record needs, and records no gap covers', () => {
    const result = refreshedGaps([otherGap], [record('beta', 'BQ0000000001')], added);
    expect(result.gaps).toEqual([otherGap]);
    expect(result.left).toEqual(['declare the gap for beta BQ0000000001', 'no record needs the alpha gap ^AQ']);
  });
});

describe('expectation refresh', () => {
  it('needs the carriers whose rules changed', () => {
    expect(() => refreshExpectations([])).toThrow(/Name the carriers/);
    expect(() => refreshExpectations(['no-such-carrier'])).toThrow(/no folder for no-such-carrier/);
  });

  // In update mode the corpus is the one being refreshed.
  it.skipIf(process.env.UPDATE_DETECTION_EXPECTATIONS)('finds nothing to change while the sweep passes', { timeout: 180_000 }, () => {
    const refresh = refreshExpectations(['dhl']);
    expect(refresh.files.size).toBe(0);
    expect(refresh.left).toEqual([]);
    expect(refresh.collisions).toEqual(readCollisions());
    expect(refresh.gaps).toEqual(readGaps());
  });
});

// npm run generate:expectations -- <carrier-id> ... runs this with the ids.
describe.runIf(process.env.UPDATE_DETECTION_EXPECTATIONS)('expectation refresh update', () => {
  it('writes what the named carriers explain', { timeout: 180_000 }, () => {
    const refresh = refreshExpectations(process.env.UPDATE_DETECTION_EXPECTATIONS!.split(','));
    writeExpectationRefresh(refresh);
    console.log(`Rewrote ${refresh.records} records in ${refresh.files.size} numbers.json files.`);
    expect(refresh.left, 'Settle these by hand').toEqual([]);
  });
});

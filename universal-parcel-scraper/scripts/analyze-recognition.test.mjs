import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRecognition, buildPriorities, confirmedEvidence } from './analyze-recognition.mjs';

const api = {
  carrierIds: new Set(['dpd', 'dhl-ecommerce-uk', 'unknown', 'intl-post']),
  normalizeTrackingNumber: (number) => number.toUpperCase().replace(/[\s.-]/g, ''),
  recognitionNumberShape: (number) => /^\d{14}$/.test(number) ? 'D14' : undefined,
  detectCarrierMatch: () => ({ carrier: 'unknown', confidence: 'low' }),
  recognitionCandidates: (_, { priorities } = {}) => ['dpd', 'dhl-ecommerce-uk']
    .sort((left, right) => (priorities?.[right] ?? 0) - (priorities?.[left] ?? 0))
    .map((carrier) => ({ carrier })),
};
const record = (index, carrier = 'dpd') => ({ number: String(index).padStart(14, '0'), carrier, confirmation: 'direct' });

test('requires direct evidence, deduplicates normalized numbers and removes conflicting labels', () => {
  const result = confirmedEvidence([
    record(1), record(1), { ...record(1), number: '00.0000.0000.0001' },
    record(2), record(2, 'dhl-ecommerce-uk'),
    { ...record(3), confirmation: 'manual' },
    { ...record(4), carrier: 'unknown-carrier' },
    { ...record(5), number: 'invalid' },
    record(6, 'unknown'), record(7, 'intl-post'),
  ], api);
  assert.equal(result.rows.length, 1);
  assert.equal(result.conflicting, 1);
  assert.equal(result.rejected, 5);
});

test('suppresses sparse cohorts and rare carriers even with many repeated observations', () => {
  assert.deepEqual(buildPriorities(Array.from({ length: 19 }, (_, index) => ({ shape: 'D14', carrier: index < 15 ? 'dpd' : 'dhl-ecommerce-uk' }))), { version: 1, cohorts: {} });
  const result = analyzeRecognition([...Array(100).fill(record(1)), ...Array.from({ length: 20 }, (_, index) => record(index + 2, index < 4 ? 'dhl-ecommerce-uk' : 'dpd'))], api);
  assert.deepEqual(result.model, { version: 1, cohorts: { D14: { dpd: 17 } } });
  assert.equal(result.report.independentConfirmations, 21);
});

test('reports only aggregate coverage with a deterministic independent holdout', () => {
  const records = Array.from({ length: 30 }, (_, index) => record(index + 1));
  const result = analyzeRecognition(records, api);
  assert.equal(result.report.baseline.httpTopFive, 30);
  assert.equal(result.report.holdout.training + result.report.holdout.baseline.total, 30);
  assert.deepEqual(analyzeRecognition([...records, ...records].reverse(), api).report, result.report);
  for (const row of records) assert.ok(!JSON.stringify(result).includes(row.number));
  assert.ok(!JSON.stringify(result).includes('number'));
});

test('does not use held-out labels to pass a sparse training cohort threshold', () => {
  const candidates = ['seur', 'brt', 'hermes-de', 'relais-colis', 'ciblex', 'dpd'];
  const crowded = { ...api, recognitionCandidates: (_, { priorities } = {}) => [...candidates]
    .sort((left, right) => (priorities?.[right] ?? 0) - (priorities?.[left] ?? 0))
    .map((carrier) => ({ carrier })) };
  const result = analyzeRecognition(Array.from({ length: 20 }, (_, index) => record(index + 1)), crowded);
  assert.deepEqual(result.model, { version: 1, cohorts: { D14: { dpd: 20 } } });
  assert.ok(result.report.holdout.baseline.total > 0);
  assert.ok(result.report.holdout.training < 20);
  assert.equal(result.report.holdout.baseline.httpTopFive, 0);
  assert.equal(result.report.holdout.ranked.httpTopFive, 0);
  assert.equal(result.report.holdout.ranked.httpTopTen, result.report.holdout.baseline.total);
});

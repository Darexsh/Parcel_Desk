import { describe, expect, it } from 'vitest';
import type { DetectionRule } from '../catalog/types.js';
import { ruleFits } from './rules.js';

describe('ruleFits', () => {
  it('reads the pattern on the normalized number and the rawPattern on the printed input', () => {
    const rule: DetectionRule = { pattern: '^\\d{9}$', rawPattern: '^\\d{3}-\\d{6}$', confidence: 'low' };
    expect(ruleFits(rule, '482615937', '482-615937')).toBe(true);
    expect(ruleFits(rule, '482615937', '482615937')).toBe(false);
    expect(ruleFits(rule, '48261593', '482-61593')).toBe(false);
  });

  it('keeps each rule apart, even when two share a pattern', () => {
    const plain: DetectionRule = { pattern: '^\\d{9}$', confidence: 'low' };
    const dashed: DetectionRule = { pattern: '^\\d{9}$', rawPattern: '^\\d{3}-\\d{6}$', confidence: 'low' };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(ruleFits(plain, '482615937', '482615937')).toBe(true);
      expect(ruleFits(dashed, '482615937', '482615937')).toBe(false);
    }
  });
});

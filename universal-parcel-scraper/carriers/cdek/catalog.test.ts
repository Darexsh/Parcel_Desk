import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';

describe('CDEK detection', () => {
  it('offers CDEK beside the other eleven-digit carriers when the number starts 10', () => {
    const match = detectCarrierMatch('10000000001');
    expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(match.candidates).toContain('cdek');
    expect(match.candidates).toContain('gls-de');
  });

  it('leaves other eleven-digit numbers and ten-digit numbers out', () => {
    expect(detectCarrierMatch('11000000001').candidates).not.toContain('cdek');
    expect(detectCarrierMatch('1000000000').candidates).not.toContain('cdek');
  });

  it('asks CDEK first for a Russian or Kazakh parcel', () => {
    expect(recognitionAskedCarriers('10000000001', { countryHint: 'RU' })[0]).toBe('cdek');
    expect(recognitionAskedCarriers('10000000001', { countryHint: 'KZ' })[0]).toBe('cdek');
  });
});

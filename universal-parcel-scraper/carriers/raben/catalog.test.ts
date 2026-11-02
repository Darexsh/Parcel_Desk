import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';

describe('Raben detection', () => {
  it('offers Raben for a shipment number of 27 and thirteen digits', () => {
    for (const number of ['271234567890123', '279876543210987']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('raben');
    }
  });

  it('asks Raben after BRT about such a number looked up in Italy', () => {
    expect(recognitionAskedCarriers('271234567890123', { countryHint: 'IT' })).toEqual(['brt', 'raben']);
  });

  it('leaves other fifteen-digit numbers and other lengths to the carriers that print them', () => {
    for (const number of ['521234567890123', '721234567890123', '27123456789012', '2712345678901234']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('raben');
    }
  });
});

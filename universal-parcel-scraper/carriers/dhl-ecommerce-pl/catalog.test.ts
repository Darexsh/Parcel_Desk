import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';

describe('DHL eCommerce Poland detection', () => {
  it('offers DHL eCommerce Poland for eleven digits whose check digit holds, and asks it first', () => {
    const match = detectCarrierMatch('12345678900');
    expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(match.candidates).toContain('dhl-ecommerce-pl');
    expect(recognitionAskedCarriers('12345678900')[0]).toBe('dhl-ecommerce-pl');
  });

  it('leaves out eleven digits whose check digit fails', () => {
    for (const number of ['12345678901', '99999999990']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('dhl-ecommerce-pl');
    }
  });
});

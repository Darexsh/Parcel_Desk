import { describe, expect, it } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';

describe('Sameday detection', () => {
  it('offers Sameday for an AWB whose client code holds a digit before LN or LL', () => {
    for (const number of ['1ZZ9LN000000001', '1XZ9LN000000000001', '1ZZ9LL000000001', '1XZ9LL000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({
        carrier: 'unknown', confidence: 'low', candidates: ['sameday'],
      });
    }
  });

  it('needs a letter to open the client code, LN or LL after it and nine to twelve digits', () => {
    for (const number of ['10Z9LN000000001', '1ZZ9LX000000001', '1ZZ9NL000000001', '1ZZ9LN00000001', '1ZZ9LL0000000000001']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('sameday');
    }
  });
});

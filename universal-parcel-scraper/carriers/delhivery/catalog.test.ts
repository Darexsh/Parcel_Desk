import { describe, expect, it } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';

describe('Delhivery detection', () => {
  it('offers Delhivery for thirteen and fourteen digits ending in a check digit from 0 to 6', () => {
    for (const number of ['1000000000016', '10000000000016']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates).toContain('delhivery');
    }
  });

  it('leaves out numbers starting with 0 or ending in 7, 8 or 9', () => {
    for (const number of ['0100000000001', '01000000000016', '1000000000017', '10000000000019']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('delhivery');
    }
  });
});

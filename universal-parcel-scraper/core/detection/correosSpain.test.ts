import { describe, expect, it } from 'vitest';
import { isCorreosSpainExpeditionCode, isValidCorreosSpainCheckLetter } from './correosSpain.js';
import { detectCarrierMatch } from './detect.js';

// Synthetic codes: a label code Correos does not issue, with the check letter the rule gives.
describe('Correos check letter', () => {
  it('accepts the letter the summed character codes pick, for both code lengths', () => {
    for (const code of ['PL00ZZ000000001Z', 'PL00ZZ0000000010100000Y', 'CD00ZZ0000000010100000P']) {
      expect(isValidCorreosSpainCheckLetter(code)).toBe(true);
    }
    for (const code of ['PL00ZZ000000001A', 'PL00ZZ000000002Z', 'PL00ZZ0000000010100000Z', 'Z', '']) {
      expect(isValidCorreosSpainCheckLetter(code)).toBe(false);
    }
    // A sum cannot see two characters swapped.
    expect(isValidCorreosSpainCheckLetter('PL00ZZ000000010Z')).toBe(true);
  });

  it('gates the expedition shape and both Correos rules', () => {
    expect(isCorreosSpainExpeditionCode('PL00ZZ000000001Z')).toBe(true);
    expect(isCorreosSpainExpeditionCode('PL00ZZ000000001A')).toBe(false);
    expect(isCorreosSpainExpeditionCode('PL00ZZ0000000010100000Y')).toBe(false);
    for (const code of ['PL00ZZ000000001Z', 'PL00ZZ0000000010100000Y', 'CD00ZZ0000000010100000P']) {
      expect(detectCarrierMatch(code)).toMatchObject({ carrier: 'correos-spain', confidence: 'high' });
    }
    for (const code of ['PL00ZZ000000001A', 'PL00ZZ0000000010100000Z', 'CD00ZZ0000000010100000A']) {
      expect(detectCarrierMatch(code).candidates).not.toContain('correos-spain');
    }
  });

  it('claims a 23-character code under any product letters when its check letter holds', () => {
    for (const code of ['L300ZZ0000000010100000T', 'UX00ZZ0000000010100000T', 'VE00ZZ0000000010100000M']) {
      expect(detectCarrierMatch(code), code).toMatchObject({ carrier: 'correos-spain', confidence: 'high' });
    }
    for (const code of ['L300ZZ0000000010100000R', 'VE00ZZ0000000010100000Y', '9X00ZZ0000000010100000H']) {
      expect(detectCarrierMatch(code).candidates, code).not.toContain('correos-spain');
    }
  });
});

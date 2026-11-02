import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import characters from '../../core/transport/text-captcha-model/arithmetic-characters.json' with { type: 'json' };
import { decodeTextCaptchaLogits } from '../../core/transport/text-captcha-worker.mjs';
import { arithmeticAnswer, EcmsExpressOcr } from './ocr.js';

describe('ECMS arithmetic OCR', () => {
  it('evaluates only a whole single-digit addition or subtraction', () => {
    expect(arithmeticAnswer('9+9')).toBe('18');
    expect(arithmeticAnswer('0-9')).toBe('-9');
    expect(arithmeticAnswer('4-4')).toBe('0');
    for (const value of ['1', '1+2=', '1+2+3', '12-4', '1x2', '1/0', '1十2', '9+-1']) expect(arithmeticAnswer(value)).toBe('');
  });

  it('retains arithmetic labels only for this profile, without coercing other winning classes', () => {
    const data = new Float32Array(4 * 8210).fill(-10);
    [409, 6178, 0, 6749].forEach((value, step) => { data[step * 8210 + value] = 10; });
    expect(decodeTextCaptchaLogits(data, [4, 1, 8210], characters)).toBe('7+0');
    expect(decodeTextCaptchaLogits(data, [4, 1, 8210])).toBe('');
    data[6178 + 8210] = -10; data[8211] = 10;
    expect(decodeTextCaptchaLogits(data, [4, 1, 8210], characters)).toBe('');
  });

  it('loads the worker and model, crops the equals column and rejects another geometry', async () => {
    const worker = new EcmsExpressOcr();
    const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="45"><rect width="200" height="45" fill="white"/><g font-family="serif" font-size="32" font-weight="bold"><text x="0" y="35">7</text><text x="50" y="35">+</text><text x="100" y="35">0</text><text x="150" y="35">=</text></g></svg>')).png().toBuffer();
    try {
      expect(await worker.solve(image, AbortSignal.timeout(15_000))).toBe('7');
      await expect(worker.solve(await sharp(image).resize(200, 50).toBuffer(), AbortSignal.timeout(2000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 20_000);
});

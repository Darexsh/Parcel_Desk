import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import characters from '../../core/transport/text-captcha-model/characters.json' with { type: 'json' };
import { decodeViettelLogits } from './ocr-worker.mjs';
import { ViettelPostOcr } from './ocr.js';

describe('Viettel Post OCR', () => {
  it('decodes CTC repeats and blanks, rejecting non-Latin winners and invalid output', () => {
    const index = (character: string) => Number(Object.entries(characters).find(([, value]) => value === character)![0]);
    const a = index('a'), b = index('b');
    const data = new Float32Array(6 * 8210).fill(-10);
    [a, a, 0, a, b, b].forEach((value, step) => { data[step * 8210 + value] = 10; });
    expect(decodeViettelLogits(data, [6, 1, 8210])).toBe('aab');
    data.fill(-10); data[1] = 10;
    expect(decodeViettelLogits(data, [6, 1, 8210])).toBe('');
    data[0] = NaN;
    expect(() => decodeViettelLogits(data, [6, 1, 8210])).toThrow();
    expect(() => decodeViettelLogits([], [6, 1, 8210])).toThrow();
  });

  it('loads the packaged worker and model for a synthetic text image, and rejects other image geometry', async () => {
    const worker = new ViettelPostOcr();
    const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><rect width="200" height="50" fill="white"/><text x="45" y="39" font-family="serif" font-size="38" font-weight="bold">abcd</text></svg>')).png().toBuffer();
    try {
      expect(await worker.solve(image, AbortSignal.timeout(10_000))).toBe('abcd');
      await expect(worker.solve(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer(), AbortSignal.timeout(2000)))
        .rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 15_000);
});

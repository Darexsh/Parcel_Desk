import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveSlider } from './zto-slider.mjs';

test('finds a synthetic jigsaw gap at the expected row using the piece alpha mask', async () => {
  const piece = new Uint8ClampedArray(67 * 67 * 4), background = new Uint8ClampedArray(400 * 200 * 4).fill(230);
  for (let y = 0; y < 67; y++) for (let x = 0; x < 67; x++) {
    const inside = x >= 8 && x < 58 && y >= 8 && y < 58 && !(x < 18 && (y - 33) ** 2 + (x - 8) ** 2 < 100)
      || (x - 33) ** 2 + (y - 8) ** 2 < 90;
    if (inside) {
      piece[(y * 67 + x) * 4 + 3] = 255;
      const pixel = ((y + 80) * 400 + x + 250) * 4;
      background[pixel] = background[pixel + 1] = background[pixel + 2] = 30;
    }
  }
  const bg = { width: 400, height: 200, getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 200 }),
    getContext: () => ({ getImageData: () => ({ data: background }) }) };
  const img = { src: 'synthetic', getBoundingClientRect: () => ({ x: 20, y: 80, width: 67, height: 67 }) };
  const elements = { '.dx_captcha_basic_bg canvas': bg, '.dx_captcha_basic_sub-slider': { querySelector: () => img },
    '.dx_captcha_basic_slider': { getBoundingClientRect: () => ({ x: 0, y: 220, width: 40, height: 40 }) } };
  const previous = { document: globalThis.document, Image: globalThis.Image };
  globalThis.document = { querySelector: key => elements[key], createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: piece }) }) }) };
  globalThis.Image = class { async decode() {} };
  try {
    const result = await solveSlider();
    assert.equal(result.x, 250); assert.equal(result.y, 80); assert.equal(result.distance, 230); assert.ok(result.score > 0.99);
    bg.width = 1000;
    assert.equal((await solveSlider()).error, 'unexpected-image');
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key];
    }
  }
});

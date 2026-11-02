import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web';
import sharp from 'sharp';
import characters from './text-captcha-model/characters.json' with { type: 'json' };
import arithmeticCharacters from './text-captcha-model/arithmetic-characters.json' with { type: 'json' };

const profiles = {
  'viettel-post': { width: 200, height: 50, format: 'png' },
  'chunghwa-post': { width: 162, height: 54, format: 'jpeg' },
  'ecms-express': { width: 200, height: 45, format: 'png', cropWidth: 145, characters: arithmeticCharacters },
};
const profile = profiles[workerData?.profile ?? 'viettel-post'];

ort.env.wasm.numThreads = 1;
// The original model's declared output shape is stale; its actual tensor is checked below.
ort.env.logLevel = 'error';
let session;

/** @param {Record<number, string>} alphabet */
export function decodeTextCaptchaLogits(data, dims, alphabet = characters) {
  if (dims.length !== 3 || dims[0] < 1 || dims[0] > 64 || dims[1] !== 1 || dims[2] !== 8210 || data.length !== dims[0] * 8210) {
    throw new Error('Invalid OCR tensor');
  }
  let previous = -1, answer = '';
  for (let step = 0; step < dims[0]; step++) {
    let best = 0;
    for (let column = 0; column < 8210; column++) {
      const value = data[step * 8210 + column];
      if (!Number.isFinite(value)) throw new Error('Invalid OCR score');
      if (value > data[step * 8210 + best]) best = column;
    }
    if (best !== previous && best !== 0) {
      const character = alphabet[best];
      if (!character) return '';
      answer += character;
    }
    previous = best;
  }
  return answer;
}

async function solve(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 50_000) throw new Error('unsupported-image');
  if (!profile) throw new Error('unsupported-image');
  const image = sharp(bytes, { limitInputPixels: 10_000, pages: 1, failOn: 'warning' });
  const metadata = await image.metadata().catch(() => { throw new Error('unsupported-image'); });
  if (metadata.format !== profile.format || metadata.width !== profile.width || metadata.height !== profile.height || (metadata.pages ?? 1) !== 1) throw new Error('unsupported-image');
  // ECMS places the equals sign in the fourth column; it is not part of the expression.
  if (profile.cropWidth) image.extract({ left: 0, top: 0, width: profile.cropWidth, height: profile.height });
  const pixels = await image.flatten({ background: '#ffffff' }).greyscale().resize(256, 64).raw().toBuffer();
  if (pixels.length !== 256 * 64) throw new Error('unsupported-image');
  if (!session) session = await ort.InferenceSession.create(new Uint8Array(await readFile(new URL('./text-captcha-model/captcha.onnx', import.meta.url))),
    { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  const input = new ort.Tensor('float32', Float32Array.from(pixels, value => value / 127.5 - 1), [1, 1, 64, 256]);
  const output = (await session.run({ input1: input }))['387'];
  if (!output || output.type !== 'float32') throw new Error('Invalid OCR output');
  return decodeTextCaptchaLogits(output.data, output.dims, profile.characters ?? characters);
}

parentPort?.on('message', async ({ id, bytes }) => {
  try { parentPort.postMessage({ id, answer: await solve(bytes) }); }
  catch (error) { parentPort.postMessage({ id, error: error?.message === 'unsupported-image' ? 'unsupported-image' : 'inference-failed' }); }
});

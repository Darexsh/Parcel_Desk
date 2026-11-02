import { OcrWorker } from '../../core/transport/ocrWorker.js';

export class ChunghwaPostOcr extends OcrWorker {
  constructor() {
    super('Chunghwa Post', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'chunghwa-post' });
  }
}

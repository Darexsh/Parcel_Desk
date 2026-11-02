import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** Correios' model and queue are loaded only when an image needs reading. */
export class CorreiosOcr extends OcrWorker {
  constructor() { super('Correios', new URL('./ocr-worker.mjs', import.meta.url)); }
}

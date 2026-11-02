import { OcrWorker } from '../../core/transport/ocrWorker.js';

export class ViettelPostOcr extends OcrWorker {
  constructor() { super('Viettel Post', new URL('./ocr-worker.mjs', import.meta.url)); }
}

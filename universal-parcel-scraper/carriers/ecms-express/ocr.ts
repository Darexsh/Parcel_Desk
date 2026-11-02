import { OcrWorker } from '../../core/transport/ocrWorker.js';

export function arithmeticAnswer(expression: string): string {
  const match = /^(\d)([+-])(\d)$/.exec(expression);
  if (!match) return '';
  const left = Number(match[1]), right = Number(match[3]);
  return String(match[2] === '+' ? left + right : left - right);
}

export class EcmsExpressOcr extends OcrWorker {
  constructor() {
    super('ECMS Express', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'ecms-express' });
  }

  override async solve(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    return arithmeticAnswer(await super.solve(bytes, signal));
  }
}

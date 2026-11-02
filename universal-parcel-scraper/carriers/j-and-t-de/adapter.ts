import type { AdapterFactory } from '../../core/adapter/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { jAndTAdapter, JAndTTracker } from '../j-and-t-au/official.js';
import { J_AND_T_DE } from './parser.js';

/** The lookup the tracking page on www.jtexpress.de makes for the waybills typed in. */
export const J_AND_T_DE_API = J_AND_T_DE.api;

export class JAndTDeTracker extends JAndTTracker {
  constructor(options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    super(J_AND_T_DE, options);
  }
}

export const adapter: AdapterFactory = jAndTAdapter(J_AND_T_DE);

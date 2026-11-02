import type { AdapterFactory } from '../../core/adapter/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { jAndTAdapter, JAndTTracker } from '../j-and-t-au/official.js';
import { J_AND_T_UK } from './parser.js';

/** The lookup the tracking page on www.jtexpress.uk makes for the waybills typed in. */
export const J_AND_T_UK_API = J_AND_T_UK.api;

export class JAndTUkTracker extends JAndTTracker {
  constructor(options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    super(J_AND_T_UK, options);
  }
}

export const adapter: AdapterFactory = jAndTAdapter(J_AND_T_UK);

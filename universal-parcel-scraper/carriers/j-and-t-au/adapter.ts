import type { AdapterFactory } from '../../core/adapter/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { J_AND_T_APP_ID, J_AND_T_SIGNING_KEY, J_AND_T_ZONE, jAndTAdapter, jAndTRequest, jAndTSignature, JAndTTracker } from './official.js';
import { J_AND_T_AU } from './parser.js';

/** The lookup the tracking page on www.jtexpress.au makes for the waybills typed in. */
export const J_AND_T_AU_API = J_AND_T_AU.api;
export const J_AND_T_AU_APP_ID = J_AND_T_APP_ID;
export const J_AND_T_AU_SIGNING_KEY = J_AND_T_SIGNING_KEY;
export const J_AND_T_AU_ZONE = J_AND_T_ZONE;
export const jAndTAuSignature = jAndTSignature;

/** The page's request for one waybill, signed over its fields with their keys sorted. */
export function jAndTAuRequest(number: string): { body: string; headers: Record<string, string> } {
  return jAndTRequest(J_AND_T_AU, number);
}

export class JAndTAuTracker extends JAndTTracker {
  constructor(options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    super(J_AND_T_AU, options);
  }
}

export const adapter: AdapterFactory = jAndTAdapter(J_AND_T_AU);

import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeGLSItalyNumber, parseGLSItalyReply, PROVIDER } from './parser.js';

// The GLS group's tracking service under GLS Italy's own path. With the national
// type it answers a national shipment number with the whole history, as the
// Italian tracking page asks it, without a postcode.
const ENDPOINT = 'https://gls-group.com/app/service/open/rest/IT/en/rstt030';
// A shipment reply is a few kilobytes.
const MAX_BYTES = 512 * 1024;
// A bot check or a block page instead of the service's JSON. A page that only
// loads a passive script is not one.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>[^<]*(?:just a moment|attention required|access denied)/i;

/** The lookup the tracking page makes for a national shipment number, in its English locale. */
export function glsItalyLookupUrl(raw: string): string {
  return `${ENDPOINT}?${new URLSearchParams({ match: normalizeGLSItalyNumber(raw), type: 'NAT', caller: 'witt002' })}`;
}

export class GLSItalyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGLSItalyNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(glsItalyLookupUrl(number), { signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES,
        allowHttpStatuses: [404], fetcher: this.options.fetcher });
      const head = decodeText(bytes.subarray(0, 4_096));
      if (/^\s*</.test(head)) {
        if (CHALLENGE.test(head)) throw new ChallengeError(PROVIDER, 'GLS Italy asked for a browser check');
        throw new IndeterminateError(PROVIDER, 'GLS Italy answered with a web page instead of tracking data');
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); } catch (cause) {
        throw new SchemaError(PROVIDER, 'GLS Italy returned invalid tracking JSON', { cause });
      }
      return parseGLSItalyReply(response.status, payload, number);
    };
    // A request that fails to reach GLS, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gls-it', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GLSItalyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gls-it', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGLSItalyNumber(number))),
  };
};

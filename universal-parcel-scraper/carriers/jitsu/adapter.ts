import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isJitsuNotFound, JITSU_MAX_BYTES, normalizeJitsuNumber, parseJitsu, PROVIDER } from './parser.js';

// The service Jitsu's tracker and recipient app ask for a delivery by its code.
export const JITSU_ENDPOINT = 'https://api.recipient.gojitsu.com/delivery/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Statuses that alone say nothing about the code: only the service's own 404 body does.
const GONE = [404, 410];
// A challenge page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;

export function jitsuTrackingUrl(raw: string): string {
  return `${JITSU_ENDPOINT}${normalizeJitsuNumber(raw)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Jitsu answered with a browser challenge', { cause: error });
    throw new SchemaError(PROVIDER, 'Jitsu returned a reply that is not JSON', { cause: error });
  }
}

export class JitsuTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJitsuNumber(raw);
    const url = `${JITSU_ENDPOINT}${number}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The tracker sends no token for this read; a token only unlocks the
      // recipient's own details and changes, which the adapter never asks for.
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JITSU_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Jitsu moved its tracking service');
      const body = decodeText(bytes);
      if (GONE.includes(response.status)) {
        let reply: unknown = null;
        try { reply = JSON.parse(body); } catch { /* not the service's own answer */ }
        if (response.status === 404 && isJitsuNotFound(reply, number)) throw new NotFoundError(PROVIDER);
        // A route the service does not serve, which says nothing about the code.
        throw new TransportError(PROVIDER, 'Jitsu tracking service is unavailable');
      }
      return parseJitsu(json(body), number);
    };
    // A request that fails to reach Jitsu, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'jitsu', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JitsuTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jitsu', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJitsuNumber(number))),
  };
};

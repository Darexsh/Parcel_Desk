import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CONCERNS_MAX_BYTES, DETAIL_MAX_BYTES, normalizeNinetynineNumber, parseNinetynine, parseNinetynineSummary, PROVIDER,
  readConcern, recipientCheckRequired, TRACK_MAX_BYTES,
} from './parser.js';

// The service behind 99minutos's tracker, tracking.99minutos.com.
export const NINETYNINE_API = 'https://tracking-prd.hub.99min.io/api/v1/tracking/';
const ORIGIN = 'https://tracking.99minutos.com';
// The tracker's search sends this fixed token with every lookup, for every visitor.
const SEARCH_TOKEN = 'secure'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// A challenge page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes);
  try {
    return JSON.parse(body);
  } catch (error) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, '99minutos answered with a browser challenge', { cause: error });
    throw new SchemaError(PROVIDER, '99minutos returned a reply that is not JSON', { cause: error });
  }
}

export class NinetynineTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeNinetynineNumber(raw);
    const read = async (signal: AbortSignal, budgetMs: number): Promise<CarrierResult> => {
      const started = performance.now();
      const timeoutMs = () => Math.max(1, Math.floor(budgetMs - (performance.now() - started)));
      const post = (path: string, body: unknown, maxBytes: number, extra: Record<string, string> = {}) => fetchBounded(
        `${NINETYNINE_API}${path}`, { method: 'POST', signal, headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent), Origin: ORIGIN, Referer: `${ORIGIN}/`,
          // As the tracker's client, a request without a body sends no type: the service refuses an empty JSON body.
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra,
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes, redirect: 'manual', fetcher: this.options.fetcher,
          allowHttpStatuses: [...REDIRECTS, 401, 404] });

      // The search, as the tracker sends it: the number, its fixed token and the search action.
      const search = await post('concerns', { concerns: [number], token: SEARCH_TOKEN }, CONCERNS_MAX_BYTES, { 'x-action': 'search' });
      // A redirect or a missing route is a moved service, not a missing parcel.
      if (!search.response.ok) throw new TransportError(PROVIDER, '99minutos tracking search is unavailable');
      readConcern(json(search.bytes), number);

      const track = await post(`${number}/track`, undefined, TRACK_MAX_BYTES);
      if (track.response.status === 401) throw recipientCheckRequired();
      // The service relays a failed lookup as a bare 404, which says nothing about a guía the search found.
      if (!track.response.ok) throw new IndeterminateError(PROVIDER, '99minutos did not open the shipment its search found');
      const summary = parseNinetynineSummary(json(track.bytes), number);
      // The tracker sends an international shipment's visitor to UPS without asking for its history.
      if (summary.ups) return parseNinetynine(summary, null, number);

      const detail = await post(`${number}/detail`, undefined, DETAIL_MAX_BYTES);
      if (detail.response.status === 401) throw recipientCheckRequired();
      if (!detail.response.ok) throw new IndeterminateError(PROVIDER, '99minutos did not open the history of the shipment');
      return parseNinetynine(summary, json(detail.bytes), number);
    };
    // A request that fails to reach 99minutos, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: '99minutos', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NinetynineTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: '99minutos', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeNinetynineNumber(number))),
  };
};

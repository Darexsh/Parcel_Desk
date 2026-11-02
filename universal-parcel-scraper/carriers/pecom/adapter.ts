import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePecomNumber, parsePecom, PECOM_MAX_BYTES, PROVIDER } from './parser.js';

/** The JSON-RPC endpoint PEC's website calls for everything it looks up. */
export const PECOM_API = 'https://pecom.ru/ajax/';
/** The method the tracking page calls for one cargo's details and status history. */
export const PECOM_METHOD = 'LK.OCR.Get';
// The page sends its session id, which the lookup does not check, so a fixed one stands in.
const GUEST_SESSION = '0'.repeat(32);
const REDIRECTS = [301, 302, 303, 307, 308];
// Qrator's script check, which fronts pecom.ru.
const CHALLENGE = /__qrator|qauth\.js/i;

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 4_000))) throw new ChallengeError(PROVIDER, 'PEC answered with its bot check', { cause, status });
    if (status === 401) throw new ChallengeError(PROVIDER, 'PEC refused the lookup', { cause, status });
    throw new SchemaError(PROVIDER, 'PEC returned a reply that is not JSON', { cause });
  }
}

export class PecomTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePecomNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(PECOM_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ id: Date.now(), jsonrpc: '2.0', method: PECOM_METHOD, sessid: GUEST_SESSION, params: { cargoIndex: number } }) },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PECOM_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'PEC redirected its tracking lookup');
      // JSON-RPC errors come with HTTP 401, PEC's answer to an unknown cargo among them.
      return parsePecom(json(decodeText(bytes), response.status), number);
    };
    // A request that fails to reach PEC, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'pecom', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PecomTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pecom', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};

import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isNoxChallenge, normalizeNoxNumber, NOX_API, NOX_MAX_BYTES, parseNox, PROVIDER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the lookup answers an unknown barcode with `[]`.
const GONE = [404, 410];

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isNoxChallenge(body)) throw new ChallengeError(PROVIDER, 'nox answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'nox returned a reply that is not JSON', { cause });
  }
}

export class NoxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeNoxNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${NOX_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: NOX_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'nox sent the lookup to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'The nox tracking lookup is unavailable', { status: response.status });
      // CloudFront and its firewall refuse with 403.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'nox refused the lookup', { status: 403 });
      return parseNox(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'nox', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NoxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'nox', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeNoxNumber(number))),
  };
};

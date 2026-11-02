import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeIsraelPostNumber, parseIsraelPost, PROVIDER } from './parser.js';

// The Android app's addPackageByCodeRequestWithoutLogin joins these two slashes.
export const ISRAEL_POST_ENDPOINT = 'https://apimftprd.israelpost.co.il/itemtracecert/items//';
// Shared across installs of com.israelpost.israelpost for anonymous tracking.
const SUBSCRIPTION_KEY = '856e324428194b8885732347153fe47f'; // gitleaks:allow
const BLOCKED = /<title>\s*(?:Access Denied|Just a moment|Attention Required)|_cf_chl_opt|cf-turnstile|הגישה נחסמה/i;

export class IsraelPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeIsraelPostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(ISRAEL_POST_ENDPOINT + number, { method: 'GET', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY, 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 256_000, redirect: 'manual', fetcher: this.options.fetcher }));
      } catch (error) {
        if (error instanceof UpstreamHttpError && [301, 302, 303, 307, 308, 404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Israel Post tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Israel Post answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'Israel Post returned invalid tracking JSON', { cause });
      }
      return parseIsraelPost(payload, number);
    };
    return runSteps({ carrier: 'israel-post', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new IsraelPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'israel-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeIsraelPostNumber(number))),
  };
};

import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizePostaSrbijeNumber, parsePostaSrbije, POSTA_SRBIJE_MAX_BYTES, PROVIDER } from './parser.js';

// The service Pošta Srbije's mobile app tracks items with. The tracking page
// at posta.rs checks a reCAPTCHA token on every lookup; the app's service
// takes the app's own user, the same for every install, and no token.
export const POSTA_SRBIJE_ENDPOINT = 'https://api.posta.rs/paketi';
const APP_USER = 'MAPeN';
const APP_PASSWORD = '<09;znCF_£..%B{93K##'; // gitleaks:allow
// The service's code for an item's tracking, and the kind of item: a letter or parcel.
const SERVICE = 111;
const TRACKING = 63;
const ITEM = 1;
// A firewall or server error page instead of the service's JSON.
const BLOCKED = /<html|request rejected|access denied|forbidden/i;

/** The app's request: an envelope whose client and input are JSON text. */
export function postaSrbijeRequest(number: string, transaction: string): string {
  return JSON.stringify({
    TipSerijalizacije: 2,
    StrKlijent: JSON.stringify({ Username: APP_USER, Password: APP_PASSWORD, Jezik: 'ENG', IdTipUredjaja: 3 }),
    Servis: SERVICE,
    // The service's own spelling.
    IdVrstaTranskacije: TRACKING,
    IdTransakcija: transaction,
    StrIn: JSON.stringify({ VrstaUsluge: ITEM, EksterniBroj: '', PrijemniBroj: number }),
  });
}

export class PostaSrbijeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostaSrbijeNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(POSTA_SRBIJE_ENDPOINT, { method: 'POST', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': userAgentOf(this.options.userAgent) },
          body: postaSrbijeRequest(number, crypto.randomUUID()) },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POSTA_SRBIJE_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // An unknown number has its own notice; a missing route is not a missing item.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Pošta Srbije tracking service is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) {
          throw new ChallengeError(PROVIDER, 'Pošta Srbije answered with a block page', { cause });
        }
        throw new SchemaError(PROVIDER, 'Pošta Srbije returned invalid tracking JSON', { cause });
      }
      return parsePostaSrbije(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'posta-srbije', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostaSrbijeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'posta-srbije', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostaSrbijeNumber(number))),
  };
};

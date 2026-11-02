import { type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { JNE_MAX_BYTES, normalizeJneNumber, parseJne, PROVIDER } from './parser.js';

// The My JNE app's guest API. `login-guest` mints an anonymous session token
// with an empty body, which the lookup carries in its `access-token` header.
export const JNE_LOGIN = 'https://apijne.rupibisnis.id/api/login-guest';
export const JNE_LOOKUP = 'https://apijne.rupibisnis.id/api/l3v14than-res1';
// The app's client code, the same for every install, used for guest tracking.
const CLIENT_CODE = 'JN3XRUP1'; // gitleaks:allow
// The gateway only answers its app's HTTP client; other User-Agents get an
// empty reply. So it keeps the client the app names instead of the host's.
const APP_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'okhttp/4.12.0' };
const LOGIN_TIMEOUT_MS = 8_000;
// Bot checks a CDN or firewall could put in place of the JSON reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'JNE answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'JNE returned a reply that is not JSON', { cause });
  }
}

export class JneTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  private async token(signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(JNE_LOGIN, { method: 'POST', signal, headers: APP_HEADERS, body: '{}' }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 16 * 1024,
      fetcher: this.options.fetcher, allowHttpStatuses: [403, 429],
    });
    if (response.status === 429) throw new RateLimitedError(PROVIDER, undefined, 'JNE refused the guest login');
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'JNE refused the guest login', { status: 403 });
    const reply = json(decodeText(bytes));
    if (!isRecord(reply) || reply.status !== '00' || typeof reply.token !== 'string' || !reply.token) {
      throw new SchemaError(PROVIDER, 'JNE did not return a guest token');
    }
    return reply.token;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJneNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const token = await this.token(signal, Math.min(LOGIN_TIMEOUT_MS, timeoutMs / 2));
      const { response, bytes } = await fetchBounded(JNE_LOOKUP, { method: 'POST', signal,
        headers: { ...APP_HEADERS, 'access-token': token }, body: JSON.stringify({ code: number, clientcode: CLIENT_CODE }) }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JNE_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [401, 403, 429],
      });
      if (response.status === 429) throw new RateLimitedError(PROVIDER, undefined, 'JNE rate limited the lookup');
      if (response.status === 401 || response.status === 403) throw new ChallengeError(PROVIDER, 'JNE refused the lookup', { status: response.status });
      const reply = json(decodeText(bytes));
      // An expired guest token answers "77"; the next lookup mints a fresh one.
      if (isRecord(reply) && reply.status === '77') throw new TransportError(PROVIDER, 'JNE rejected the guest token');
      return parseJne(reply, number);
    };
    return runSteps({ carrier: 'jne', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JneTracker({ fetcher: environment.fetcher, recorder: environment.recorder });
  return {
    id: 'jne', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};

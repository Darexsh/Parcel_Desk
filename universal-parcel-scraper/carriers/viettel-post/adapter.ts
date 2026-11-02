import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ViettelPostOcr } from './ocr.js';
import { isViettelCaptchaError, normalizeViettelPostNumber, parseViettelPost, PROVIDER, VIETTEL_MAX_BYTES } from './parser.js';

export { normalizeViettelPostNumber, parseViettelPost } from './parser.js';

const ORIGIN = 'https://api.viettelpost.vn';
const API = `${ORIGIN}/api/orders/`;
type Solver = (bytes: Uint8Array, signal: AbortSignal) => Promise<string>;

export class ViettelPostTracker {
  private readonly ocr = new ViettelPostOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeViettelPostNumber(raw);
    return runSteps({ carrier: 'viettel-post', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted();
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (path: string, body?: unknown): Promise<unknown> => {
        const { bytes } = await fetchBounded(`${API}${path}`, { signal, method: body === undefined ? 'GET' : 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://viettelpost.vn',
            Referer: 'https://viettelpost.vn/', 'User-Agent': userAgentOf(this.options.userAgent) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        { provider: PROVIDER, timeoutMs: left(), maxBytes: VIETTEL_MAX_BYTES, fetcher });
        left();
        if (/^\s*</.test(decodeText(bytes))) throw new ChallengeError(PROVIDER, 'Viettel Post returned a verification page');
        try { return parseJsonBytes(bytes, PROVIDER); } catch { throw new SchemaError(PROVIDER, 'Viettel Post returned unreadable tracking JSON'); }
      };
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const opened = await request('getCaptcha');
          if (!isRecord(opened) || opened.error !== false || opened.status !== 200 || !isRecord(opened.data)) throw new ChallengeError(PROVIDER, 'Viettel Post did not open a text challenge');
          const challenge = opened.data;
          if (typeof challenge.id !== 'string' || !/^[\w-]{16,128}$/.test(challenge.id)
            || typeof challenge.captcha !== 'string' || challenge.captcha.length > 70_000
            || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(challenge.captcha)) throw new SchemaError(PROVIDER, 'Viettel Post changed its text challenge');
          const bytes = Buffer.from(challenge.captcha.slice('data:image/png;base64,'.length), 'base64');
          const answer = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(bytes, signal);
          left();
          if (!/^[A-Za-z0-9]{4}$/.test(answer)) {
            if (!attempt) continue;
            throw new ChallengeError(PROVIDER, 'Viettel Post text challenge could not be read');
          }
          const payload = await request('viewTrackingOrders', { id: challenge.id, captcha: answer, orders: number });
          if (!attempt && isViettelCaptchaError(payload)) continue;
          return parseViettelPost(payload, number);
        }
        throw new ChallengeError(PROVIDER, 'Viettel Post rejected the text challenge');
      } catch (error) {
        // The bounded transport's raw request/response diagnostics can hold challenge ids, answers and cookies.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }

  close() { return this.ocr.close(); }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ViettelPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'viettel-post', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};

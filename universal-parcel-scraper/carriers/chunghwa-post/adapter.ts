import { randomUUID } from 'node:crypto';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { BudgetExceededError, ChallengeError, InvalidInputError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ChunghwaPostOcr } from './ocr.js';
import { isChunghwaCaptchaFailure, isSupportedChunghwaPostNumber, normalizeChunghwaPostNumber, parseChunghwaPost, PROVIDER } from './parser.js';

export { normalizeChunghwaPostNumber, parseChunghwaPost } from './parser.js';
const BASE = 'https://postserv.post.gov.tw/pstmail/';
type Solver = (image: Uint8Array, signal: AbortSignal) => Promise<string>;

export class ChunghwaPostTracker {
  private readonly ocr = new ChunghwaPostOcr();
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; solveCaptcha?: Solver } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const normalized = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
    // Domestic, proprietary and other S10 services' references are refused before any request:
    // the international gateway cannot read them, and enabled universal providers follow them.
    if (/^(?:\d{14}|\d{20}|PB[A-Z0-9]{11})$/.test(normalized)
      || /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(normalized) && !isSupportedChunghwaPostNumber(normalized)) {
      throw new InvalidInputError(PROVIDER, 'This Chunghwa Post reference uses another tracking service');
    }
    const number = normalizeChunghwaPostNumber(raw);
    return runSteps({ carrier: 'chunghwa-post', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const left = () => {
        signal.throwIfAborted(); const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        return remaining;
      };
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (path: string, maxBytes: number, body?: unknown) => {
        const { response, bytes } = await fetchBounded(BASE + path, { signal, method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json;charset=UTF-8', Referer: BASE + 'main_mail.html', 'User-Agent': userAgentOf(this.options.userAgent) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        { provider: PROVIDER, timeoutMs: left(), maxBytes, fetcher, allowHttpStatuses: [404, 410] });
        if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'Chunghwa Post tracking is unavailable');
        if (/^\s*</.test(decodeText(bytes))) throw new ChallengeError(PROVIDER, 'Chunghwa Post returned a verification page');
        left(); return bytes;
      };
      try {
        await request('SessionServlet', 4096);
        for (let attempt = 0; attempt < 2; attempt++) {
          const uuid = randomUUID();
          const image = await request('jcaptcha?' + new URLSearchParams({ uuid }).toString(), 50_000);
          const answer = await (this.options.solveCaptcha ?? this.ocr.solve.bind(this.ocr))(image, signal);
          left();
          if (!/^\d{4}$/.test(answer)) {
            if (!attempt) continue;
            throw new ChallengeError(PROVIDER, 'Chunghwa Post text verification could not be read');
          }
          const bytes = await request('EsoafDispatcher', 1_000_000, {
            header: { InputVOClass: 'com.systex.jbranch.app.server.post.vo.EB500200InputVO', TxnCode: 'EB500200', BizCode: 'query',
              StampTime: true, SupvPwd: '', TXN_DATA: {}, SupvID: '', CustID: '', REQUEST_ID: '', ClientTransaction: true, DevMode: false, SectionID: 'esoaf' },
            body: { MAILNO: number, uuid, captcha: answer, pageCount: 10 },
          });
          let payload: unknown;
          try { payload = JSON.parse(decodeText(bytes)); } catch { throw new SchemaError(PROVIDER, 'Chunghwa Post returned unreadable tracking JSON'); }
          if (!attempt && isChunghwaCaptchaFailure(payload)) continue;
          return parseChunghwaPost(payload, number);
        }
        throw new ChallengeError(PROVIDER, 'Chunghwa Post rejected text verification');
      } catch (error) {
        // Raw transport diagnostics can contain the session cookie, challenge id and answer.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
  close() { return this.ocr.close(); }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ChunghwaPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'chunghwa-post', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};

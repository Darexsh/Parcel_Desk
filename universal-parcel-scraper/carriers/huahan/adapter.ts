import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeHuahanNumber, parseHuahan, PROVIDER } from './parser.js';

const BASE = 'https://www.hh-exp.cn/WebTrack/';

/** Only the public widget's bounded, two-operand arithmetic grammar is accepted. */
export function solveHuahanQuestion(question: unknown): string {
  const match = typeof question === 'string' && /^\s*(\d{1,3})\s*([+\-×*x÷/])\s*(\d{1,3})\s*=\s*\?\s*$/.exec(question);
  if (!match) throw new ChallengeError(PROVIDER, 'HuaHan presented an unsupported verification question');
  const a = Number(match[1]), b = Number(match[3]);
  const answer = match[2] === '+' ? a + b : match[2] === '-' ? a - b : /[×*x]/.test(match[2]!) ? a * b : a / b;
  if (!Number.isSafeInteger(answer)) throw new ChallengeError(PROVIDER, 'HuaHan presented an unsupported verification answer');
  return String(answer);
}

function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(decodeText(bytes)); } catch { throw new SchemaError(PROVIDER, 'HuaHan returned unreadable tracking JSON'); }
}

export class HuahanTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeHuahanNumber(raw);
    return runSteps({ carrier: 'huahan', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const request = async (path: string, maxBytes: number, body?: URLSearchParams) => {
        signal.throwIfAborted();
        const timeoutMs = Math.floor(deadline - performance.now());
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        const { response, bytes } = await fetchBounded(BASE + path, {
          method: body ? 'POST' : 'GET', signal,
          headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
            Referer: BASE + 'CargoTrack.html', 'X-Requested-With': 'XMLHttpRequest',
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
          ...(body ? { body: body.toString() } : {}),
        }, { provider: PROVIDER, timeoutMs, maxBytes, fetcher, allowHttpStatuses: [401, 403, 404, 410] });
        if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'HuaHan tracking is unavailable');
        if (response.status === 401 || response.status === 403 || /^\s*</.test(decodeText(bytes))) {
          throw new ChallengeError(PROVIDER, 'HuaHan returned a verification page');
        }
        return bytes;
      };
      try {
        const init = json(await request('init.php?_=' + Date.now(), 4096));
        if (!isRecord(init) || init.ask !== 1 || typeof init.token !== 'string' || !/^[a-zA-Z0-9_-]{8,256}$/.test(init.token)) {
          throw new ChallengeError(PROVIDER, 'HuaHan did not open verification');
        }
        const params = new URLSearchParams({ token: init.token, _: String(Date.now()) });
        const challenge = json(await request('textcode.php?' + params.toString(), 4096));
        if (!isRecord(challenge) || challenge.ask !== 1 || challenge.type !== 'text') {
          throw new ChallengeError(PROVIDER, 'HuaHan presented an unsupported verification mode');
        }
        const answer = solveHuahanQuestion(challenge.question);
        const verified = decodeText(await request('check.php?' + new URLSearchParams({ token: init.token, answer }).toString(), 4096));
        if (verified.trim() !== 'ok') throw new ChallengeError(PROVIDER, 'HuaHan refused arithmetic verification');
        return parseHuahan(json(await request('CargoTrackAction.php', 1_000_000, new URLSearchParams({ ordernumber: number }))), number);
      } catch (error) {
        // Verification URLs and session cookies must not enter transport diagnostics.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HuahanTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'huahan', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};

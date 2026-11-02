
import { createHash, randomBytes } from 'node:crypto';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { solveYundaSlider, UncertainYundaSliderError } from './challenge.js';
import { normalizeYundaNumber, parseYunda, yundaEnvelope } from './parser.js';

const ORIGIN = 'https://web.yundaex.com';
// Public apiSetting.js on the current consumer site signs ordinary anonymous
// requests with MD5(SHA1(randomStr + client constant + timestamp)).
const CLIENT_CONSTANT = '2024YdWeb';

export class YundaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeYundaNumber(raw);
    return runSteps({ carrier: 'yunda', signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // A fresh, request-scoped session binds challenge generation and lookup.
      const sessionFetch = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar()) as typeof fetch;
      const started = Date.now();
      const randomStr = randomBytes(8).toString('hex');
      const timeStamp = String(Date.now());
      const signature = createHash('md5').update(createHash('sha1').update(randomStr + CLIENT_CONSTANT + timeStamp).digest('hex')).digest('hex').toUpperCase();
      const params = new URLSearchParams({ wid: '22', randomStr, timeStamp, signature });
      const request = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
        const headers = { ...init.headers, 'User-Agent': userAgentOf(this.options.userAgent) };
        try {
          const { bytes } = await fetchBounded(ORIGIN + path, { ...init, headers, signal }, {
            provider: 'Yunda Express', timeoutMs: Math.max(1, Math.floor(remainingMs - (Date.now() - started))),
            maxBytes: 1_000_000, fetcher: sessionFetch });
          return parseJsonBytes(bytes, 'Yunda Express');
        } catch (error) {
          if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Yunda Express', 'Yunda tracking endpoint is unavailable', { cause: error });
          throw error;
        }
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        // The public client's reset repeats both requests in the same session.
        const type = yundaEnvelope(await request('/index.php/api/order.record/captcha_type?' + params.toString()));
        if (type.data !== 1) throw new ChallengeError('Yunda Express', 'Yunda requires an unsupported verification type');
        const captcha = yundaEnvelope(await request('/index.php/api/order.record/captcha?' + params.toString()));
        if (!isRecord(captcha.data)) throw new SchemaError('Yunda Express');
        let coordinate;
        try { coordinate = await solveYundaSlider(captcha.data, signal); }
        catch (error) {
          if (!attempt && error instanceof UncertainYundaSliderError) continue;
          throw error;
        }
        signal.throwIfAborted();
        const body = new FormData();
        for (const [key, value] of params) body.append(key, value);
        body.append('x', String(coordinate.x)); body.append('y', String(coordinate.y)); body.append('tm', number);
        // Submit one confident coordinate; backend verification is authoritative.
        return parseYunda(await request('/index.php/api/v2.record/search', { method: 'POST', body }), number);
      }
      throw new ChallengeError('Yunda Express', 'Yunda slider match is uncertain');
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new YundaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'yunda', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};

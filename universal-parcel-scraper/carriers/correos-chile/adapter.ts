import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { normalizeCorreosChileNumber, parseCorreosChileBootstrap, parseCorreosChileTracking } from './parser.js';
import { fetchCorreosChileInBrowser } from './browser.js';
import { answerCorreosChileText } from './text-model.js';

const PAGE = 'https://www.correos.cl/seguimiento-en-linea';
const ORIGIN = 'https://www.correos.cl';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const BOOTSTRAP_MAX_BYTES = 500_000;
// The anonymous resource includes the full public branch list alongside the
// requested shipment, even though only the shipment detail is projected.
const TRACKING_MAX_BYTES = 6_000_000;

function anonymousSession(response: Response): string {
  const cookies = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const part = header.split(';', 1)[0] ?? '';
    const match = /^(JSESSIONID|SERVER_ID)=([A-Za-z0-9._~!$%&'*+\-^`|:=@]{1,512})$/.exec(part);
    if (match) cookies.set(match[1]!, part);
  }
  if (!cookies.has('JSESSIONID') || !cookies.has('SERVER_ID')) {
    throw new IndeterminateError('Correos de Chile', 'Anonymous tracking session is missing');
  }
  return `${cookies.get('JSESSIONID')}; ${cookies.get('SERVER_ID')}`;
}

export class CorreosChileTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder;
    browserWsEndpoint?: string | null; textModelUrl?: string | null } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCorreosChileNumber(raw);
    // Radware's bot check stops every plain read of the page, so with a browser
    // to ask the lookup starts there.
    const browser = Boolean(this.options.browserWsEndpoint);
    const budgetMs = context.budgetMs ?? (browser ? 45_000 : 15_000);
    return runSteps({ carrier: 'correos-chile', budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', enabled: !browser, run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const read = async (url: string, init: RequestInit, maxBytes: number) => {
        signal.throwIfAborted();
        const left = deadline - performance.now();
        if (left <= 0) throw new BudgetExceededError('Correos de Chile', budgetMs);
        const result = await fetchBounded(url, { ...init, signal }, {
          provider: 'Correos de Chile', timeoutMs: Math.max(1, Math.floor(left)), maxBytes,
          redirect: 'manual', allowHttpStatuses: [302, 403, 404, 410], fetcher: this.options.fetcher,
        });
        if (performance.now() >= deadline) throw new BudgetExceededError('Correos de Chile', budgetMs);
        signal.throwIfAborted();
        // Radware's bot manager answers with a 302 page that sends the browser to
        // its validation host, signed with its rdwr marker.
        if (result.response.status === 403 || (result.response.status === 302
          && /validate\.perfdrive\.com|<center>rdwr<\/center>/i.test(decodeText(result.bytes)))) {
          throw new ChallengeError('Correos de Chile', 'Tracking page requires browser verification');
        }
        if (result.response.status !== 200) {
          throw new IndeterminateError('Correos de Chile', 'Anonymous tracking resource is unavailable');
        }
        return result;
      };
      const bootstrap = await read(PAGE, { headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
      } }, BOOTSTRAP_MAX_BYTES);
      const html = decodeText(bootstrap.bytes);
      const session = parseCorreosChileBootstrap(html);
      const cookie = anonymousSession(bootstrap.response);
      const body = new URLSearchParams({ [session.numberField]: number, p_auth: session.csrf });
      const tracking = await read(session.url, { method: 'POST', body, headers: {
        'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN, Referer: PAGE, Cookie: cookie,
      } }, TRACKING_MAX_BYTES);
      const text = decodeText(tracking.bytes);
      if (/Radware (?:Captcha )?Page|Please solve this CAPTCHA/i.test(text)) {
        throw new ChallengeError('Correos de Chile', 'Tracking resource returned a browser challenge');
      }
      let payload: unknown;
      try { payload = JSON.parse(text); }
      catch { throw new SchemaError('Correos de Chile', 'Tracking resource returned invalid JSON'); }
      return parseCorreosChileTracking(payload, number);
    } }, {
      id: 'browser', enabled: browser,
      run: ({ signal, remainingMs }) => {
        if (remainingMs < 10_000) throw new BudgetExceededError('Correos de Chile', budgetMs);
        return fetchCorreosChileInBrowser(number, this.options.browserWsEndpoint!, signal, Math.min(60_000, remainingMs),
          this.options.textModelUrl ? (heading, question, stopped, timeout) => answerCorreosChileText(
            this.options.textModelUrl!, heading, question, stopped, timeout, this.options.fetcher) : undefined);
      },
    }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CorreosChileTracker({ fetcher: environment.fetcher, recorder: environment.recorder,
    browserWsEndpoint: environment.env.CORREOS_CHILE_BROWSER_WS_ENDPOINT?.trim() || null,
    textModelUrl: environment.env.CORREOS_CHILE_TEXT_MODEL_URL?.trim() || null });
  return { id: 'correos-chile', recordsSteps: true, steps: ['direct', 'browser'], track: (input, context) => tracker.fetch(input.number, context) };
};

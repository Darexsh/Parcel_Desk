import { accepted, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, carrierErrorKind, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { recoverableByDefault, runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { requestEvriUkInPage } from './browser.js';
import { EVRI_UK_UNCONFIRMED, readEvriUkMobile, recognizeEvriUkMobile } from './mobile.js';
import { normalizeEvriUkNumber, parseEvriUk } from './parser.js';

/** How long the guest API may take while the page can still answer. */
const DIRECT_TIMEOUT_MS = 10_000;

export class EvriUkTracker {
  constructor(private readonly options: {
    executablePath?: string | null; recorder?: StepRecorder; fetcher?: typeof fetch; userAgent?: string;
  } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeEvriUkNumber(raw);
    const budgetMs = context.budgetMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('Evri UK budget must be between 1 and 60000 ms');
    const browser = Boolean(this.options.executablePath);
    return runSteps({ carrier: 'evri-uk', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{
      id: 'direct', run: ({ signal, remainingMs }) => readEvriUkMobile(number, {
        fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal,
        timeoutMs: browser ? Math.min(remainingMs, DIRECT_TIMEOUT_MS) : remainingMs,
      }),
    }, {
      id: 'browser', enabled: browser,
      // The page reads the same history service, so its answer about the parcel would not differ.
      recovers: error => recoverableByDefault(error) && !(error instanceof CarrierError && error.reason === EVRI_UK_UNCONFIRMED),
      run: ({ signal, remainingMs: remaining }) => withLocalBrowser({ provider: 'Evri UK',
        executablePath: this.options.executablePath!, signal, timeoutMs: Math.max(1, Math.floor(remaining)),
        args: ['--disable-blink-features=AutomationControlled'],
      }, async ({ browser, signal: session, remainingMs }) => {
        try {
          const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
            : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
          const major = browser.version().split('.')[0];
          const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
          const browserContext = await browser.newContext({ locale: 'en-GB', userAgent, acceptDownloads: false, serviceWorkers: 'block' });
          session.throwIfAborted();
          await browserContext.route('**/*', async route => {
            const url = new URL(route.request().url());
            const allowed = url.protocol === 'https:' && (['www.evri.com', 'api.evri.com', 'tracking.platform-apis.evri.com'].includes(url.hostname)
              || url.hostname.endsWith('.edge.sdk.awswaf.com'));
            await (allowed ? route.continue() : route.abort());
          });
          const page = await browserContext.newPage();
          const response = await page.goto('https://www.evri.com/track-a-parcel', { waitUntil: 'domcontentloaded', timeout: Math.min(15_000, remainingMs()) });
          session.throwIfAborted();
          if (!response) throw new TransportError('Evri UK', 'Evri UK tracking page is unavailable');
          if ([401, 403].includes(response.status())) throw new ChallengeError('Evri UK');
          if (response.status() !== 200) throw new UpstreamHttpError('Evri UK', response.status());
          await page.waitForFunction(() => typeof (globalThis as typeof globalThis & { AwsWafIntegration?: { getToken?: unknown } }).AwsWafIntegration?.getToken === 'function',
            undefined, { timeout: Math.min(10_000, remainingMs()) });
          session.throwIfAborted();
          const reply = await page.evaluate(requestEvriUkInPage, { number, budgetMs: remainingMs() });
          session.throwIfAborted();
          if (reply.kind === 'ok') return parseEvriUk(reply.payload, number, reply.urn);
          if (reply.kind === 'http') {
            if ([401, 403, 405].includes(reply.status ?? 0)) throw new ChallengeError('Evri UK');
            if (reply.status === 429) throw new RateLimitedError('Evri UK', reply.retryAfter && /^\d+$/.test(reply.retryAfter) ? Number(reply.retryAfter) * 1_000 : undefined);
            if ([404, 410].includes(reply.status ?? 0)) throw new TransportError('Evri UK', 'Evri UK tracking endpoint is unavailable');
            throw new UpstreamHttpError('Evri UK', reply.status ?? 0);
          }
          if (['schema', 'identity', 'context'].includes(reply.kind)) throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking data');
          if (['indeterminate', 'scope'].includes(reply.kind)) throw new IndeterminateError('Evri UK', 'Evri UK could not confirm a domestic parcel');
          throw new TransportError('Evri UK', 'Evri UK browser tracking failed');
        } catch (error) {
          session.throwIfAborted();
          if (carrierErrorKind(error)) throw error;
          // Browser failures can include private tracking or issued URLs.
          throw new TransportError('Evri UK', 'Evri UK browser tracking failed');
        }
      }),
    }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new EvriUkTracker({
    executablePath: environment.browserExecutablePath, recorder: environment.recorder, fetcher: environment.fetcher,
    userAgent: environment.userAgent,
  });
  return {
    id: 'evri-uk', recordsSteps: true, steps: ['direct', 'browser'], track: (input, context) => tracker.fetch(input.number, context),
    // The guest API's reference lookup alone; the page is never opened to recognize a number.
    recognize: async (number, context = {}) => {
      if (!accepted(() => normalizeEvriUkNumber(number))) return { known: false };
      const budgetMs = context.budgetMs ?? DIRECT_TIMEOUT_MS;
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Evri UK budget must be positive');
      return recognizeEvriUkMobile(number, { fetcher: environment.fetcher, userAgent: environment.userAgent,
        signal: context.signal ?? new AbortController().signal, timeoutMs: budgetMs });
    },
  };
};

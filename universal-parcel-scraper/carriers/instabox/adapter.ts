import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { validateInstaboxTrackingUrl } from '../../core/catalog/urls.js';
import { ChallengeError, IndeterminateError, InputRequiredError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MAX_BYTES, normalizeInstaboxNumber, parseInstabox, PROVIDER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];

function withoutCapability(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(PROVIDER, new Error('Instabox notification request failed'));
  return error;
}

export class InstaboxTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  fetch(raw: string, trackingUrl: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeInstaboxNumber(raw);
    const initial = validateInstaboxTrackingUrl(trackingUrl, number);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      let url = initial;
      for (let redirects = 0; redirects <= 2; redirects++) {
        signal.throwIfAborted();
        let fetched;
        try {
          fetched = await fetchBounded(url, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.environment.userAgent) } },
            { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: MAX_BYTES,
              fetcher: this.environment.fetcher, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404] });
        } catch (error) { throw withoutCapability(error); }
        const { bytes, response } = fetched;
        if (REDIRECTS.includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new SchemaError(PROVIDER, 'Instabox returned an incomplete redirect');
          const destination = new URL(location, url);
          if (destination.hostname === 'track.instabox.com' && /\/verify\/?$/.test(destination.pathname)) {
            throw new IndeterminateError(PROVIDER, 'Instabox did not accept the notification link', { reason: 'session_rejected' });
          }
          try { url = validateInstaboxTrackingUrl(destination.toString(), number); }
          catch { throw new IndeterminateError(PROVIDER, 'Instabox moved the tracking page outside the notification route'); }
          continue;
        }
        if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Instabox refused notification verification');
        if (response.status === 404) throw new IndeterminateError(PROVIDER, 'Instabox could not open the notification link');
        const html = decodeText(bytes);
        if (/<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt/i.test(html.slice(0, 64000))) throw new ChallengeError(PROVIDER);
        return parseInstabox(html, number);
      }
      throw new IndeterminateError(PROVIDER, 'Instabox returned too many notification redirects');
    };
    return runSteps({ carrier: 'instabox', budgetMs: context.budgetMs ?? 15000, signal: context.signal, recorder: this.environment.recorder }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new InstaboxTracker(environment);
  return { id: 'instabox', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => {
    if (!input.trackingUrl) throw new InputRequiredError(PROVIDER, 'trackingUrl', 'Instabox requires the complete notification link');
    return tracker.fetch(input.number, input.trackingUrl, context);
  } };
};

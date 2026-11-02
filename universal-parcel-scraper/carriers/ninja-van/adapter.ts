import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ninjaVanCountry } from '../../core/detection/ninjaVan.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeNinjaVanNumber, parseNinjaVan, parseNinjaVanNotFound } from './parser.js';

const ENDPOINT = 'https://walrus.ninjavan.co';

export class NinjaVanTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeNinjaVanNumber(raw);
    return runSteps({ carrier: 'ninja-van', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      if (remainingMs <= 0) throw new BudgetExceededError('Ninja Van', context.budgetMs ?? 15_000);
      const url = new URL(`/${ninjaVanCountry(number)!}/dash/1.2/public/orders`, ENDPOINT);
      url.searchParams.set('tracking_id', number);
      const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: 'Ninja Van', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404], fetcher: this.options.fetcher,
      });
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, 'Ninja Van'); }
      catch (cause) {
        if (/<title>\s*Just a moment|cf-chl-|challenge-platform|cf-turnstile|px-captcha|captcha-delivery\.com/i.test(decodeText(bytes))) {
          throw new ChallengeError('Ninja Van');
        }
        throw new SchemaError('Ninja Van', 'Ninja Van returned invalid tracking JSON', { cause });
      }
      if (response.status === 404) return parseNinjaVanNotFound(payload, number);
      if (response.status !== 200) throw new IndeterminateError('Ninja Van', 'Ninja Van returned an inconclusive tracking response');
      return parseNinjaVan(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new NinjaVanTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'ninja-van', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeNinjaVanNumber(number))) };
};

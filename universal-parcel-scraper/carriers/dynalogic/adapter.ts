import { accepted, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { blockedMinutes, DYNALOGIC_MAX_BYTES, dynalogicNotice, normalizeDynalogicNumber, NOT_FOUND_NOTICE, parseDynalogic, PROVIDER } from './parser.js';

export const DYNALOGIC_ORIGIN = 'https://track.mydynalogic.eu';

/**
 * The tracker's first lookup: the order's status from its number alone. With
 * the delivery postcode the tracker asks another route for the history and
 * address, which the adapter does not use.
 */
export const dynalogicOrderUrl = (number: string) =>
  `${DYNALOGIC_ORIGIN}/api/transportorder/partial/ordernumber/${encodeURIComponent(number)}`;

/** An HTTP error without the service's own notice keeps its status; a missing route is not a missing order. */
function httpFailure(response: Response): Error {
  if ([404, 410].includes(response.status)) return new TransportError(PROVIDER, 'Dynalogic tracking endpoint is unavailable');
  const seconds = /^\d{1,6}$/.exec(response.headers.get('retry-after')?.trim() ?? '');
  return new UpstreamHttpError(PROVIDER, response.status, seconds ? Number(seconds[0]) * 1000 : undefined);
}

export class DynalogicTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDynalogicNumber(raw);
    return runSteps({ carrier: 'dynalogic', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(dynalogicOrderUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json',
        // The service refuses a request that does not come from its tracker's page script.
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${DYNALOGIC_ORIGIN}/track/login`,
        // The status caption follows the tracker's language.
        Locale: 'en',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: DYNALOGIC_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpError: true });
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (!response.ok) throw httpFailure(response);
        if (/<title>\s*Just a moment|_cf_chl_opt|cf-turnstile/i.test(decodeText(bytes.subarray(0, 64_000)))) {
          throw new ChallengeError(PROVIDER, 'Dynalogic answered with a browser challenge', { cause });
        }
        throw new SchemaError(PROVIDER, 'Dynalogic returned invalid tracking JSON', { cause });
      }
      const notice = dynalogicNotice(payload);
      // The tracker shows this notice, with its minutes, when the service has blocked the visitor's address.
      const minutes = blockedMinutes(notice);
      if (minutes !== undefined) {
        throw new RateLimitedError(PROVIDER, minutes === null ? undefined : minutes * 60_000, 'Dynalogic has blocked this address for a while');
      }
      if (response.status === 404 && notice === NOT_FOUND_NOTICE) throw new NotFoundError(PROVIDER);
      if (!response.ok) throw httpFailure(response);
      return parseDynalogic(payload, number);
    } }]);
  }

  /** The service answers only the orders it holds, under their whole number, so any order it returns is known. */
  async recognize(number: string, context: TrackingContext = {}): Promise<Recognition> {
    if (!accepted(() => normalizeDynalogicNumber(number))) return { known: false };
    try {
      await this.fetch(number, context);
    } catch (error) {
      if (['not_found', 'invalid_input'].includes(carrierErrorKind(error) ?? '')) return { known: false };
      throw error;
    }
    return { known: true, lastActivityAt: null };
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DynalogicTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dynalogic', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context) };
};

import { accepted, readerLanguage, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, SchemaError, carrierErrorKind } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import {
  correosExpressFeedResult, normalizeCorreosExpressNumber, parseCorreosExpressFeed, readCorreosExpress, type CorreosExpressFeed, type CorreosExpressRead,
} from './parser.js';
import type { CorreosExpressLanguage } from './status.js';

const PROVIDER = 'Correos Express';
/** The form words its scans in Spanish, and in Portuguese at the address correosexpress.pt's tracking box posts to. */
const FORM_ENDPOINTS: Readonly<Record<CorreosExpressLanguage, string>> = {
  es: 'https://s.correosexpress.com/SeguimientoSinCP/search',
  pt: 'https://s.correosexpress.com/SeguimientoSinCP/search-pt',
};
// The Correos group's keyless localizador, which correos.es's tracker reads.
// It words its scans in the language codIdioma names.
const FEED_ENDPOINT = 'https://localizador.correos.es/canonico/eventos_envio_servicio';
/** The localizador answers within a second; the form's answer does not wait longer for it. */
const FEED_TIMEOUT_MS = 5_000;
const MAX_BYTES = 1_000_000;

/** The localizador's history, null when it has no trace of the number, or why it could not be read. */
type FeedOutcome = { feed: CorreosExpressFeed | null } | { error: unknown };

export class CorreosExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /**
   * `language` words the scans. A Portuguese page with a label the map does not
   * read is asked for again in Spanish, which stands in its place.
   */
  fetch(raw: string, context: TrackingContext = {}, language: CorreosExpressLanguage = 'es') {
    const number = normalizeCorreosExpressNumber(raw);
    // One localizador request in each language serves both steps: it starts with the form's.
    const feeds = new Map<CorreosExpressLanguage, Promise<FeedOutcome>>();
    const localizador = (lang: CorreosExpressLanguage, signal: AbortSignal, remainingMs: number) => {
      const feed = feeds.get(lang) ?? this.feed(number, lang, signal, remainingMs);
      feeds.set(lang, feed);
      return feed;
    };
    const lookup = async (lang: CorreosExpressLanguage, signal: AbortSignal, remainingMs: number): Promise<CorreosExpressRead> => {
      const pending = localizador(lang, signal, remainingMs);
      const page = await this.form(number, lang, signal, remainingMs);
      const outcome = await pending;
      try {
        return readCorreosExpress(page, number, 'feed' in outcome ? outcome.feed : undefined);
      } catch (error) {
        // The form forgets a shipment some time after delivery and then answers as it
        // does for a number it never had. Only the localizador having no trace either
        // makes that answer a negative.
        if (!(error instanceof NotFoundError)) throw error;
        if ('error' in outcome) throw outcome.error;
        if (!outcome.feed) throw error;
        return { result: correosExpressFeedResult(outcome.feed, number, lang), unread: false };
      }
    };
    return runSteps({ carrier: 'correos-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const deadline = performance.now() + remainingMs;
      const read = await lookup(language, signal, remainingMs);
      // A Portuguese label the map does not read may be a scan only the Spanish labels stage.
      if (language === 'es' || !read.unread) return read.result;
      const spanish = await lookup('es', signal, Math.max(1, deadline - performance.now())).catch(() => {
        context.signal?.throwIfAborted();
        return read;
      });
      return spanish.result;
    } }, {
      // The localizador answers for a shipment the form could not show. Its having no
      // trace of the number says nothing about the form's failure, which stands.
      id: 'correos',
      recovers: (error) => !['not_found', 'invalid_input', 'budget'].includes(carrierErrorKind(error) ?? ''),
      run: async ({ signal, remainingMs, previousError }) => {
        const outcome = await localizador(language, signal, remainingMs);
        if ('error' in outcome || !outcome.feed) throw previousError;
        try {
          return correosExpressFeedResult(outcome.feed, number, language);
        } catch {
          throw previousError;
        }
      },
    }]);
  }

  private async form(number: string, language: CorreosExpressLanguage, signal: AbortSignal, remainingMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(FORM_ENDPOINTS[language], { method: 'POST', signal,
      headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) }, body: new URLSearchParams({ shippingNumber: number, errorCode: '' }),
    }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: MAX_BYTES,
      allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
    if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Correos Express tracking endpoint is unavailable');
    return decodeText(bytes);
  }

  /** Never rejects: a failure is kept for the step that needs the answer. */
  private async feed(number: string, language: CorreosExpressLanguage, signal: AbortSignal, remainingMs: number): Promise<FeedOutcome> {
    try {
      const { bytes } = await fetchBounded(`${FEED_ENDPOINT}/${number}?codAplicacion=60&codCanal=3&codIdioma=${language.toUpperCase()}&indUltEvento=N`, {
        signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(Math.min(FEED_TIMEOUT_MS, remainingMs))), maxBytes: MAX_BYTES,
        fetcher: this.options.fetcher });
      let payload: unknown;
      try {
        payload = parseJsonBytes(bytes, PROVIDER);
      } catch (error) {
        throw new SchemaError(PROVIDER, 'The Correos localizador returned an invalid reply', { cause: error });
      }
      return { feed: parseCorreosExpressFeed(payload, number) };
    } catch (error) {
      return { error };
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreosExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'correos-express', recordsSteps: true, steps: ['direct', 'correos'],
    track: (input, context) => tracker.fetch(input.number, context, readerLanguage(input, ['pt']) ?? 'es'),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeCorreosExpressNumber(number))) };
};

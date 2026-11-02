import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CORREOS_DE_MEXICO_MAX_BYTES, CORREOS_DE_MEXICO_ORIGIN, correosDeMexicoLookupUrl, correosDeMexicoResult, correosDeMexicoYearFields,
  firstSequence, normalizeCorreosDeMexicoNumber, PROVIDER, readCorreosDeMexicoPage, type CorreosDeMexicoPage, type CorreosDeMexicoScan,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A page the site no longer serves, which says nothing about the item.
const UNAVAILABLE = [404, 410];
// Where the site sends a request it fails to serve.
const MAINTENANCE = /\/Mantenimiento\.aspx(?:\?|$)/i;

export class CorreosDeMexicoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCorreosDeMexicoNumber(raw);
    // The tracker answers for one year at a time and files each event under
    // the year it happened. One attempt opens the page's own address for the
    // number, which answers for the current year, then posts the form back for
    // each older year it offers, as its search button does, until the history
    // reaches the item's first event or the years run out.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-MX' };
      const read = async (url: string, init: RequestInit) => {
        const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: CORREOS_DE_MEXICO_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE],
          fetcher: this.options.fetcher });
        if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, 'Correos de México tracking page is unavailable');
        if (REDIRECTS.includes(response.status)) {
          if (MAINTENANCE.test(response.headers.get('location') ?? '')) {
            throw new IndeterminateError(PROVIDER, 'Correos de México sent the lookup to its maintenance page', { reason: 'maintenance' });
          }
          throw new IndeterminateError(PROVIDER, 'Correos de México sent the lookup to another page');
        }
        return decodeText(bytes);
      };
      let page: CorreosDeMexicoPage = readCorreosDeMexicoPage(await read(correosDeMexicoLookupUrl(number), { method: 'GET', headers }), number);
      const older = [...page.olderYears];
      let scans: CorreosDeMexicoScan[] = [];
      for (;;) {
        if (page.scans) {
          // An earlier year's events come before the later year's in the history's sequence.
          if (scans.length && Math.max(...page.scans.map(scan => scan.sequence)) >= firstSequence(scans)) break;
          scans = [...page.scans, ...scans];
          if (firstSequence(scans) <= 1) break;
        }
        const year = older.shift();
        if (!year) break;
        signal.throwIfAborted();
        const html = await read(page.form.action, { method: 'POST', headers: { ...headers,
          'Content-Type': 'application/x-www-form-urlencoded', Origin: CORREOS_DE_MEXICO_ORIGIN, Referer: page.form.action },
        body: correosDeMexicoYearFields(page.form, number, year) });
        page = readCorreosDeMexicoPage(html, number, year);
      }
      // Missing only when every year the form offers has no information on the number.
      if (!scans.length) throw new NotFoundError(PROVIDER);
      return correosDeMexicoResult(scans, number);
    };
    // An attempt that fails to reach the site, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'correos-de-mexico', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreosDeMexicoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'correos-de-mexico', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCorreosDeMexicoNumber(number))),
  };
};

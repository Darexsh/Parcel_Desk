import { accepted, readerLanguage, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, IndeterminateError, MaintenanceError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ChronopostTracker } from '../chronopost/adapter.js';
import { DPDTracker } from '../dpd/adapter.js';
import { brtParcelListPath, groupShipment, normalizeBrtNumber, partnerShipment, readBrt, stagedDpdLeg, withOriginLeg, type BrtOriginPartner } from './parser.js';
import { brtEnglishLabel } from './status.js';

const BASE = 'https://vas.brt.it/vas/';
/** The time kept for BRT's own answer when a partner's lookup runs out. */
const ORIGIN_RESERVE_MS = 500;

/** A partner's lookup of the number BRT tracks a parcel under. */
export type BrtOriginLookup = (number: string, context: TrackingContext) => Promise<CarrierResult>;

/** The languages BRT's pages label scans in. */
export type BrtLanguage = 'en' | 'it';

export class BrtTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string;
    /** The lookups of partners that bring parcels from abroad, by the BRTcode they share. */
    origins?: Partial<Record<BrtOriginPartner, BrtOriginLookup>>;
    /** The DPD group's guest service, read while BRT's tracker is down. */
    group?: BrtOriginLookup } = {}) {}

  /**
   * `language` labels the scans. A page in Italian with a label the map has no
   * English for is asked again in English, which the map reads in full.
   */
  fetch(raw: string, context: TrackingContext = {}, language: BrtLanguage = 'en') {
    const number = normalizeBrtNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    return runSteps({ carrier: 'brt', budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const deadline = performance.now() + remainingMs;
      const page = async (url: string, form?: Record<string, string>): Promise<string> => {
        const left = deadline - performance.now();
        if (left <= 0) throw new BudgetExceededError('BRT', budgetMs);
        const { response, bytes } = await fetchBounded(url,
          { signal, headers: { 'User-Agent': userAgentOf(this.options.userAgent), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
            ...(form ? { method: 'POST', body: new URLSearchParams(form).toString() } : {}) },
          { provider: 'BRT', timeoutMs: Math.max(1, Math.floor(left)), maxBytes: 1_000_000,
            redirect: 'manual', allowHttpStatuses: [302, 404, 410], fetcher: this.options.fetcher });
        if (performance.now() >= deadline) throw new BudgetExceededError('BRT', budgetMs);
        signal.throwIfAborted();
        // While its tracker is down, BRT sends every page to a notice.
        if (response.status === 302 && /manutenzione/i.test(response.headers.get('location') ?? '')) {
          throw new MaintenanceError('BRT', "BRT's tracker is down for maintenance");
        }
        if (response.status !== 200) {
          // The status and a redirect's page, without its query, tell another notice from a missing page.
          const location = response.headers.get('location');
          let target = '';
          if (location) {
            try { const { host, pathname } = new URL(location, url); target = ` to ${host}${pathname}`; } catch { target = ' to an unreadable address'; }
          }
          throw new IndeterminateError('BRT', `BRT tracking endpoint is unavailable: HTTP ${response.status}${target}`);
        }
        const charset = /charset\s*=\s*["']?([A-Za-z0-9_-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]!.toLowerCase();
        if (charset && !['utf-8', 'utf8', 'iso-8859-1', 'windows-1252'].includes(charset)) throw new SchemaError('BRT', 'BRT response encoding changed');
        return decodeText(bytes, charset?.startsWith('utf') ? 'utf-8' : 'windows-1252');
      };
      const shipment = async (lang: BrtLanguage) => {
        if (number.length === 14) return readBrt(await page(`${BASE}sped_det_new.htm?brtCode=${number}&lang=${lang}`), number);
        if (number.length === 12) {
          return readBrt(await page(`${BASE}sped_det_show.hsm?lang=${lang}`,
            { Nspediz: number, referer: 'sped_numspe_par.htm', RicercaNumeroSpedizione: 'Ricerca', lang }), number);
        }
        // A parcel ID goes through the form's customer parcel ID search. Its
        // result does not repeat the ID, so the shipment's parcel list must name it.
        const detail = await page(`${BASE}sped_det_show.hsm?lang=${lang}`, { referer: 'sped_numspe_par.htm', ChiSono: number,
          ClienteMittente: '', DataInizio: '', DataFine: '', RicercaChiSono: 'Ricerca', lang });
        return readBrt(detail, number, await page(new URL(brtParcelListPath(detail, number), BASE).href));
      };
      let read = await shipment(language);
      // An Italian label the map cannot read in English may be a scan only the English labels stage.
      if (language === 'it' && !read.result.events?.every((event) => brtEnglishLabel(String(event.provider_status)))) {
        read = await shipment('en').catch(() => {
          context.signal?.throwIfAborted();
          return read;
        });
      }
      const { result, partner } = read;
      const lookup = number.length === 14 && partner && this.options.origins?.[partner];
      const budget = Math.floor(deadline - performance.now() - ORIGIN_RESERVE_MS);
      if (!lookup || budget <= 0) return result;
      // The partner's leg adds to BRT's answer, which stands without it.
      const leg = await lookup(number, { signal, budgetMs: budget }).catch(() => {
        context.signal?.throwIfAborted();
        return null;
      });
      return leg ? withOriginLeg(result, leg) : result;
    } }, {
      id: 'partner',
      // A BRTcode BRT has not processed names no partner yet. Chronopost or the
      // DPD network may already carry the parcel under it; an answer that does
      // not show it bound for Italy leaves BRT's inconclusive one.
      enabled: number.length === 14 && Boolean(this.options.origins?.chronopost || this.options.origins?.dpd),
      recovers: (error) => error instanceof IndeterminateError && error.reason === 'portal_not_found',
      run: async ({ signal, remainingMs, previousError }) => {
        const deadline = performance.now() + remainingMs;
        for (const partner of ['chronopost', 'dpd'] as const) {
          const lookup = this.options.origins?.[partner];
          const budget = Math.floor(deadline - performance.now());
          if (!lookup || budget <= 0) continue;
          const answer = await lookup(number, { signal, budgetMs: budget }).catch(() => {
            context.signal?.throwIfAborted();
            return null;
          });
          const shipment = answer && partnerShipment(answer);
          if (shipment) return shipment;
        }
        throw previousError;
      },
    }, {
      id: 'group',
      // While BRT's tracker is down, the DPD group's guest service reads a BRTcode DPD places in
      // Italy, each milestone once and without places. Any other answer leaves the outage.
      enabled: number.length === 14 && Boolean(this.options.group),
      recovers: (error) => error instanceof MaintenanceError,
      run: async ({ signal, remainingMs, previousError }) => {
        const answer = await this.options.group!(number, { signal, budgetMs: remainingMs }).catch(() => {
          context.signal?.throwIfAborted();
          return null;
        });
        if (!answer) throw previousError;
        return groupShipment(answer);
      },
    }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const transport = { fetcher: environment.fetcher, userAgent: environment.userAgent };
  const chronopost = new ChronopostTracker(transport);
  // DPD's guest service answers for the whole group; Belgium's unit asks it alone.
  const dpd = new DPDTracker({ ...transport, country: 'BE' });
  const group = new DPDTracker({ ...transport, country: 'IT' });
  const tracker = new BrtTracker({ ...transport, recorder: environment.recorder });
  // Recognition reads BRT alone.
  const tracking = new BrtTracker({ ...transport, recorder: environment.recorder, origins: {
    chronopost: (number, context) => chronopost.fetch(number, context),
    dpd: (number, context) => dpd.fetch(number, '', context).then(stagedDpdLeg),
  }, group: (number, context) => group.fetch(number, '', context) });
  return { id: 'brt', recordsSteps: true, steps: ['direct', 'partner', 'group'],
    track: (input, context) => tracking.fetch(input.number, context, readerLanguage(input, ['it']) ?? 'en'),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeBrtNumber(number))) };
};

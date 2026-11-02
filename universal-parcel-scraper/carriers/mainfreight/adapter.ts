import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  listedJobs, MAINFREIGHT_MAX_BYTES, mainfreightJson, masterBillsOf, normalizeMainfreightNumber, parseMainfreight, PROVIDER, searchedShipment,
  type MainfreightShipment,
} from './parser.js';

/** The tracker's API, which mainfreight.com/track reads: a search by reference, and a shipment under its service's code. */
export const MAINFREIGHT_API = 'https://www.mainfreight.com/track/api/trackings';
/** Mainfreight's app opens a shipment here, with the references it carries by type. */
export const MAINFREIGHT_APP_API = 'https://mobile.mainfreight.com/2.3/Tracker/Retrieve';
/**
 * The transport services whose eleven-digit consignment numbers the search
 * does not find: New Zealand, Australia and the United States. Their own
 * tracking links open the shipment under the service's code.
 */
export const CONSIGNMENT_SERVICES = ['MSNZS', 'MSAUS', 'MSUSS'] as const;
const CONSIGNMENT = /^\d{11}$/;
const REDIRECTS = [301, 302, 303, 307, 308];
// An unknown number is an empty list: a missing route is not a missing shipment.
const GONE = [404, 410];

export function mainfreightSearchUrl(number: string): string {
  return `${MAINFREIGHT_API}?reference=${encodeURIComponent(number)}`;
}

export function mainfreightShipmentUrl(shipment: MainfreightShipment): string {
  // The page asks in its own locale; the wording is English whichever it names.
  return `${MAINFREIGHT_API}/${encodeURIComponent(shipment.code)}/${encodeURIComponent(shipment.reference)}?lang=en-NZ`;
}

export class MainfreightTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** A GET, or a POST of `payload` as JSON, read as JSON. */
  async #get(url: string, signal: AbortSignal, timeoutMs: number, payload?: unknown): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: payload === undefined ? 'GET' : 'POST', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }, { provider: PROVIDER, timeoutMs, maxBytes: MAINFREIGHT_MAX_BYTES,
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'Mainfreight\'s tracking API is unavailable', { status: response.status });
    }
    const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
    if (!body) throw new IndeterminateError(PROVIDER, 'Mainfreight returned an empty reply');
    return mainfreightJson(body);
  }

  /**
   * The air and ocean job the search found by its master bill. The search
   * lists it under its job number and house bill, so the app's reply has to
   * name the number as the job's master bill. Several jobs under one master
   * bill, as in a consolidation, are no answer.
   */
  async #underMasterBill(search: unknown, number: string, signal: AbortSignal, left: () => number): Promise<MainfreightShipment | null> {
    const jobs = listedJobs(search);
    if (jobs.length > 1) throw new IndeterminateError(PROVIDER, 'Several Mainfreight jobs carry this number');
    const job = jobs[0];
    if (!job) return null;
    signal.throwIfAborted();
    const bills = masterBillsOf(await this.#get(MAINFREIGHT_APP_API, signal, left(), {
      permalink: job.code, reference: job.reference, brand: 'MFT',
    }), job);
    if (!bills) throw new IndeterminateError(PROVIDER, 'Mainfreight listed the shipment but did not open it');
    return bills.includes(number) ? job : null;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMainfreightNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      // The page's own search, then the shipment it opens.
      const search = await this.#get(mainfreightSearchUrl(number), signal, left());
      const listed = searchedShipment(search, number) ?? await this.#underMasterBill(search, number, signal, left);
      if (listed) {
        signal.throwIfAborted();
        const result = parseMainfreight(await this.#get(mainfreightShipmentUrl(listed), signal, left()), listed, number);
        if (!result) throw new IndeterminateError(PROVIDER, 'Mainfreight listed the shipment but did not open it');
        return result;
      }
      if (!CONSIGNMENT.test(number)) throw new NotFoundError(PROVIDER);
      signal.throwIfAborted();
      // Each transport service at once. When one fails, the others are not left running.
      const sibling = new AbortController();
      const each = AbortSignal.any([signal, sibling.signal]);
      try {
        const timeout = left();
        const found = (await Promise.all(CONSIGNMENT_SERVICES.map(async (code) => {
          const shipment = { code, reference: number };
          return parseMainfreight(await this.#get(mainfreightShipmentUrl(shipment), each, timeout), shipment, number);
        }))).filter((result): result is CarrierResult => result !== null);
        if (found.length > 1) throw new IndeterminateError(PROVIDER, 'Several Mainfreight services know this consignment number');
        if (!found.length) throw new NotFoundError(PROVIDER);
        return found[0]!;
      } finally {
        sibling.abort();
      }
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'mainfreight', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MainfreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mainfreight', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMainfreightNumber(number))),
  };
};

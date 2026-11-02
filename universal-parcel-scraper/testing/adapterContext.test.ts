/**
 * Every registered adapter and universal provider honors the caller's
 * `TrackingContext`: an aborted signal starts no request, an abort reaches the
 * requests in flight, and a spent budget ends the lookup and its requests.
 * Each one is driven with every corpus number, with its credential and
 * without, against a transport that never answers (plain HTTP, the browser
 * service and the local browser), in every combination of the two browsers a
 * host can configure, so each number form and each tier is driven where it
 * runs. The budget is driven with one number, since each lookup waits it out.
 * Each adapter of the registry is also dispatched through `trackCarrier` over
 * a transport that refuses every request, and reports that lookup to the
 * host's recorder at most once.
 * A transport that never answers holds a lookup at its first request:
 * `adapterContextSource.test.ts` reads from the source that the requests and
 * the timers after it are written with a signal too.
 */
import { chromium } from 'playwright-core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment, type AdapterFactory, type CarrierAdapter, type TrackingContext, type TrackingInput } from '../core/adapter/index.js';
import { trackCarrier } from '../core/adapter/track.js';
import { activeRequirements } from '../core/catalog/index.js';
import { carrierLinkRules } from '../core/catalog/linkRules.js';
import { normalizeTrackingNumber } from '../core/detection/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../core/telemetry/index.js';
import { loadNumberCorpusFiles } from '../core/testing/corpus.js';
import { TrawlClient } from '../core/transport/trawl.js';
import type { CarrierId } from '../generated/catalog.js';
import { REGISTRY } from '../generated/registry.js';
import { adapter as parcelsApp } from '../providers/parcelsapp/adapter.js';
import { adapter as postalNinja } from '../providers/postal-ninja/adapter.js';
import { adapter as seventeenTrack } from '../providers/seventeentrack/adapter.js';
import { adapter as ship24 } from '../providers/ship24/adapter.js';
import type { UniversalTracker } from '../providers/universal.js';
import { adapter as track718 } from '../providers/track718/adapter.js';
import { adapter as upu } from '../providers/upu/adapter.js';

vi.mock('playwright-core', () => ({ chromium: { launch: vi.fn() } }));

/** How long a cancelled lookup has to end. */
const SETTLE_MS = 2_000;
/** Long enough for a lookup to have its first request in flight; every lookup of the registry waits this long once. */
const BUDGET_MS = 10;
/** How long a lookup has to end once its budget is spent. */
const BUDGET_SETTLE_MS = 500;
const HOST_USER_AGENT = 'ConformanceHost/1.0';
/** A browser's own User-Agent, unlike a client that names itself in a `compatible` clause. */
const BROWSER_USER_AGENT = /^Mozilla\/5\.0 \((?!compatible;)/;
/** Carriers whose gateway answers only its own mobile app's HTTP client, with the client they name. */
const APP_USER_AGENT: Readonly<Record<string, string>> = {
  'australia-post': 'okhttp/4.12.0', 'egypt-post': 'Dart/3.9 (dart:io)', jne: 'okhttp/4.12.0', 'posta-slovenije': 'MojaPosta/2.5.0 (android)',
};
const BROWSER_SERVICE = 'http://trawl.invalid';
/** Recognition gets no postcode: Colis Privé recognizes a number only with its postcode at the end, which the corpus does not hold. */
const RECOGNIZED: Readonly<Record<string, (number: string) => string>> = { 'colis-prive': (number) => `${number}75001` };
/** The browsers a host can configure besides plain HTTP. */
interface Browsers { service: boolean; chromium: boolean }
const ENVIRONMENTS: Readonly<Record<string, Browsers>> = {
  'with the browser service and a local Chromium': { service: true, chromium: true },
  'with the browser service alone': { service: true, chromium: false },
  'with a local Chromium alone': { service: false, chromium: true },
  'with neither a browser service nor a local Chromium': { service: false, chromium: false },
};

/**
 * Adapters whose only way to the carrier is a browser, with the browsers that
 * serve them: in an environment with none of those, tracking fails before any
 * request. Every other lookup reaches its transport in every environment.
 */
const BROWSER_ONLY: Readonly<Record<string, readonly (keyof Browsers)[]>> = {
  'toyou': ['service'],
  'yalidine': ['service'],
  'kolay-gelsin': ['service'],
  'zoom-ve': ['service'],
  'fm-transportes': ['service'],
  Track718: ['service'],
  fedex: ['service'], 'magyar-posta': ['service'], 'mondial-relay': ['service'], 'old-dominion': ['chromium'], 'royal-mail': ['chromium'],
  loggi: ['service'], 'sf-express': ['service'], swiftx: ['service'], usps: ['service'], 'emirates-post': ['service'], '17TRACK': ['service'],
  'trendyol-express': ['service'],
  yunexpress: ['service', 'chromium'], 'Postal Ninja': ['service', 'chromium'],
};
/** Numbers a carrier above tracks over plain HTTP, without its browser. */
const HTTP_NUMBERS: Readonly<Record<string, RegExp>> = { 'mondial-relay': /^FV\d{8}$/ };

const corpus = new Map(loadNumberCorpusFiles().map((file) => [file.carrier, file.records]));
/** Synthetic numbers in the format of a carrier whose corpus has no public number yet. */
const UNSAMPLED: Readonly<Record<string, readonly string[]>> = {
  'dpd-hu': ['16400000000001'],
  homexpress: ['TMS00000000000'],
  'mongol-infinity-post': ['1000000'],
  'speed-and-safe': ['00000000'],
};

function credential(validator: string, number: string, carrier: string): string {
  switch (validator) {
    case 'swissPostcode': case 'swissOrFrancePostcode': case 'internationalPostcode': return '8000';
    case 'francePostcode': case 'colisPrivePostcode': return '75001';
    case 'germanyPostcode': return '00000';
    case 'paackPostcode': return '28001';
    case 'planzerSharedUrl':
      return `https://trackandtrace.planzergroup.com/shared/sendungen/${number}?accessKey=${'A'.repeat(32)}`;
    case 'dachserCapabilityUrl':
      return `https://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?numeroUnico=${number}&hash=AAAAAAAA`;
    case 'instaboxCapabilityUrl':
      return `https://track.instabox.com/sv/${number}?authCode=${'A'.repeat(32)}`;
    case 'freightwaysCapabilityUrl': {
      const receiver = carrierLinkRules(carrier as CarrierId).find((rule) => rule.keepsCapabilityUrl)!.domains[0];
      return `https://${receiver}/?consignmentid=CU..${number}.Z.0000000.1`;
    }
    default: throw new Error(`No synthetic credential for ${validator}`);
  }
}

/** A carrier's corpus numbers, with synthetic credentials where the catalog asks for one. */
function carrierInputs(carrier: string): TrackingInput[] {
  const numbers = (corpus.get(carrier) ?? []).filter((record) => !['negative', 'quarantined'].includes(record.role)).map((record) => record.number);
  return (numbers.length ? numbers : UNSAMPLED[carrier] ?? []).map((raw) => {
    const number = normalizeTrackingNumber(raw);
    const input: TrackingInput = { number };
    for (const requirement of activeRequirements(carrier, number)) {
      const value = credential(requirement.validator, number, carrier);
      if (requirement.field === 'trackingUrl') input.trackingUrl = value; else input.postcode = value;
    }
    return input;
  });
}

interface Subject { factory: AdapterFactory; inputs: () => TrackingInput[] }

/** Each adapter with the numbers of the carriers it serves; each provider with postal and courier numbers. */
const SUBJECTS: Readonly<Record<string, Subject>> = {
  Track718: { factory: track718, inputs: () => carrierInputs('juxi-express') },
  ...Object.fromEntries(Object.entries(REGISTRY.factories).map(([id, factory]) => [id, { factory, inputs: () =>
    [...new Set([id, ...Object.entries(REGISTRY.carriers).filter(([, adapter]) => adapter === id).map(([carrier]) => carrier)])]
      .flatMap(carrierInputs) }])),
  ...Object.fromEntries(Object.entries({ Ship24: ship24, ParcelsApp: parcelsApp, 'Postal Ninja': postalNinja, '17TRACK': seventeenTrack, UPU: upu })
    .map(([source, factory]) => [source, { factory, inputs: () => ['swiss-post', 'ups'].flatMap(carrierInputs).map(({ number }) => ({ number })) }])),
};

/** Between harnesses the global fetch refuses, so a lookup that outlives its test reaches no carrier. */
const refuse: typeof fetch = () => Promise.reject(new Error('The conformance test sends no request'));
vi.stubGlobal('fetch', refuse);

function environment(fetcher: typeof fetch, browsers: Browsers, recorder: StepRecorder = NOOP_RECORDER): AdapterEnvironment {
  return {
    fetcher, userAgent: HOST_USER_AGENT, recorder, env: {},
    trawl: browsers.service ? new TrawlClient(BROWSER_SERVICE, fetcher) : null,
    browserExecutablePath: browsers.chromium ? '/synthetic/chromium' : null,
  };
}

/**
 * A transport that answers nothing and ends each request only when its signal
 * aborts. The local browser launches, then never opens a page.
 */
function harness(subject: string, browsers: Browsers) {
  const signals: AbortSignal[] = [];
  let requested!: () => void;
  const firstRequest = new Promise<void>((resolve) => { requested = resolve; });
  const stalled = () => new Promise<never>(() => {});
  const launch = vi.mocked(chromium.launch).mockReset().mockImplementation(async () => {
    requested();
    return { version: () => '1.0', newContext: stalled, newPage: stalled, close: async () => {} } as never;
  });
  const fetcher = vi.fn<typeof fetch>((input, init) => new Promise<Response>((_, reject) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal) {
      signals.push(signal);
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }
    requested();
  }));
  vi.stubGlobal('fetch', fetcher);
  return { adapter: SUBJECTS[subject]!.factory(environment(fetcher, browsers)), firstRequest,
    requests: () => fetcher.mock.calls.length + launch.mock.calls.length,
    /** The requests nothing has ended: those sent without a signal, or whose signal has not aborted. */
    running: () => fetcher.mock.calls.length - signals.filter((signal) => signal.aborted).length,
    /** The User-Agent of each request to a carrier, as fetch sends it: `init` headers replace a `Request`'s. */
    userAgents: () => fetcher.mock.calls
      .filter(([input]) => !(input instanceof Request ? input.url : String(input)).startsWith(BROWSER_SERVICE))
      .map(([input, init]) => (init?.headers !== undefined ? new Headers(init.headers)
        : input instanceof Request ? input.headers : new Headers()).get('user-agent')) };
}

/**
 * One adapter behind a registry, over a transport that refuses every request at
 * once, with the recorder a host gives both the adapter and the dispatch.
 */
function refused(subject: string, browsers: Browsers) {
  const recorder = { ...NOOP_RECORDER, lookup: vi.fn<StepRecorder['lookup']>() };
  vi.mocked(chromium.launch).mockReset().mockRejectedValue(new Error('The conformance test launches no browser'));
  vi.stubGlobal('fetch', refuse);
  return { recorder, registry: new AdapterRegistry({ factories: { [subject]: SUBJECTS[subject]!.factory }, carriers: { [subject]: subject } },
    environment(refuse, browsers, recorder)) };
}

type Operation = 'track' | 'recognize';
type Lookup = (adapter: CarrierAdapter, input: TrackingInput, context: TrackingContext) => Promise<unknown>;
const lookups: Record<Operation, Lookup> = {
  track: async (adapter, input, context) => adapter.track(input, context),
  recognize: async (adapter, input, context) => adapter.recognize!(input.number, context),
};

const settled = (pending: Promise<unknown>) => pending.then(() => 'answered' as const, () => 'failed' as const);
const within = (pending: Promise<unknown>, ms: number) => {
  let timer!: ReturnType<typeof setTimeout>;
  return Promise.race([settled(pending), new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); })])
    .finally(() => clearTimeout(timer));
};

/** Ends a lookup the test is done with and waits for it, so it calls no later harness. */
async function finish(controller: AbortController, pending: Promise<unknown>): Promise<void> {
  controller.abort(new Error('test finished'));
  await within(pending, SETTLE_MS);
}

/**
 * What a lookup is driven with: each distinct corpus number, and for tracking
 * the same number without its credential, since an adapter can take another
 * path for either.
 */
function samples(subject: string, operation: Operation): TrackingInput[] {
  const inputs = SUBJECTS[subject]!.inputs();
  const bare = inputs.map(({ number }) => ({ number: operation === 'recognize' ? (RECOGNIZED[subject] ?? String)(number) : number }));
  return [...new Map((operation === 'track' ? [...inputs, ...bare] : bare).map((input) => [JSON.stringify(input), input])).values()];
}

/** The samples whose lookup reaches the transport. The others answered or failed before any request. */
async function reaching(subject: string, browsers: Browsers, operation: Operation): Promise<TrackingInput[]> {
  const reached: TrackingInput[] = [];
  for (const input of samples(subject, operation)) {
    const { adapter, firstRequest } = harness(subject, browsers);
    const controller = new AbortController();
    const pending = lookups[operation](adapter, input, { signal: controller.signal });
    const outcome = await Promise.race([settled(pending), firstRequest.then(() => 'requested' as const)]);
    await finish(controller, pending);
    if (outcome === 'requested') reached.push(input);
  }
  return reached;
}

afterEach(() => { vi.stubGlobal('fetch', refuse); });
afterAll(() => { vi.unstubAllGlobals(); });

describe.each(Object.entries(ENVIRONMENTS))('%s', (_, browsers) => {
  describe.each(Object.keys(SUBJECTS))('%s honors the lookup context', (subject) => {
    const recognizes = SUBJECTS[subject]!.factory(environment(refuse, browsers)).recognize !== undefined;

    describe.each<Operation>(recognizes ? ['track', 'recognize'] : ['track'])('%s', (operation) => {
      const lookup = lookups[operation];
      // Recognition is plain HTTP by contract, so only tracking can be left without its browser.
      const browserless = operation === 'track' && BROWSER_ONLY[subject]?.every((browser) => !browsers[browser]) === true;
      let found: Promise<TrackingInput[]> | undefined;
      const reached = () => (found ??= reaching(subject, browsers, operation));

      if (browserless) {
        it('fails every corpus number without a request', async () => {
          const inputs = samples(subject, operation).filter(({ number }) => !HTTP_NUMBERS[subject]?.test(number));
          expect(inputs).not.toHaveLength(0);
          for (const sample of inputs) {
            const { adapter, requests } = harness(subject, browsers);
            const controller = new AbortController();
            const pending = lookup(adapter, sample, { signal: controller.signal });
            const outcome = await within(pending, SETTLE_MS);
            await finish(controller, pending);
            expect(outcome, JSON.stringify(sample)).toBe('failed');
            expect(requests(), JSON.stringify(sample)).toBe(0);
          }
        });
      } else {
        it('reaches its transport with a corpus number', async () => {
          expect(await reached()).not.toHaveLength(0);
        });
      }

      it('fails a lookup whose signal is aborted, without a request', async () => {
        for (const sample of browserless ? samples(subject, operation) : await reached()) {
          const { adapter, requests } = harness(subject, browsers);
          const pending = lookup(adapter, sample, { signal: AbortSignal.abort(new Error('caller cancelled')) });
          expect(await within(pending, SETTLE_MS), JSON.stringify(sample)).toBe('failed');
          expect(requests(), JSON.stringify(sample)).toBe(0);
        }
      });

      if (browserless) return;

      it("sends a carrier the host's User-Agent, a browser's or its app's", async () => {
        for (const sample of await reached()) {
          const { adapter, firstRequest, userAgents } = harness(subject, browsers);
          const controller = new AbortController();
          const pending = lookup(adapter, sample, { signal: controller.signal });
          await firstRequest;
          await finish(controller, pending);
          expect(userAgents().filter((sent) => sent !== HOST_USER_AGENT && sent !== APP_USER_AGENT[subject] && !(sent !== null && BROWSER_USER_AGENT.test(sent))),
            JSON.stringify(sample)).toEqual([]);
        }
      });

      it('aborts the requests in flight at once and starts no other', async () => {
        for (const sample of await reached()) {
          const { adapter, firstRequest, requests, running } = harness(subject, browsers);
          const controller = new AbortController();
          const pending = lookup(adapter, sample, { signal: controller.signal });
          await firstRequest;
          const started = requests();
          controller.abort(new Error('caller cancelled'));
          // Read at once: a request left to its own timeout is still running here.
          const left = running();
          expect(await within(pending, SETTLE_MS), JSON.stringify(sample)).toBe('failed');
          expect(left, JSON.stringify(sample)).toBe(0);
          expect(requests(), JSON.stringify(sample)).toBe(started);
        }
      });

      it('ends the lookup and its requests when the budget is spent', async () => {
        const [sample] = await reached();
        if (!sample) return;
        const { adapter, running } = harness(subject, browsers);
        const controller = new AbortController();
        const pending = lookup(adapter, sample, { signal: controller.signal, budgetMs: BUDGET_MS });
        const outcome = await within(pending, BUDGET_SETTLE_MS);
        // Read before the lookup is ended below, which would abort a request the budget left running.
        const left = running();
        await finish(controller, pending);
        expect(outcome).toBe('failed');
        expect(left).toBe(0);
      });

      if (operation !== 'track' || !Object.hasOwn(REGISTRY.factories, subject)) return;

      // The dispatch runs an adapter that does not declare `recordsSteps` in a runner of its own.
      it('reports a dispatched lookup to the recorder at most once', async () => {
        const [sample] = await reached();
        if (!sample) return;
        const { registry, recorder } = refused(subject, browsers);
        const controller = new AbortController();
        // The budget ends the wait of an adapter that retries a refused request.
        const pending = trackCarrier(subject, sample, { registry, recorder, universal: {} as UniversalTracker,
          signal: controller.signal, budgetMs: BUDGET_MS });
        const outcome = await within(pending, BUDGET_SETTLE_MS);
        await finish(controller, pending);
        expect(outcome).toBe('failed');
        expect(recorder.lookup.mock.calls.length).toBeLessThanOrEqual(1);
      });
    });
  });
});

it('drives synthetic numbers only for carriers whose corpus has no public number', () => {
  for (const carrier of Object.keys(UNSAMPLED)) {
    expect((corpus.get(carrier) ?? []).filter((record) => !['negative', 'quarantined'].includes(record.role)), carrier).toHaveLength(0);
  }
});

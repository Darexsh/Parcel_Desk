// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { carrierErrorKind } from '../core/errors/index.js';
import type { LookupRecord, StepRecord, StepRecorder } from '../core/telemetry/index.js';
import { TrawlClient } from '../core/transport/index.js';
import { UniversalTracker, UniversalTrackingError, universalPlan, universalSources, UNIVERSAL_SOURCES } from './universal.js';

const number = 'ZZ12340678900';
const identity = (value = number) => `<div class="tracking-info"><div class="parcel"><table class="parcel-attributes"><tr><td>Tracking number</td><td>${value}</td></tr></table></div></div>`;
const track17 = {
  meta: { code: 200 }, shipments: [{ number, code: 200, shipment: {
    tracking: { providers: [{ events: [{ time_utc: '2026-08-31T18:50:50Z', description: 'Delivered', stage: 'Delivered' }] }] },
  } }],
};
// The postal union's feed keeps ParcelsApp's label: a scan of a network nothing knows would keep only its wall clock.
const parcels = { carriers: ['Universal Postal Union'], states: [{ date: '2026-08-18T03:04:00Z', status: 'Electronic information submitted by shipper', carrier: 0 }] };
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 201 });
/** What the browser seam returns for a provider: one dated scan at the given stage. */
const seen = (source: string, stage: string) => ({ tracking_provider: source, current_stage: stage,
  events: [{ time: '2026-08-31T18:50:50.000Z', description: 'Scanned', stage }] });
const browserResponse = (source: '17TRACK' | 'ParcelsApp', data: unknown, overrides = {}) => new Response(JSON.stringify({
  url: source === '17TRACK' ? `https://t.17track.net/en#nums=${number}` : `https://parcelsapp.com/en/tracking/${number}`,
  html: identity(), statusCode: 200, tier: 3,
  capturedResponses: [{ url: source === '17TRACK' ? 'https://t.17track.net/track/restapi' : 'https://parcelsapp.com/api/v2/parcels',
    body: JSON.stringify(data), status: 200, truncated: false, base64Encoded: false }],
  ...overrides,
}));

describe('universal discovery chain', () => {
  it('prefers 17TRACK only for validated China Post C/L families', () => {
    for (const postal of ['LZ000000005CN', 'CY000000005CN', 'lz 0000 0000 5 cn']) {
      expect(universalSources(false, postal)).toEqual(['17TRACK', 'ParcelsApp', 'Ship24', 'UPU']);
      expect(universalSources(true, postal)).toEqual(['17TRACK', 'ParcelsApp', 'Ship24', 'Postal Ninja', 'UPU']);
    }
    for (const other of ['EB000000005CN', 'RR000000005CN', 'LZ000000005NL', 'LZ000000006CN', '1234/12345678']) {
      expect(universalSources(false, other)[0]).toBe('ParcelsApp');
    }
  });

  it('keeps the persisted provider names and the opt-in position of Postal Ninja', () => {
    expect(UNIVERSAL_SOURCES).toEqual(['ParcelsApp', 'Ship24', '17TRACK', 'Track718', 'UPU']);
    expect(universalSources()).toEqual(['ParcelsApp', 'Ship24', '17TRACK', 'UPU']);
    expect(universalSources(true)).toEqual(['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU']);
    expect(universalSources(false, number)).toEqual(['ParcelsApp', 'Ship24', '17TRACK']);
    expect(universalSources(false, 'EB000000005CN')).toEqual(['ParcelsApp', 'Ship24', '17TRACK', 'UPU']);
    // A carrier's coverage evidence reorders them.
    expect(universalPlan({ carriers: ['usps'], trackingNumber: number }).sources).toEqual(['17TRACK', 'ParcelsApp', 'Ship24']);
  });

  it('starts with ParcelsApp and stops after success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(parcels));
    const browserLookup = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const result = await new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test/v1', fetcher, browserLookup }).fetch(number);
    expect(result.current_stage).toBe('registered');
    expect(result.tracking_provider).toBe('ParcelsApp');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserLookup).not.toHaveBeenCalled();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://parcelsapp.com/api/v2/parcels');
    expect(new URLSearchParams(String(options!.body)).get('carrier')).toBe('Auto-Detect');
  });

  it('ends the chain on the caller\'s signal and spends one budget across providers', async () => {
    const browserLookup = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK'], trawlUrl: '', fetcher, browserLookup });
    await expect(tracker.fetch(number, null, { signal: AbortSignal.abort(new Error('caller cancelled')) })).rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = tracker.fetch(number, null, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserLookup).not.toHaveBeenCalled();
    fetcher.mockClear();
    const spent = await tracker.fetch(number, null, { budgetMs: 80 }).catch((error: unknown) => error);
    expect(spent).toBeInstanceOf(UniversalTrackingError);
    // The first source used the budget: the others are reported as never asked.
    expect((spent as UniversalTrackingError).failures.map(({ source, error }) => [source, carrierErrorKind(error)]))
      .toEqual([['ParcelsApp', 'transport'], ['Ship24', 'budget'], ['17TRACK', 'budget']]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserLookup).not.toHaveBeenCalled();
  });

  it('continues to another provider when prioritized 17TRACK returns no history', async () => {
    const postalNumber = 'LZ000000014CN';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith('https://parcelsapp.com/')
      ? new Response('', { status: 503 })
      : browserResponse('17TRACK', { meta: { code: 200 }, shipments: [{ number: postalNumber, code: 400, shipment: null }] },
        { url: `https://t.17track.net/en#nums=${postalNumber}` }));
    const browserLookup = vi.fn().mockResolvedValue(seen('Ship24', 'delivered'));
    await expect(new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher, browserLookup }).fetch(postalNumber))
      .resolves.toMatchObject({ tracking_provider: 'Ship24', current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['browser.test', 'parcelsapp.com']);
    expect(browserLookup.mock.calls).toEqual([['Ship24', postalNumber]]);
  });

  it('reaches the real UPU factory only after richer lookups fail for an eligible postal number', async () => {
    const postalNumber = 'EB000000014CN';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('globaltracktrace.ptc.post')
      ? Response.json([{ ID: postalNumber, Events: [{ EventCd: 'EMA', EventNm: 'Posting/Collection',
        EventDT: '2026-09-20T10:00:00Z' }] }])
      : new Response('', { status: 404 }));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  fetcher, trawlUrl: '' });
    await expect(tracker.fetch(postalNumber)).resolves.toMatchObject({ tracking_provider: 'UPU', current_stage: 'accepted' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname))
      .toEqual(['parcelsapp.com', 'api.ship24.com', 'globaltracktrace.ptc.post']);
  });

  it('falls through an unrelated ParcelsApp result to 17TRACK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({ error: 'RELOAD' }))
      .mockResolvedValueOnce(browserResponse('ParcelsApp', parcels, { html: identity('OTHER123') }))
      .mockResolvedValueOnce(browserResponse('17TRACK', track17));
    const result = await new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher, browserLookup: vi.fn().mockRejectedValue(new Error('Unavailable')) }).fetch(number);
    expect(result.tracking_provider).toBe('17TRACK');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retains provider failures for Sentry while keeping the lookup summary readable', async () => {
    const originalError = new Error('SECRET upstream cookie');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(originalError);
    const error = await new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher, browserLookup: vi.fn().mockRejectedValue(new Error('Unavailable')) }).fetch(number).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'UniversalTrackingError' });
    expect(String(error)).not.toContain('SECRET');
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toBeInstanceOf(UniversalTrackingError);
    const errors = (error as AggregateError).errors;
    expect(errors).toHaveLength(3);
    // ParcelsApp and 17TRACK went through the fetcher; Ship24 through the browser lookup.
    for (const providerError of [errors[0], errors[2]]) {
      expect(providerError.cause).toBe(originalError);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('tries Postal Ninja only after the other aggregators fail', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unavailable'));
    const browserLookup = vi.fn().mockRejectedValueOnce(new Error('Challenge'))
      .mockResolvedValueOnce(seen('Postal Ninja', 'delivered'));
    const result = await new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher, browserLookup, enablePostalNinja: true }).fetch(number);
    expect(result.tracking_provider).toBe('Postal Ninja');
    expect(browserLookup.mock.calls).toEqual([['Ship24', number], ['Postal Ninja', number]]);
    // ParcelsApp's two requests, then 17TRACK's capture.
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['parcelsapp.com', 'parcelsapp.com', 'browser.test']);
  });

  it('can use the form scrapers without TRAWL and stops on Ship24 success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    const browserLookup = vi.fn().mockResolvedValue(seen('Ship24', 'in_transit'));
    await expect(new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: '', fetcher, browserLookup }).fetch(number)).resolves.toMatchObject({ tracking_provider: 'Ship24' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserLookup).toHaveBeenCalledOnce();
  });

  it('does not request arbitrary user URLs and validates identifiers before network access', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher }).fetch('http://localhost')).rejects.toThrow('Invalid tracking number');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('takes the browser service and the telemetry sink from the adapter environment', async () => {
    const steps: StepRecord[] = [];
    const lookups: LookupRecord[] = [];
    const recorder: StepRecorder = { step: (record) => { steps.push(record); }, lookup: (record) => { lookups.push(record); } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(browserResponse('17TRACK', track17));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  environment: { trawl: new TrawlClient('http://browser.test', fetcher), recorder } });
    await expect(tracker.fetchSource('17TRACK', number, 20_000)).resolves.toMatchObject({ tracking_provider: '17TRACK' });
    expect(steps).toMatchObject([{ carrier: '17TRACK', step: 'trawl', attempt: 1, outcome: 'ok', fallbackFrom: null }]);
    expect(lookups).toMatchObject([{ carrier: '17TRACK', finalStep: 'trawl', outcome: 'ok', attempts: 1 }]);
    // The browser service is given whole milliseconds of the remaining budget.
    const { maxTimeout } = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)) as { maxTimeout: number };
    expect(Number.isInteger(maxTimeout)).toBe(true);
    expect(maxTimeout).toBeGreaterThan(19_000);
    expect(maxTimeout).toBeLessThanOrEqual(20_000);
  });

  it('submits a stored postcode to ParcelsApp without a browser service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(parcels));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: '', fetcher,
      browserLookup: vi.fn().mockRejectedValue(new Error('Ship24 unavailable')) });
    await expect(tracker.fetchSource('ParcelsApp', number, 20_000, '01234')).resolves.toMatchObject({ tracking_provider: 'ParcelsApp' });
    await expect(tracker.fetch(number, '01234')).resolves.toMatchObject({ tracking_provider: 'ParcelsApp' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      expect(new URLSearchParams(String(init!.body)).get('extra[zipcode]')).toBe('01234');
    }
  });

  it('forwards a stored delivery postcode into the provider track input', async () => {
    const ship24History = { data: { tracking_number: number,
      events: [{ timestamp: '2026-09-10T10:00:00+02:00', status: 'Delivered', dispatch_code_id: 7 }] } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith('https://parcelsapp.com/')
      ? new Response('', { status: 503 }) : reply(ship24History));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  fetcher });
    await expect(tracker.fetchSource('Ship24', number, 20_000, '8000')).resolves.toMatchObject({
      current_stage: 'delivered', tracking_provider: 'Ship24',
    });
    await expect(tracker.fetch(number, '8000')).resolves.toMatchObject({
      current_stage: 'delivered', tracking_provider: 'Ship24',
    });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['api.ship24.com', 'parcelsapp.com', 'api.ship24.com']);
  });

  it('asks for the package identifier of a USPS routing barcode, never the ZIP code before it', async () => {
    // Invented package identifiers behind the made-up ZIP code 00314, with or without a ZIP+4: 30, 34 and
    // 38 digits. In the last two, the other reading passes the check digit too, as a channel 92 PIC whose
    // Mailer ID does not start with 9.
    const pic = '9210090000000012345679';
    const pic26 = '92000000000123456789012344';
    const wide = '93009200000000123456789013';
    for (const [typed, expected] of [[`420 00314 ${pic}`, pic], [`420003142718${pic}`, pic], [`42000314${pic26}`, pic26],
      [`420003142718${pic26}`, pic26], [`420003149201${pic}`, pic], [`42000314${wide}`, wide]] as const) {
      const history = { data: { tracking_number: expected,
        events: [{ timestamp: '2026-09-10T10:00:00-04:00', status: 'Delivered', dispatch_code_id: 7 }] } };
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(history));
      const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher });
      await expect(tracker.fetchSource('Ship24', typed, 20_000)).resolves.toMatchObject({ current_stage: 'delivered' });
      await expect(tracker.fetch(typed)).resolves.toMatchObject({ current_stage: 'delivered' });
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(Array(2).fill(`/api/parcels/${expected}`));
      expect(fetcher.mock.calls.map(([url, init]) => `${String(url)} ${String(init?.body)}`).join(' ')).not.toContain('00314');
    }
  });

  it('asks providers for the zero a letter O stands for in an S10 serial, however the caller stored it', async () => {
    const history = { data: { tracking_number: 'CI000000014NL',
      events: [{ timestamp: '2026-09-10T10:00:00+02:00', status: 'Delivered', dispatch_code_id: 7 }] } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(history));
    const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher });
    await expect(tracker.fetchSource('Ship24', 'CIO00000014NL', 20_000)).resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(tracker.fetch('cio 0000001 4nl')).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(Array(2).fill('/api/parcels/CI000000014NL'));
  });

  it('sends no provider a USPS routing barcode without a single package identifier, nor either reading', async () => {
    // The made-up ZIP code 00314. The ZIP+4 9300 and the PIC read as a channel 93 PIC that passes its check
    // digit too, each Mailer ID fitting its channel; the other barcode fails its check digit.
    const pic = '9210090000000012345679';
    const providers = ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'] as const;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const browserLookup = vi.fn().mockRejectedValue(new Error('no lookup expected'));
    for (const options of [{ trawlUrl: 'http://browser.test' }, { browserLookup }]) {
      const tracker = new UniversalTracker({ providers: [...providers], enablePostalNinja: true, fetcher, ...options });
      for (const typed of [`420003149300${pic}`, `42000314${pic.slice(0, -1)}0`]) {
        for (const source of providers) {
          await expect(tracker.fetchSource(source, typed, 20_000))
            .rejects.toMatchObject({ kind: 'indeterminate', provider: source, reason: 'usps_routing_barcode' });
        }
        const chain = await tracker.fetch(typed).catch((error: unknown) => error);
        expect(chain).toBeInstanceOf(UniversalTrackingError);
        expect((chain as UniversalTrackingError).failures.length).toBeGreaterThan(0);
        for (const { error } of (chain as UniversalTrackingError).failures) {
          expect(error).toMatchObject({ kind: 'indeterminate', reason: 'usps_routing_barcode' });
        }
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(browserLookup).not.toHaveBeenCalled();
  });

  it('sends no provider a placeholder number, under which they merge other shipments', async () => {
    const providers = ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'] as const;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const browserLookup = vi.fn().mockRejectedValue(new Error('no lookup expected'));
    for (const options of [{ trawlUrl: 'http://browser.test' }, { browserLookup }]) {
      const tracker = new UniversalTracker({ providers: [...providers], enablePostalNinja: true, fetcher, ...options });
      for (const typed of ['1234567890', '0000000000000', 'rr 0000 0000 5 cn']) {
        for (const source of providers) {
          await expect(tracker.fetchSource(source, typed, 20_000))
            .rejects.toMatchObject({ kind: 'invalid_input', provider: source, reason: 'placeholder_number' });
        }
        await expect(tracker.fetch(typed)).rejects.toBeInstanceOf(UniversalTrackingError);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(browserLookup).not.toHaveBeenCalled();
  });

  it('sends a number of seven characters or fewer only with its carrier, whose shipment a provider would otherwise guess', async () => {
    const providers = ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja'] as const;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const tracker = new UniversalTracker({ providers: [...providers], enablePostalNinja: true, trawlUrl: 'http://browser.test', fetcher });
    for (const typed of ['50417', 'AB12345', '5041 726']) {
      for (const source of providers) {
        for (const carrier of [undefined, null, 'unknown']) {
          await expect(tracker.fetchSource(source, typed, 20_000, null, null, undefined, null, carrier))
            .rejects.toMatchObject({ kind: 'indeterminate', provider: source, reason: 'short_number', name: 'NoHistoryError' });
        }
      }
      await expect(tracker.fetch(typed)).rejects.toBeInstanceOf(UniversalTrackingError);
    }
    expect(fetcher).not.toHaveBeenCalled();
    // With its carrier named, the number is sent.
    await expect(tracker.fetchSource('Ship24', '50417', 20_000, null, null, undefined, null, 'seur')).rejects.not.toMatchObject({ reason: 'short_number' });
    expect(fetcher).toHaveBeenCalled();
  });

  it('treats a history without one dated scan as inconclusive and moves on', async () => {
    // No offset, courier or place: the scan keeps its wall time and has no instant.
    const undated = { data: { tracking_number: number, events: [{ timestamp: '2026-09-10T10:00:00', status: 'Delivered', dispatch_code_id: 7 }] } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith('https://api.ship24.com/')
      ? reply(undated) : browserResponse('17TRACK', track17));
    const tracker = new UniversalTracker({ providers: ['Ship24', '17TRACK'], trawlUrl: 'http://browser.test', fetcher });
    const refused = await tracker.fetchSource('Ship24', number, 20_000).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'indeterminate', provider: 'Ship24', reason: 'undated_history' });
    // With the parcel carrier's zone the same scan has an instant.
    await expect(tracker.fetchSource('Ship24', number, 20_000, null, 'Europe/Zurich'))
      .resolves.toMatchObject({ tracking_provider: 'Ship24', last_update: '2026-09-10T08:00:00.000Z' });
    await expect(tracker.fetch(number)).resolves.toMatchObject({ tracking_provider: '17TRACK' });
    const seam = new UniversalTracker({ providers: ['Postal Ninja'], enablePostalNinja: true, browserLookup: vi.fn().mockResolvedValue({
      tracking_provider: 'Postal Ninja', current_stage: 'delivered', events: [{ local_time: '2026-09-10T10:00:00', description: 'Delivered', stage: 'delivered' }],
    }) });
    await expect(seam.fetchSource('Postal Ninja', number)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'undated_history' });
    // An answer without scans is not an undated history.
    const bare = new UniversalTracker({ providers: ['Ship24'], browserLookup: vi.fn().mockResolvedValue({ tracking_provider: 'Ship24', current_stage: 'pending', events: [] }) });
    await expect(bare.fetchSource('Ship24', number)).resolves.toMatchObject({ tracking_provider: 'Ship24' });
  });
});

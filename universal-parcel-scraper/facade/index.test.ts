import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adapter as chinaPostAdapter } from '../carriers/china-post/adapter.js';
import { CHINA_POST_CHECK_PATH } from '../carriers/china-post/app.js';
import { AdapterRegistry, type AdapterEnvironment, type AdapterFactory, type CarrierAdapter } from '../core/adapter/index.js';
import { InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, UpstreamNetworkError } from '../core/errors/index.js';
import type { CarrierResult } from '../core/result/index.js';
import { resolveResult } from '../core/result/resolve.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { DEFAULT_USER_AGENT } from '../core/transport/userAgent.js';
import type { UniversalSource } from '../providers/types.js';
import { fakeBudgetClock } from '../testing/budgetClock.js';
import { createTracker, TrackingError } from './index.js';

// UPS and Royal Mail stand in for any carrier with an adapter, Ship24 for any provider. Their
// coverage evidence, which leaves Ship24 out for both, is coverage.test.ts's to check.
vi.mock(import('../providers/coverage.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, coverageTiers: (carrier) => carrier === 'ups' || carrier === 'royal-mail' ? null : actual.coverageTiers(carrier) };
});

const number = '1Z999AA10123456784';
const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
function registry(track: CarrierAdapter['track'], recordsSteps = false): AdapterRegistry {
  const factory: AdapterFactory = () => ({ id: 'ups', steps: ['direct'], recordsSteps, track });
  return new AdapterRegistry({ factories: { ups: factory }, carriers: { ups: 'ups' } }, environment);
}

// A number whose shape fits several carriers; these four can be asked whether they know it.
const ambiguous = '06080000000002';
const hung = () => new Promise<never>(() => {});
function recognizers(recognize: Record<string, NonNullable<CarrierAdapter['recognize']>>, track: CarrierAdapter['track'] = hung): AdapterRegistry {
  const carriers = Object.keys(recognize);
  return new AdapterRegistry({
    factories: Object.fromEntries(carriers.map(id => [id, (): CarrierAdapter => ({ id, steps: ['direct'], track, recognize: recognize[id] })])),
    carriers: Object.fromEntries(carriers.map(id => [id, id])),
  }, environment);
}

describe('standalone tracker', () => {
  it('keeps provider fallback after a native recipient-verification gate', async () => {
    const lookup = vi.fn().mockRejectedValue(new InputRequiredError('UPS', 'recipient verification'));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      carriers: ['Universal Postal Union'], states: [{ date: '2026-01-02T12:00:00Z', status: 'Delivered', carrier: 0 }] }));
    const tracker = createTracker({ registry: registry(lookup), fetcher, providers: ['ParcelsApp'] });
    await expect(tracker.track({ number, carrier: 'ups' })).resolves.toMatchObject({ source: 'ParcelsApp',
      attempts: [{ source: 'ups', kind: 'input_required' }, { source: 'ParcelsApp', kind: 'ok' }] });
    expect(lookup).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalled();
  });

  it('detects locally and resolves stages without inventing local-clock instants', async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
      { time: '2026-01-02T12:00:00Z', description: 'Delivered', stage: 'delivered' },
      { local_time: '2026-01-01T12:00:00', description: 'In transit' },
    ] });
    const tracker = createTracker({ registry: registry(lookup), providers: [] });
    expect(tracker.detect(number)).toMatchObject({ carrier: 'ups', confidence: 'high' });
    const answer = await tracker.track({ number });
    expect(answer).toMatchObject({ carrier: 'ups', source: 'ups', result: { current_stage: 'delivered', events: [
      { stage: 'delivered', instant: '2026-01-02T12:00:00Z' }, { instant: null },
    ] }, attempts: [{ source: 'ups', kind: 'ok' }] });
    expect(lookup.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("hands the reader's language to the carrier, and refuses one that is not a tag's length of text", async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'in_transit', events: [{ time: '2026-01-02T12:00:00Z', description: 'In transit' }] });
    const tracker = createTracker({ registry: registry(lookup), providers: [] });
    await tracker.track({ number, language: 'fr-CH' });
    await tracker.track({ number, language: null });
    expect(lookup.mock.calls.map(([input]) => input.language)).toEqual(['fr-CH', undefined]);
    for (const language of [42, 'x'.repeat(36)]) {
      await expect(tracker.track({ number, language: language as string })).rejects.toThrow('Invalid language');
    }
  });

  it("refuses a postcode country that is not a two-letter code", async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'in_transit', events: [{ time: '2026-01-02T12:00:00Z', description: 'In transit' }] });
    const tracker = createTracker({ registry: registry(lookup), providers: [] });
    for (const postcodeCountry of [42, 'ESP', 'E1']) {
      await expect(tracker.track({ number, postcodeCountry: postcodeCountry as string })).rejects.toThrow('Invalid postcode country');
    }
  });

  it('records a single-step lookup once, leaving it to an adapter that records its own steps', async () => {
    const lookups: string[] = [];
    const recorder = { step() {}, lookup: ({ carrier }: { carrier: string }) => { lookups.push(carrier); } };
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
      { time: '2026-01-02T12:00:00Z', description: 'Delivered', stage: 'delivered' },
    ] });
    await createTracker({ registry: registry(lookup), providers: [], recorder }).track({ number });
    expect(lookups).toEqual(['ups']);
    await createTracker({ registry: registry(lookup, true), providers: [], recorder }).track({ number });
    expect(lookups).toEqual(['ups']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('holds back the scans an adapter enters at their planned time until they are due', async () => {
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const lookup = vi.fn().mockResolvedValue({ status: 'in_transit', events: [
      { time: soon, description: 'Departed facility', stage: 'in_transit' },
      { time: '2026-01-02T09:00:00Z', description: 'Arrived at facility', stage: 'in_transit' },
    ] });
    const planned = new AdapterRegistry({ factories: { ups: () => ({ id: 'ups', steps: ['direct'], plannedScans: true, track: lookup }) },
      carriers: { ups: 'ups' } }, environment);
    const answer = await createTracker({ registry: planned, providers: [] }).track({ number });
    expect(answer.result).toMatchObject({ last_status_text: 'Arrived at facility', events: [{ description: 'Arrived at facility' }] });
    expect(answer.result.events).toHaveLength(1);
  });

  it('confirms the direct carrier for a generic postal number before tracking', async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
      { time: new Date().toISOString(), description: 'Delivered', stage: 'delivered' },
    ] });
    const posti = vi.fn().mockResolvedValue({ known: true });
    const chronopost = vi.fn().mockResolvedValue({ known: false });
    const tracker = createTracker({ providers: [], registry: recognizers({ posti, chronopost }, lookup) });
    expect(tracker.detect('RR123456799FI')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    await expect(tracker.track({ number: 'RR123456799FI' })).resolves.toMatchObject({
      carrier: 'posti', source: 'posti', attempts: [{ source: 'posti', kind: 'ok' }],
    });
    expect(posti).toHaveBeenCalledOnce();
    expect(chronopost).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('keeps commercial providers off unless selected', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const lookup = vi.fn().mockRejectedValue(new NotFoundError('UPS'));
    await expect(createTracker({ registry: registry(lookup), fetcher }).track({ number }))
      .rejects.toMatchObject({ hint: { kind: 'not_found' }, attempts: [{ source: 'ups', kind: 'not_found' }] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createTracker({ providers: ['Unknown' as never] })).toThrow(TypeError);
  });

  it('uses an explicitly selected fallback after a failed direct lookup', async () => {
    const lookup = vi.fn().mockRejectedValue(new NotFoundError('UPS'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {
      tracking_number: number, events: [{ timestamp: '2026-01-02T12:00:00Z', status: 'Delivered', dispatch_code_id: 7 }],
    } }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const answer = await createTracker({ registry: registry(lookup), fetcher, providers: ['Ship24'] }).track({ number });
    expect(answer.source).toBe('Ship24');
    expect(answer.attempts.map(attempt => attempt.kind)).toEqual(['not_found','ok']);
    expect(fetcher).toHaveBeenCalled();
  });

  it('keeps provider history after a USPS lookup is redirected to its outage page', async () => {
    const usps = '9400111899223397910421'; // Synthetic PIC.
    const url = `https://tools.usps.com/tracking/${usps}`;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      if (String(input) === 'http://trawl.internal:8191/scrape') return Response.json({
        tier: 2, statusCode: 200, html: '<html><body><script>/* synthetic verification wrapper */</script></body></html>',
        capturedResponses: [{ url, status: 302, trackingNumberSubmitted: usps,
          headers: { location: 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm' } }],
      });
      return Response.json({ data: { tracking_number: usps, events: [
        { timestamp: '2026-01-02T12:00:00Z', status: 'Delivered', dispatch_code_id: 7 },
        { timestamp: '2026-01-01T12:00:00Z', status: 'In transit', dispatch_code_id: 3 },
      ] } }, { status: 201 });
    });
    const answer = await createTracker({ trawlUrl: 'http://trawl.internal:8191', fetcher, providers: ['Ship24'] })
      .track({ number: usps, carrier: 'usps' });
    expect(answer.source).toBe('Ship24');
    expect(answer.result.events).toHaveLength(2);
    expect(answer.attempts.map(attempt => attempt.kind)).toEqual(['indeterminate', 'ok']);
    // Two browser reads, each redirected, then Ship24.
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('detects a USPS routing barcode as typed and gives providers only its package identifier', async () => {
    // Invented package identifiers, the 22-digit one outside the PIC rule, behind the made-up ZIP code 00314,
    // with or without a ZIP+4: 30, 34 and 38 digits.
    const pic = '9205510000000012345670';
    const pic26 = '92000000000123456789012344';
    for (const [typed, expected] of [[`42000314${pic}`, pic], [`420003142718${pic}`, pic], [`42000314${pic26}`, pic26],
      [`420003142718${pic26}`, pic26]] as const) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: {
        tracking_number: expected, events: [{ timestamp: '2026-01-02T12:00:00Z', status: 'Delivered', dispatch_code_id: 7 }],
      } }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
      const answer = await createTracker({ fetcher, providers: ['Ship24'] }).track({ number: typed });
      expect(answer).toMatchObject({ carrier: 'unknown', source: 'Ship24', result: { status: 'delivered' } });
      // Alone, the 22-digit identifier also fits other carriers' formats; as typed, no carrier is asked to recognize it.
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`https://api.ship24.com/api/parcels/${expected}?lang=en`]);
      expect(fetcher.mock.calls.map(([url, init]) => `${String(url)} ${String(init?.body)}`).join(' ')).not.toContain('00314');
    }
  });

  it('leaves a USPS routing barcode without a single package identifier to the USPS adapter', async () => {
    // The made-up ZIP code 00314. The ZIP+4 9300 and the invented PIC read as a channel 93 PIC that passes its
    // check digit too, each Mailer ID fitting its channel, so neither reading is the package identifier.
    const typed = '4200031493009210090000000012345679';
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const tracker = createTracker({ fetcher, providers: ['Ship24', 'ParcelsApp', '17TRACK', 'Postal Ninja', 'UPU'],
      trawlUrl: 'http://browser.test' });
    for (const carrier of [undefined, 'usps']) {
      const failure = await tracker.track({ number: typed, carrier }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TrackingError);
      const { attempts, hint } = failure as TrackingError;
      // USPS's adapter refuses it before a request; every provider step is inconclusive without one.
      expect(attempts.filter(({ source }) => source === 'usps').map(({ kind }) => kind)).toEqual(carrier ? ['invalid_input'] : []);
      const providerKinds = attempts.filter(({ source }) => source !== 'usps').map(({ kind }) => kind);
      expect(providerKinds.length).toBeGreaterThan(0);
      expect(new Set(providerKinds)).toEqual(new Set(['indeterminate']));
      expect(hint.kind).toBe('indeterminate');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts a country hint without retrying an empty universal answer', async () => {
    const lookup = vi.fn().mockRejectedValue(new NotFoundError('UPS'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'NO_DATA' }));
    await expect(createTracker({ registry: registry(lookup), fetcher, providers: ['ParcelsApp'] }).track({ number, countryHint: 'FR' }))
      .rejects.toMatchObject({ attempts: [{ source: 'ups', kind: 'not_found' }, { source: 'ParcelsApp', kind: 'indeterminate' }] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![1]!.body)).not.toContain('manualCountry');
  });

  it('enforces a single deadline even when an adapter ignores cancellation', async () => {
    const lookup = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(createTracker({ registry: registry(lookup), providers: [] }).track({ number }, { budgetMs: 20 }))
      .rejects.toMatchObject({ hint: { kind: 'budget' } });
  });

  it('honors a caller cancellation without starting a new provider', async () => {
    const lookup = vi.fn().mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const fetcher = vi.fn<typeof fetch>();
    const result = createTracker({ registry: registry(lookup), providers: ['Ship24'], fetcher }).track({ number }, { signal: controller.signal });
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes cancellation into legacy HTTP transports through the lookup context', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<never>((_, reject) => {
        init!.signal!.throwIfAborted();
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
      throw new Error('Unreachable');
    });
    const pending = createTracker({ fetcher, providers: [] }).track({ number }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('returns the carriers that answered when others have not by the budget', async () => {
    const waiting = vi.fn<NonNullable<CarrierAdapter['recognize']>>().mockImplementation(hung);
    const tracker = createTracker({ providers: [], registry: recognizers({
      dpd: async () => ({ known: true }), seur: waiting, brt: async () => ({ known: false }),
      ciblex: async () => { throw new SchemaError('Ciblex'); },
    }) });
    const answer = { carrier: 'dpd', choices: [], asked: ['dpd', 'seur', 'brt', 'ciblex'], unanswered: ['seur', 'ciblex'] };
    await expect(tracker.recognize(ambiguous, { budgetMs: 30 })).resolves.toEqual(answer);
    // The budget still cancels what was in flight, before the wait ends.
    expect(waiting.mock.calls[0]![1]!.signal!.reason).toMatchObject({ name: 'TimeoutError' });
    // A caller's signal that stays quiet changes nothing.
    await expect(tracker.recognize(ambiguous, { budgetMs: 30, signal: new AbortController().signal })).resolves.toEqual(answer);
  });

  it('asks the next five carriers only when none of the first five knows the number', async () => {
    // A 14-digit number seven carriers can be asked about, best first.
    const number = '12340678901250';
    const carriers = ['hermes-de', 'dpd', 'dpd-de', 'seur', 'brt', 'ciblex', 'delhivery'];
    const unknown = async () => ({ known: false });
    const knows = async () => ({ known: true });
    let tracker = createTracker({ providers: [], registry: recognizers({
      ...Object.fromEntries(carriers.map(id => [id, unknown])), ciblex: knows,
    }) });
    await expect(tracker.recognize(number)).resolves.toEqual({ carrier: 'ciblex', choices: [], asked: carriers, unanswered: [] });
    const rest = vi.fn<NonNullable<CarrierAdapter['recognize']>>().mockImplementation(knows);
    tracker = createTracker({ providers: [], registry: recognizers({
      ...Object.fromEntries(carriers.map((id, index) => [id, index < 5 ? unknown : rest])), dpd: knows,
    }) });
    await expect(tracker.recognize(number)).resolves.toEqual({ carrier: 'dpd', choices: [], asked: carriers.slice(0, 5), unanswered: [] });
    expect(rest).not.toHaveBeenCalled();
    // A budget the first five spend leaves the rest unasked.
    tracker = createTracker({ providers: [], registry: recognizers({
      ...Object.fromEntries(carriers.map((id, index) => [id, index < 5 ? hung : rest])),
    }) });
    await expect(tracker.recognize(number, { budgetMs: 30 }))
      .resolves.toEqual({ choices: [], asked: carriers.slice(0, 5), unanswered: carriers.slice(0, 5) });
    expect(rest).not.toHaveBeenCalled();
    // So does a round its timer ends while the clock still shows time left.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      await expect(tracker.recognize(number, { budgetMs: 30 }))
        .resolves.toEqual({ choices: [], asked: carriers.slice(0, 5), unanswered: carriers.slice(0, 5) });
    } finally {
      clock.mockRestore();
    }
    expect(rest).not.toHaveBeenCalled();
  });

  it('tracks with the carrier that answered once recognition has waited long enough for the others', async () => {
    // Put the budget signals on the same faked clock as the recognition deadline.
    fakeBudgetClock();
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
      { time: '2026-01-02T12:00:00Z', description: 'Delivered', stage: 'delivered' },
    ] });
    const tracker = createTracker({ providers: [], registry: recognizers({
      dpd: async () => ({ known: true }), seur: hung, brt: async () => ({ known: false }), ciblex: async () => ({ known: false }),
    }, lookup) });
    const pending = tracker.track({ number: ambiguous });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({ carrier: 'dpd', source: 'dpd', attempts: [{ source: 'dpd', kind: 'ok' }] });
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('rejects a recognition the caller cancels, and reports a budget spent on it as a tracking failure', async () => {
    const tracker = createTracker({ providers: [], registry: recognizers({ dpd: hung, seur: hung, brt: hung, ciblex: hung }) });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = tracker.recognize(ambiguous, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    // Whatever else the caller supplied, no source was asked: the budget is the failure.
    for (const input of [{ number: ambiguous }, { number: ambiguous, postcode: '8000' }]) {
      const failure = await tracker.track(input, { budgetMs: 30 }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TrackingError);
      expect(failure).toMatchObject({ attempts: [], hint: { kind: 'budget' } });
    }
    // So does a budget a stalled event loop spends before the first round, while its signal waits for its timer.
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now += 40);
    try {
      await expect(tracker.track({ number: ambiguous }, { budgetMs: 30 })).rejects.toMatchObject({ attempts: [], hint: { kind: 'budget' } });
    } finally {
      clock.mockRestore();
    }
  });

  it('tracks a PostLogistics reference printed with its dash without asking any carrier to recognize it', async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [
      { time: '2026-01-02T12:00:00Z', description: 'Delivered', stage: 'delivered' },
    ] });
    const asked = vi.fn().mockResolvedValue({ known: false });
    const tracker = createTracker({ providers: [], registry: recognizers({
      postlogistics: asked, 'gls-fr': asked, 'gls-de': asked, 'gls-ch': asked, 'dhl-ecommerce-pl': asked,
    }, lookup) });
    await expect(tracker.recognize('12345678-001')).resolves.toMatchObject({ asked: [] });
    await expect(tracker.track({ number: '12345678-001' })).resolves.toMatchObject({
      carrier: 'postlogistics', source: 'postlogistics', attempts: [{ source: 'postlogistics', kind: 'ok' }],
    });
    expect(asked).not.toHaveBeenCalled();
    expect(lookup.mock.calls[0]![0]).toMatchObject({ number: '12345678001' });
    // The compact digits fit other carriers too, and are asked about.
    expect((await tracker.recognize('12345678001')).asked).toContain('postlogistics');
    expect(asked).toHaveBeenCalled();
  });

  it('validates carrier-specific credentials before any lookup', async () => {
    const lookup = vi.fn();
    const tracker = createTracker({ registry: registry(lookup) });
    await expect(tracker.track({ number, trackingUrl: 'https://private.invalid/secret' })).rejects.toBeInstanceOf(TypeError);
    await expect(tracker.track({ number, postcode: 'secret' })).rejects.toBeInstanceOf(TypeError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('asks a named provider alone, without recognition, the carrier or a hand-off', async () => {
    const lookup = vi.fn().mockResolvedValue({ status: 'delivered', events: [{ time: '2026-01-02T12:00:00Z', description: 'Delivered' }] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      carriers: ['Universal Postal Union'], states: [{ date: '2026-01-02T12:00:00Z', status: 'Delivered', carrier: 0 }] }));
    const tracker = createTracker({ registry: registry(lookup), fetcher, providers: ['ParcelsApp', 'UPU'] });
    await expect(tracker.track({ number, source: 'ParcelsApp' })).resolves.toMatchObject({ carrier: 'ups', source: 'ParcelsApp',
      result: { status: 'delivered' }, attempts: [{ source: 'ParcelsApp', kind: 'ok' }] });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0]![0])).hostname).toContain('parcelsapp');
    // A provider that is not enabled is refused before any lookup.
    await expect(tracker.track({ number, source: 'Ship24' })).rejects.toThrow('Unknown or disabled universal provider');
    await expect(tracker.track({ number, source: 'Nope' as UniversalSource })).rejects.toBeInstanceOf(TypeError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('gives a postcode a provider asks for to the providers only, when the carrier reads none', async () => {
    // ParcelsApp relays a postcode gate until its request carries one; UPS's own lookup finds nothing.
    const lookup = vi.fn().mockRejectedValue(new NotFoundError('UPS'));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => Response.json({
      carriers: ['Universal Postal Union'],
      states: new URLSearchParams(String(init!.body)).has('extra[zipcode]')
        ? [{ date: '2026-01-02T12:00:00Z', status: 'Delivered', carrier: 0 }]
        : [{ date: '2026-01-01T00:00:00', status: 'Enter recipient details', require_fields: [{ name: 'zipcode', type: 'text' }] }],
    }));
    const tracker = createTracker({ registry: registry(lookup), fetcher, providers: ['ParcelsApp'] });
    await expect(tracker.track({ number, carrier: 'ups' })).rejects.toMatchObject({ hint: { kind: 'input_required' },
      attempts: [{ source: 'ups', kind: 'not_found' }, { source: 'ParcelsApp', kind: 'input_required' }] });
    await expect(tracker.track({ number, carrier: 'ups', postcode: ' 01234 ' })).resolves.toMatchObject({ source: 'ParcelsApp',
      result: { status: 'delivered' }, attempts: [{ source: 'ups', kind: 'not_found' }, { source: 'ParcelsApp', kind: 'ok' }] });
    expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)).get('extra[zipcode]')).toBe('01234');
    // UPS reads no postcode, so its adapter is not given one.
    expect(lookup.mock.calls.map(([input]) => input.postcode)).toEqual([null, null]);
    // A postcode no provider could take is still refused before any lookup.
    await expect(tracker.track({ number, carrier: 'ups', postcode: 'secret' })).rejects.toBeInstanceOf(TypeError);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports a spent deadline as a budget failure when the source ends on the same budget, and asks no fallback', async () => {
    // What adapters do with the budget they are handed: their own timer, joined with the caller's signal.
    const lookup: CarrierAdapter['track'] = (_input, context) => new Promise((_, reject) => {
      const ended = AbortSignal.any([context!.signal!, AbortSignal.timeout(Math.floor(context!.budgetMs!))]);
      ended.addEventListener('abort', () => reject(new UpstreamNetworkError('UPS', ended.reason)), { once: true });
    });
    const fetcher = vi.fn<typeof fetch>();
    for (const recordsSteps of [false, true]) {
      await expect(createTracker({ registry: registry(lookup, recordsSteps), providers: ['Ship24'], fetcher }).track({ number }, { budgetMs: 60 }))
        .rejects.toMatchObject({ hint: { kind: 'budget' }, attempts: [{ source: 'ups', kind: 'budget' }] });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps an earlier source\'s failure as the hint when a later source only refuses the number\'s format', async () => {
    const composite = '1234/12345678';
    const nacex = (error: Error) => new AdapterRegistry({ factories: { nacex: () => ({ id: 'nacex', steps: ['direct'],
      track: vi.fn().mockRejectedValue(error) }) }, carriers: { nacex: 'nacex' } }, environment);
    const failure = (error: Error) => createTracker({ registry: nacex(error), providers: ['Ship24'], fetcher: vi.fn<typeof fetch>() })
      .track({ number: composite, carrier: 'nacex' }).then(() => null, (reason: TrackingError) => reason);
    expect(await failure(new RateLimitedError('NACEX', 30_000))).toMatchObject({
      hint: { kind: 'rate_limited', retryAfterMs: 30_000 }, attempts: [{ source: 'nacex', kind: 'rate_limited' }, { source: 'Ship24', kind: 'invalid_input' }],
    });
    // A direct adapter that refuses the format itself is still the answer.
    expect(await failure(new InvalidInputError('NACEX'))).toMatchObject({ hint: { kind: 'invalid_input' } });
  });

  it('tells a rejected number and a malformed reply apart from a transport failure', async () => {
    const hintOf = async (error: Error) => createTracker({ registry: registry(vi.fn().mockRejectedValue(error)), providers: [] })
      .track({ number }).then(() => null, (failure: TrackingError) => ({ hint: failure.hint.kind, attempt: failure.attempts[0]?.kind }));
    expect(await hintOf(new InvalidInputError('UPS'))).toEqual({ hint: 'invalid_input', attempt: 'invalid_input' });
    expect(await hintOf(new TypeError('Cannot read properties of undefined'))).toEqual({ hint: 'schema', attempt: 'schema' });
    expect(await hintOf(new Error('socket closed'))).toEqual({ hint: 'transport', attempt: 'transport' });
  });

  it('names the install to carriers with the host User-Agent and rejects an unusable one', async () => {
    const sent = async (userAgent?: string) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 404 }));
      await createTracker({ userAgent, fetcher, providers: [] }).track({ number: '6A00000000000', carrier: 'la-poste' }).catch(() => {});
      return new Headers(fetcher.mock.calls[0]![1]!.headers).get('user-agent');
    };
    expect(await sent('ExampleHost/1.0')).toBe('ExampleHost/1.0');
    expect(await sent()).toBe(DEFAULT_USER_AGENT);
    expect(() => createTracker({ userAgent: 'Example\r\nX-Injected: 1' })).toThrow(TypeError);
  });

  describe('after a partial direct answer', () => {
    type Scan = [time: string, status: string];
    const days = (count: number, hour = '09:00'): Scan[] =>
      Array.from({ length: count }, (_, day) => [`2026-01-0${day + 1}T${hour}:00Z`, 'In transit']);
    /** Two days in transit, then the given scan on the third. */
    const ending = (status: string): Scan[] => [...days(2), ['2026-01-03T09:00:00Z', status]];
    const postal = 'RR123456799GB';
    const chinaPost = 'LZ123456799CN';
    const UPU_LABELS: Record<string, string> = { EMA: 'Posting/collection', EMC: 'Departure from outward office of exchange',
      EMD: 'Arrival at inward office of exchange' };
    /**
     * Synthetic provider replies by host; a provider without scans answers 503. UPU scans are wall clocks and event codes.
     * Ship24 answers for the postal or China Post number when asked for it.
     */
    function providerReplies(scans: { ship24?: Scan[]; parcelsApp?: Scan[]; upu?: Scan[]; couriers?: string[] }) {
      return vi.fn<typeof fetch>().mockImplementation(async (url) => {
        const target = String(url);
        if (target.includes('ship24') && scans.ship24) return new Response(JSON.stringify({ data: {
          tracking_number: [postal, chinaPost].find(known => target.includes(known)) ?? number,
          events: scans.ship24.map(([timestamp, status]) => ({ timestamp, status })),
          ...(scans.couriers ? { couriers: scans.couriers.map(name => ({ translation: { name } })) } : {}) } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } });
        // Scans of the postal union's feed keep ParcelsApp's label; a network nothing knows would keep only its wall clock.
        if (target.includes('parcelsapp') && scans.parcelsApp) return Response.json({ carriers: ['Universal Postal Union'],
          states: scans.parcelsApp.map(([date, status]) => ({ date, status, carrier: 0 })) });
        if (target.includes('globaltracktrace') && scans.upu) return Response.json([{ ID: postal,
          Events: scans.upu.map(([EventDT, EventCd]) => ({ EventDT, EventCd, EventNm: UPU_LABELS[EventCd] })) }]);
        return new Response('', { status: 503 });
      });
    }
    /** Every request waits for its signal. */
    const stalled = () => vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const summary: CarrierResult = { status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In transit',
      last_update: '2026-01-03T09:00:45Z', summary_only: true, events: [] };
    /** A summary at a stage, without a clock unless one is given. */
    const stated = (current_stage: string, last_update: string | null = null): CarrierResult =>
      ({ status: 'in_transit', current_stage, last_status_text: 'Synthetic status', last_update, summary_only: true, events: [] });
    const track = (direct: CarrierResult, fetcher: typeof fetch, providers: UniversalSource[], context = {}) =>
      createTracker({ registry: registry(vi.fn().mockResolvedValue(direct)), fetcher, providers }).track({ number }, context);
    /** Royal Mail's own answer for a postal number, with the default providers unless others are given. */
    const trackPostal = (direct: CarrierResult, fetcher: typeof fetch, providers?: UniversalSource[]) => createTracker({ fetcher,
      ...(providers ? { providers } : {}), registry: new AdapterRegistry({
      factories: { 'royal-mail': () => ({ id: 'royal-mail', steps: ['direct'], track: async () => direct }) },
      carriers: { 'royal-mail': 'royal-mail' } }, environment) }).track({ number: postal, carrier: 'royal-mail' });

    it('prefers a provider\'s fuller history over a summary and keeps the summary beside it', async () => {
      // The provider relays the summary's scan without its seconds.
      const answer = await track(summary, providerReplies({ ship24: days(3) }), ['Ship24']);
      expect(answer).toMatchObject({ carrier: 'ups', source: 'Ship24', result: { current_stage: 'in_transit' },
        direct: { summary_only: true, last_update: summary.last_update, events: [] },
        attempts: [{ source: 'ups', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
      expect(answer.result.events).toHaveLength(3);
      expect(answer.result).not.toHaveProperty('summary_only');
    });

    it('proposes the delivery partner the carrier named, whichever history is chosen', async () => {
      const partner = vi.fn().mockResolvedValue({ status: 'delivered', events: [{ time: '2026-01-04T09:00:00Z', description: 'Delivered', stage: 'delivered' }] });
      const named = { ...summary, delivery_carrier: 'posti', delivery_tracking_number: 'LOCAL12345' };
      const partnered = new AdapterRegistry({ factories: { ups: () => ({ id: 'ups', steps: ['direct'], track: async () => named }),
        posti: () => ({ id: 'posti', steps: ['direct'], track: partner }) }, carriers: { ups: 'ups', posti: 'posti' } }, environment);
      const answer = await createTracker({ registry: partnered, fetcher: providerReplies({ ship24: days(3) }), providers: ['Ship24'] }).track({ number });
      expect(answer).toMatchObject({ source: 'Ship24', direct: { delivery_carrier: 'posti' },
        handoff: { carrier: 'posti', number: 'LOCAL12345', basis: 'partner', confirmed: true } });
      expect(partner.mock.calls[0]![0]).toEqual({ number: 'LOCAL12345' });
    });

    it('sets aside a provider\'s copies of the rows the carrier holds back as written ahead', async () => {
      const ahead = new NoHistoryError('ups', undefined, { reason: 'written_ahead', writtenAhead: ['2026-01-01T17:00:00+08:00', '2026-01-02T17:00:00+08:00'] });
      const tracker = (ship24: Scan[]) => createTracker({ registry: registry(vi.fn().mockRejectedValue(ahead)),
        fetcher: providerReplies({ ship24 }), providers: ['Ship24'] });
      const copies: Scan[] = [['2026-01-02T09:00:00Z', 'In transit'], ['2026-01-01T09:00:00Z', 'In transit']];
      await expect(tracker(copies).track({ number })).rejects.toMatchObject({ hint: { kind: 'indeterminate' },
        attempts: [{ source: 'ups', kind: 'indeterminate' }, { source: 'Ship24', kind: 'indeterminate' }] });
      // A scan of the provider's own stays.
      const answer = await tracker([['2026-01-03T09:00:00Z', 'Delivered'], ...copies]).track({ number });
      expect(answer).toMatchObject({ source: 'Ship24', result: { current_stage: 'delivered' } });
      expect(answer.result.events.map(event => event.instant)).toEqual(['2026-01-03T09:00:00Z']);
    });

    it('looks past a provider that does not improve on the direct answer', async () => {
      const fetcher = providerReplies({ parcelsApp: days(1), ship24: days(3) });
      await expect(track(summary, fetcher, ['ParcelsApp', 'Ship24'])).resolves.toMatchObject({ source: 'Ship24',
        attempts: [{ source: 'ups', kind: 'ok' }, { source: 'ParcelsApp', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
    });

    it('does not take a provider history with no dated scan', async () => {
      // Wall times with no offset, courier or place, and UPS names no zone: no scan has an instant.
      const undated = days(4).map(([time, status]): Scan => [time.replace(/Z$/, ''), status]);
      const answer = await track(summary, providerReplies({ ship24: undated }), ['Ship24']);
      expect(answer).toMatchObject({ source: 'ups', result: { summary_only: true },
        attempts: [{ source: 'ups', kind: 'ok' }, { source: 'Ship24', kind: 'indeterminate' }] });
      expect(answer).not.toHaveProperty('direct');
    });

    it('keeps a truncated direct history over fewer or older provider scans', async () => {
      const newest: CarrierResult = { status: 'in_transit', history_truncated: true, events: days(5, '10:00').slice(2).reverse()
        .map(([time, description]) => ({ time, description, stage: 'in_transit' })) };
      // Two scans, then five whose newest is an hour behind the carrier's.
      for (const ship24 of [days(2, '10:00'), days(5)]) {
        const answer = await track(newest, providerReplies({ ship24 }), ['Ship24']);
        expect(answer).toMatchObject({ source: 'ups', result: { history_truncated: true },
          attempts: [{ source: 'ups', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
        expect(answer.result.events).toHaveLength(3);
        expect(answer).not.toHaveProperty('direct');
      }
    });

    it('counts a scan a provider relays twice in two wordings once', async () => {
      const truncated: CarrierResult = { status: 'in_transit', history_truncated: true, events: [
        { time: '2026-01-03T09:00:00Z', description: 'Arrived at hub', stage: 'in_transit' },
        { time: '2026-01-02T09:00:00Z', description: 'Departed origin', stage: 'in_transit' },
        { time: '2025-12-20T09:00:00Z', description: 'Accepted', stage: 'accepted' }] };
      // Four entries, but only the carrier's two newest scans, each in two wordings.
      const twice: Scan[] = [['2026-01-02T09:00:00Z', 'Departed origin'], ['2026-01-02T09:00:00Z', 'Departed from origin facility'],
        ['2026-01-03T09:00:00Z', 'Arrived at hub'], ['2026-01-03T09:00:00Z', 'Arrived at sorting hub']];
      const answer = await track(truncated, providerReplies({ ship24: twice }), ['Ship24']);
      expect(answer).toMatchObject({ source: 'ups', result: { history_truncated: true },
        attempts: [{ source: 'ups', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
      expect(answer.result.events).toHaveLength(3);
      expect(answer).not.toHaveProperty('direct');
      // With the acceptance and another leg, it holds more scans than the carrier.
      const longer = await track(truncated, providerReplies({ ship24: [['2025-12-20T09:00:00Z', 'Accepted'],
        ['2025-12-28T09:00:00Z', 'In transit'], ...twice] }), ['Ship24']);
      expect(longer).toMatchObject({ source: 'Ship24', direct: { history_truncated: true } });
      expect(longer.result.events).toHaveLength(6);
    });

    it('keeps a direct delivery over newer provider scans that have not reached it', async () => {
      const delivered: CarrierResult = { ...summary, status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
        last_update: '2026-01-02T10:00:00Z' };
      const answer = await track(delivered, providerReplies({ ship24: days(3) }), ['Ship24']);
      expect(answer).toMatchObject({ source: 'ups', result: { current_stage: 'delivered', summary_only: true },
        attempts: [{ source: 'ups', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
      expect(answer).not.toHaveProperty('direct');
    });

    it('replaces a truncated history with one that holds its newest scan', async () => {
      const truncated: CarrierResult = { status: 'in_transit', history_truncated: true, events: [
        { time: '2026-01-03T09:00:45Z', description: 'In transit', stage: 'in_transit' },
        { time: '2026-01-02T09:00:00Z', description: 'In transit', stage: 'in_transit' }] };
      const answer = await track(truncated, providerReplies({ ship24: days(3) }), ['Ship24']);
      expect(answer).toMatchObject({ source: 'Ship24', direct: { history_truncated: true } });
      expect(answer.result.events).toHaveLength(3);
      expect(answer.result).not.toHaveProperty('history_truncated');
    });

    it.each([
      ['delivered', null, 'Shipment exception'],
      ['delivered', null, 'Returned to sender'],
      ['delivered', '2026-01-02T10:00:00Z', 'Shipment exception'],
      ['returned', null, 'Delivered'],
      ['exception', null, 'In transit'],
      ['exception', '2026-01-03T09:00:30Z', 'In transit'],
      // A month is no clock: it cannot prove the history newer.
      ['exception', '2026-01', 'In transit'],
      // Two exceptions can be two problems: the provider's must be no earlier at every reading.
      ['exception', null, 'Shipment exception'],
      ['exception', '2026-01-03T10:00:00', 'Shipment exception'],
      ['in_transit', null, 'Shipment exception'],
      ['ready_for_pickup', null, 'Out for delivery'],
      ['out_for_delivery', '2026-01-02T10:00:00Z', 'In transit'],
    ])('keeps a direct %s stated at %s over a provider history ending in "%s"', async (stage, clock, newest) => {
      const answer = await track(stated(stage, clock), providerReplies({ ship24: ending(newest) }), ['Ship24']);
      expect(answer).toMatchObject({ source: 'ups', result: { current_stage: stage },
        attempts: [{ source: 'ups', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
      expect(answer).not.toHaveProperty('direct');
    });

    it.each([
      ['delivered', null, 'Delivered', 'delivered'],
      ['in_transit', null, 'In transit', 'in_transit'],
      ['in_transit', null, 'Delivered', 'delivered'],
      ['exception', '2026-01-02T10:00:00Z', 'In transit', 'in_transit'],
      ['ready_for_pickup', '2026-01-02T10:00:00Z', 'Out for delivery', 'out_for_delivery'],
      ['in_transit', '2026-01-02T10:00:00Z', 'Shipment exception', 'exception'],
      ['exception', '2026-01-03T09:00:30Z', 'Shipment exception', 'exception'],
    ])('takes a provider history over a direct %s stated at %s when it ends in "%s"', async (stage, clock, newest, current) => {
      const answer = await track(stated(stage, clock), providerReplies({ ship24: ending(newest) }), ['Ship24']);
      expect(answer).toMatchObject({ source: 'Ship24', result: { current_stage: current }, direct: { current_stage: stage } });
    });

    it('takes a history that reached the direct delivery and scanned on, under the carrier\'s status', async () => {
      // The carrier's newest scan, uploaded after its delivery, leaves the parcel delivered.
      const truncated: CarrierResult = { status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
        last_status_text: 'Synthetic delivery', provider_code: 'D1', expected_delivery: '2026-01-05', history_truncated: true, events: [
          { time: '2026-01-04T09:00:00Z', description: 'In transit', stage: 'in_transit' },
          { time: '2026-01-03T09:00:00Z', description: 'Delivered', stage: 'delivered' }] };
      const summarized: CarrierResult = { ...stated('delivered', '2026-01-03T09:00:00Z'), status: 'delivered' };
      const later: Scan = ['2026-01-04T09:00:00Z', 'In transit'];
      for (const direct of [truncated, summarized]) {
        const answer = await track(direct, providerReplies({ ship24: [...ending('Delivered'), later] }), ['Ship24']);
        expect(answer).toMatchObject({ source: 'Ship24', direct: { current_stage: 'delivered' }, result: { status: 'delivered',
          current_stage: 'delivered', last_status_text: direct.last_status_text, last_update: '2026-01-04T09:00:00.000Z', expected_delivery: null } });
        expect(answer.result.current_stage_source).toBe(direct.current_stage_source);
        expect(answer.result.provider_code).toBe(direct.provider_code);
        expect(answer.result.events.map(event => event.stage)).toEqual(['in_transit', 'delivered', 'in_transit', 'in_transit']);
      }
      // Not a history that delivered before the carrier did, never delivered, or shows an exception or a return after the delivery,
      // whether that is its newest scan or not.
      const after: Scan = ['2026-01-05T09:00:00Z', 'In transit'];
      for (const ship24 of [[...days(1), ['2026-01-02T09:00:00Z', 'Delivered'], later], days(4), [...ending('Delivered'), [later[0], 'Shipment exception']],
        [...ending('Delivered'), [later[0], 'Returned to sender']], [...ending('Delivered'), [later[0], 'Shipment exception'], after],
        [...ending('Delivered'), [later[0], 'Returned to sender'], after]] as Scan[][]) {
        const answer = await track(truncated, providerReplies({ ship24 }), ['Ship24']);
        expect(answer, JSON.stringify(ship24)).toMatchObject({ source: 'ups', result: { current_stage: 'delivered', history_truncated: true },
          attempts: [{ source: 'ups', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
      }
    });

    it('keeps the direct answer when the provider attributes the parcel to another carrier', async () => {
      const elsewhere = await track(summary, providerReplies({ ship24: ending('Delivered'), couriers: ['Royal Mail'] }), ['Ship24']);
      expect(elsewhere).toMatchObject({ source: 'ups', result: { current_stage: 'in_transit' } });
      const named = await track(summary, providerReplies({ ship24: ending('Delivered'), couriers: ['UPS'] }), ['Ship24']);
      expect(named).toMatchObject({ source: 'Ship24', result: { current_stage: 'delivered', discovered_carrier: 'ups' } });
    });

    it.each([['La Poste', 'la-poste'], ['Cainiao', 'aliexpress']])(
      'takes the history of a provider naming only %s for a checksum-valid S10 item', async (courier, discovered) => {
        // The S10 number names one postal item for the destination post and the consolidator as for the issuer.
        const answer = await trackPostal(summary, providerReplies({ ship24: days(3), couriers: [courier] }), ['Ship24']);
        expect(answer).toMatchObject({ source: 'Ship24', result: { discovered_carrier: discovered },
          direct: { summary_only: true, last_update: summary.last_update },
          attempts: [{ source: 'royal-mail', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
        expect(answer.result.events).toHaveLength(3);
      });

    it('takes a fuller provider history over China Post\'s guest window, and keeps China Post\'s answer beside it', async () => {
      // China Post's own adapter reads a synthetic trace: the newest three of forty scans, ending in delivery, and the dated acceptance.
      // The fixture's placeholder number becomes one lookups accept.
      const fixture = (name: string) => readFileSync(new URL(`../carriers/china-post/fixtures/${name}.json`, import.meta.url), 'utf8')
        .replaceAll('LZ123456785CN', chinaPost);
      let trace = fixture('delivered');
      const app = vi.fn<typeof fetch>().mockImplementation(async (url) => new Response(
        String(url).endsWith(CHINA_POST_CHECK_PATH) ? fixture('check-open') : trace,
        { headers: { 'Content-Type': 'application/json;charset=UTF-8' } }));
      const chinaPostOnly = new AdapterRegistry({ factories: { 'china-post': chinaPostAdapter }, carriers: { 'china-post': 'china-post' } },
        { ...environment, fetcher: app });
      const trackChinaPost = (fetcher: typeof fetch, providers: UniversalSource[]) => createTracker({ registry: chinaPostOnly, fetcher, providers })
        .track({ number: chinaPost, carrier: 'china-post' });
      const own = (await trackChinaPost(vi.fn<typeof fetch>(), [])).result;
      expect(own).toMatchObject({ current_stage: 'delivered', destination_country: 'US', history_truncated: true });
      expect(own.events).toHaveLength(4);
      // The provider holds the acceptance, the legs China Post's window hides, and the delivery on the same day.
      const history: Scan[] = [['2026-08-14T08:13:38Z', 'Accepted'], ['2026-08-16T02:00:00Z', 'In transit'],
        ['2026-08-20T09:00:00Z', 'In transit'], ['2026-09-01T15:10:00Z', 'In transit'], ['2026-09-01T17:10:00Z', 'Out for delivery'],
        ['2026-09-01T22:25:00Z', 'Delivered']];
      const fuller = await trackChinaPost(providerReplies({ ship24: history }), ['Ship24']);
      expect(fuller).toMatchObject({ carrier: 'china-post', source: 'Ship24', result: { current_stage: 'delivered', destination_country: 'US' },
        attempts: [{ source: 'china-post', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
      expect(fuller.result.events).toHaveLength(6);
      expect(fuller.result).not.toHaveProperty('history_truncated');
      expect(fuller.direct).toEqual(own);
      // A provider history with no more scans than China Post's leaves China Post's answer in place.
      const shorter = await trackChinaPost(providerReplies({ ship24: history.slice(2) }), ['Ship24']);
      expect(shorter).toMatchObject({ carrier: 'china-post', source: 'china-post',
        attempts: [{ source: 'china-post', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
      expect(shorter.result).toEqual(own);
      expect(shorter).not.toHaveProperty('direct');

      // A destination scan uploaded after the delivery leaves China Post's answer delivered.
      const reply = JSON.parse(trace) as { info: { mail: { mailInfos: Record<string, unknown>[] } } };
      const [, outForDelivery, delivery] = reply.info.mail.mailInfos;
      reply.info.mail.mailInfos = [outForDelivery!, delivery!, { ...delivery, operationCode: '459', operation: '到达寄达地处理中心',
        stateDesc: '到达境外目的地', orgCode: 'USJFKA', orgName: '', time: '2026-09-03 14:13:00' }];
      trace = JSON.stringify(reply);
      const late = (await trackChinaPost(vi.fn<typeof fetch>(), [])).result;
      expect(late).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-09-03T14:13:00' });
      // A provider history with the delivery and that scan replaces it under China Post's status; one without the scan is behind.
      const rescanned = await trackChinaPost(providerReplies({ ship24: [...history, ['2026-09-03T19:13:00Z', 'Arrival at inward office of exchange']] }),
        ['Ship24']);
      expect(rescanned).toMatchObject({ source: 'Ship24', direct: late, result: { status: 'delivered', current_stage: 'delivered',
        last_status_text: 'Delivered', destination_country: 'US' } });
      expect(rescanned.result.events).toHaveLength(7);
      expect(rescanned.result.events[0]).toMatchObject({ description: 'Arrival at inward office of exchange', stage: 'in_transit' });
      const behind = await trackChinaPost(providerReplies({ ship24: history }), ['Ship24']);
      expect(behind).toMatchObject({ source: 'china-post', attempts: [{ source: 'china-post', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }] });
      expect(behind.result).toEqual(late);
    });

    it('compares UPU wall clocks with a direct answer by the offsets they could carry', async () => {
      const older: Scan[] = [['2026-01-01T09:00:00', 'EMA'], ['2026-01-03T09:00:00', 'EMC']];
      const fresh: CarrierResult = { ...summary, last_update: '2026-01-20T09:00:00Z' };
      // Even read at UTC-12, UPU's newest wall time is weeks before the carrier's instant.
      const stale = await trackPostal(fresh, providerReplies({ upu: older }));
      expect(stale).toMatchObject({ source: 'royal-mail', result: { last_update: fresh.last_update },
        attempts: [{ source: 'royal-mail', kind: 'ok' }, { source: 'UPU', kind: 'ok' }] });
      // A wall time an hour before it can be the same moment somewhere.
      const reaching = await trackPostal(fresh, providerReplies({ upu: [...older, ['2026-01-20T08:00:00', 'EMD']] }));
      expect(reaching).toMatchObject({ source: 'UPU', direct: { last_update: fresh.last_update } });
      // A truncated history in wall clocks, against an older UPU history and one reaching its newest scan.
      const truncated: CarrierResult = { status: 'in_transit', history_truncated: true, events: [
        { local_time: '2026-01-25T10:00:00', description: 'Arrived at delivery office', stage: 'in_transit' },
        { local_time: '2026-01-24T10:00:00', description: 'In transit', stage: 'in_transit' }] };
      await expect(trackPostal(truncated, providerReplies({ upu: [...older, ['2026-01-14T09:00:00', 'EMD']] })))
        .resolves.toMatchObject({ source: 'royal-mail', result: { history_truncated: true } });
      await expect(trackPostal(truncated, providerReplies({ upu: [...older, ['2026-01-25T10:00:00', 'EMD']] })))
        .resolves.toMatchObject({ source: 'UPU', direct: { history_truncated: true } });
    });

    it('keeps the carrier\'s own facts that the provider\'s history lacks, and the carrier\'s answer untouched', async () => {
      const facts: CarrierResult = { ...summary, expected_delivery: '2026-01-05', canonical_tracking_number: 'SYNTHETIC123',
        destination_country: 'FR', weight_kg: 1.5, pickup_point: 'Synthetic locker', sender_name: 'Synthetic shop',
        service_name: 'Synthetic Express', receiver_name: 'Synthetic recipient', timezone: 'Europe/Paris' };
      const answer = await track(facts, providerReplies({ ship24: days(3) }), ['Ship24']);
      expect(answer).toMatchObject({ source: 'Ship24', result: { expected_delivery: '2026-01-05', canonical_tracking_number: 'SYNTHETIC123',
        destination_country: 'FR', weight_kg: 1.5, pickup_point: 'Synthetic locker', sender_name: 'Synthetic shop',
        service_name: 'Synthetic Express', timezone: 'UTC' } });
      // A recipient's name stays with the carrier's own answer.
      expect(answer.result.receiver_name ?? null).toBeNull();
      expect(answer.direct).toEqual(resolveResult(facts));
      // An estimate does not outlive a delivery the provider saw.
      const delivered = await track(facts, providerReplies({ ship24: ending('Delivered') }), ['Ship24']);
      expect(delivered).toMatchObject({ source: 'Ship24', result: { current_stage: 'delivered', expected_delivery: null, destination_country: 'FR' } });
      expect(delivered.result.pickup_point).toBe('Synthetic locker');
      // Nor a pickup point a delivery to the door that the provider saw.
      const door = await track(facts, providerReplies({ ship24: [...ending('Out for delivery'), ['2026-01-03T15:00:00Z', 'Delivered']] }), ['Ship24']);
      expect(door).toMatchObject({ source: 'Ship24', result: { current_stage: 'delivered', destination_country: 'FR' } });
      expect(door.result.pickup_point ?? null).toBeNull();
    });

    it('keeps time for the partner the carrier named when the providers stall', async () => {
      const partner = vi.fn().mockResolvedValue({ status: 'delivered', events: [{ time: '2026-01-04T09:00:00Z', description: 'Delivered', stage: 'delivered' }] });
      const named = { ...summary, delivery_carrier: 'posti', delivery_tracking_number: 'LOCAL12345' };
      const partnered = new AdapterRegistry({ factories: { ups: () => ({ id: 'ups', steps: ['direct'], track: async () => named }),
        posti: () => ({ id: 'posti', steps: ['direct'], track: partner }) }, carriers: { ups: 'ups', posti: 'posti' } }, environment);
      // The partner's third of the budget stays long enough for a loaded test run to reach it.
      const answer = await createTracker({ registry: partnered, fetcher: stalled(), providers: ['ParcelsApp', 'Ship24'] })
        .track({ number }, { budgetMs: 1_500 });
      expect(answer).toMatchObject({ source: 'ups', handoff: { carrier: 'posti', confirmed: true },
        attempts: [{ source: 'ups', kind: 'ok' }, { source: 'ParcelsApp', kind: 'budget' }, { source: 'posti', kind: 'ok' }] });
      expect(answer.attempts).toHaveLength(3);
    });

    it('returns the direct answer unchanged without enabled providers', async () => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(track(summary, fetcher, [])).resolves.toEqual({ carrier: 'ups', source: 'ups', result: resolveResult(summary),
        attempts: [{ source: 'ups', kind: 'ok', durationMs: expect.any(Number) }] });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('keeps the direct answer when every provider fails', async () => {
      const answer = await track(summary, providerReplies({}), ['ParcelsApp', 'Ship24']);
      expect(answer).toMatchObject({ source: 'ups', result: { summary_only: true } });
      expect(answer.attempts.map(attempt => [attempt.source, attempt.kind === 'ok'])).toEqual([['ups', true], ['ParcelsApp', false], ['Ship24', false]]);
      expect(answer).not.toHaveProperty('direct');
    });

    it('keeps the direct answer when the deadline ends the fall-through, and starts no provider after it', async () => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      }));
      const answer = await track(summary, fetcher, ['ParcelsApp', 'Ship24'], { budgetMs: 100 });
      expect(answer).toMatchObject({ source: 'ups', result: { summary_only: true },
        attempts: [{ source: 'ups', kind: 'ok' }, { source: 'ParcelsApp', kind: 'budget' }] });
      expect(answer.attempts).toHaveLength(2);
      expect(fetcher.mock.calls.every(([url]) => String(url).includes('parcelsapp'))).toBe(true);
    });

    it('rejects with the caller\'s reason when the caller cancels during the fall-through', async () => {
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        controller.abort(reason);
      }));
      await expect(track(summary, fetcher, ['ParcelsApp', 'Ship24'], { signal: controller.signal })).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  it('exposes a safe aggregate error without adapter diagnostics', async () => {
    const lookup = vi.fn().mockRejectedValue(new SchemaError('UPS', 'private payload'));
    try { await createTracker({ registry: registry(lookup), providers: [] }).track({ number }); }
    catch (error) {
      expect(error).toBeInstanceOf(TrackingError);
      expect(JSON.stringify(error)).not.toContain('private payload');
      expect(error).toMatchObject({ hint: { kind: 'schema' } });
      return;
    }
    throw new Error('Expected tracking failure');
  });
});

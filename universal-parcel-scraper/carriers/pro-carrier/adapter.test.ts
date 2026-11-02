import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ProCarrierTracker, proCarrierTrackingUrl } from './adapter.js';
import { normalizeProCarrierNumber, parseProCarrier } from './parser.js';
import { proCarrierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic Pro Carrier numbers.
const DELIVERED = 'DG00000000001';
const TRANSIT = 'UBG000000002';
const UNKNOWN = 'DG00000000000';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const summary = (result: ReturnType<typeof parseProCarrier>) => result.events!.map((event) =>
  [event.local_time, event.description, event.stage ?? null]);
// Cloudflare's managed challenge, which the tracker's network serves to some visitors.
const BLOCK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Pro Carrier HTTP adapter', () => {
  it('asks the tracker\'s page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ProCarrierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ubg 000 000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://tracking.weareprocarrier.com/?tn=${TRANSIT}`);
    expect(proCarrierTrackingUrl(TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pro-carrier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery with its service, weight, destination country and partner, once per scan', () => {
    const result = parseProCarrier(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'parcel delivered in mailbox', last_update: null, last_update_local: '2026-03-12T13:05:00',
      expected_delivery: null, service_name: 'PCPL', weight_kg: 0.42, destination_country: 'FR',
      delivery_carrier: 'colis-prive', delivery_tracking_number: 'ZZ0000000001' });
    expect(summary(result)).toEqual([
      ['2026-03-12T13:05:00', 'parcel delivered in mailbox', 'delivered'],
      ['2026-03-12T08:31:00', 'parcel out for delivery', 'out_for_delivery'],
      // The repeated scan is kept once.
      ['2026-03-12T07:58:00', 'in transit (in country)', 'in_transit'],
      // A message to the recipient moves nothing.
      ['2026-03-12T07:40:00', 'email notification sent to consignee', null],
      ['2026-03-12T03:10:00', 'arrived at delivery depot', 'in_transit'],
      ['2026-03-11T20:15:00', 'arrived in country', 'in_transit'],
      ['2026-03-11T14:02:11', 'parcel is on route to destination country', 'in_transit'],
      ['2026-03-11T09:40:27', 'received in hub', 'in_transit'],
      ['2026-03-11T08:55:40', 'customs cleared', 'in_transit'],
      ['2026-03-10T23:20:05', 'parcel awaiting clearance by customs', 'customs'],
      ['2026-03-10T22:47:00', 'departed from pro carrier hub', 'in_transit'],
      ['2026-03-10T19:31:52', 'parcel added to pallet/group', 'in_transit'],
      ['2026-03-10T13:12:09', 'parcel received', 'in_transit'],
      ['2026-03-09T17:44:30', 'pre-advice received', 'registered'],
    ]);
    // Scan clocks name no zone and stay local.
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    // Comments, the town and the partner link's query are not kept.
    expect(JSON.stringify(result)).not.toMatch(/A Sample|07000|letterbox|distributor|SAMPLEVILLE|numColis|ZZ000000000199999/i);
  });

  it('proposes no Colis Privé lookup, which needs the recipient\'s postcode, and keeps a longer reference out', () => {
    expect(deliveryHandoff('pro-carrier', DELIVERED, parseProCarrier(page('delivered'), DELIVERED))).toBeNull();
    const longer = parseProCarrier(page('delivered').replace('<dd>ZZ0000000001</dd>', '<dd>ZZ000000000199999</dd>'), DELIVERED);
    expect(longer).not.toHaveProperty('delivery_tracking_number');
    expect(longer).not.toHaveProperty('delivery_carrier');
  });

  it('reads a parcel in transit by its newest scan and hands it to InPost under its own number', () => {
    const result = parseProCarrier(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'departed from pro carrier hub', last_update_local: '2026-04-02T21:05:44', service_name: 'PCPD',
      weight_kg: 1.5, destination_country: 'GB', delivery_carrier: 'inpost', delivery_tracking_number: 'JJD0000000000000002' });
    expect(summary(result)).toEqual([
      ['2026-04-02T21:05:44', 'departed from pro carrier hub', 'in_transit'],
      ['2026-04-02T18:12:03', 'parcel sorted for linehaul', 'in_transit'],
      ['2026-04-02T18:12:03', 'parcel added to pallet/group', 'in_transit'],
      ['2026-04-02T11:30:00', 'parcel received', 'in_transit'],
      ['2026-03-31T08:15:19', 'pre-advice received', 'registered'],
    ]);
    // A name the map does not know falls to the shared rules.
    expect(result.events![1]).toMatchObject({ stage_source: 'wording:language' });
    expect(deliveryHandoff('pro-carrier', TRANSIT, result)).toEqual({ carrier: 'inpost', number: 'JJD0000000000000002', basis: 'partner' });
  });

  it('names no partner for its own number, a dash, or two different partner links', () => {
    const own = parseProCarrier(page('in-transit').replace('<dd>JJD0000000000000002</dd>', `<dd>${TRANSIT}</dd>`), TRANSIT);
    expect(own).not.toHaveProperty('delivery_tracking_number');
    expect(own).not.toHaveProperty('delivery_carrier');
    const dash = parseProCarrier(page('in-transit').replace('<dd>JJD0000000000000002</dd>', '<dd>-</dd>'), TRANSIT);
    expect(dash).not.toHaveProperty('delivery_tracking_number');
    const twice = parseProCarrier(page('in-transit').replace('</section>',
      '<a href="https://www.royalmail.com/track-your-item" class="button">See tracking on delivery partner site</a></section>'), TRANSIT);
    expect(twice).toMatchObject({ delivery_tracking_number: 'JJD0000000000000002' });
    expect(twice).not.toHaveProperty('delivery_carrier');
  });

  it('reads the page\'s notice for an unknown number as not found, bound to the number', () => {
    expect(() => parseProCarrier(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseProCarrier(page('not-found'), 'DG00000000009'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pro Carrier answered for another number' }));
    expect(() => parseProCarrier(page('not-found').replace(`Shipment not found (${UNKNOWN})`, 'Service unavailable'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseProCarrier(page('not-found').replace(`<p>Shipment not found (${UNKNOWN})</p>`, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the page to the whole number asked', () => {
    expect(() => parseProCarrier(page('in-transit'), 'UBG000000003'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pro Carrier answered for another number' }));
    expect(parseProCarrier(page('in-transit').replace(`<dd>${TRANSIT}</dd>`, `<dd>${TRANSIT.toLowerCase()}</dd>`), TRANSIT).events)
      .toHaveLength(5);
  });

  it('reads a shipment without scans as no history', () => {
    const empty = page('in-transit').replace(/(<ul\s+class="accordion accordion--shipping"[^>]*>)[\s\S]*?(<\/ul>)/, '$1$2');
    expect(() => parseProCarrier(empty, TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const change of [
      (body: string) => body.replace('<dt>2026-04-02 21:05:44</dt>', '<dt>2026-04-02 21:05</dt>'),
      (body: string) => body.replace('<dt>2026-04-02 21:05:44</dt>', '<dt>2026-02-30 21:05:44</dt>'),
      (body: string) => body.replace('<dt>2026-04-02 21:05:44</dt>', '<dt>02/04/2026 21:05:44</dt>'),
      (body: string) => body.replace('<dd class="sentence-case">parcel received</dd>', '<dd class="sentence-case"></dd>'),
      (body: string) => body.replace('<dt>Tracking Number</dt>', '<dt>Reference</dt>'),
      (body: string) => body.replace('accordion--shipping', 'accordion--list'),
      (body: string) => body.replace(/(accordion--shipping[\s\S]*?<\/ul>)/, '$1<ul class="accordion accordion--shipping"></ul>'),
      (body: string) => body.replace(/<a href="#" class="accordion-title">/, '<a href="#" class="accordion-heading">'),
      (body: string) => body.replace('</section>\n\n  </main>', '</section><section class="shipment-details"></section></main>'),
      (body: string) => body.replace(/(<ul\s+class="accordion accordion--shipping"[^>]*>)/,
        `$1${'<li class="accordion-item"><a href="#" class="accordion-title"><dl class="detail-list"><dt>2026-04-01 10:00:00</dt><dd>parcel received</dd></dl></a></li>'.repeat(301)}`),
      (body: string) => body.replace(/<form[\s\S]*?<\/form>/, ''),
    ]) {
      expect(() => parseProCarrier(change(page('in-transit')), TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(html(body, init))).track({ number: UNKNOWN });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers every number with HTTP 200: a 404 is a moved route and a redirect another page.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://weareprocarrier.com/' } })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(BLOCK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 403, headers: { 'cf-mitigated': 'challenge' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 429, headers: { 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Pro Carrier Tracking</title><body>Home</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the not-found notice, and asks nothing for a number Pro Carrier does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(page('delivered')))
      .mockResolvedValueOnce(html(page('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T13:05:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('JJD0000000000000002')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failure to reach the tracker, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(html(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ProCarrierTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pro-carrier', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers Pro Carrier does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DG0000000001', 'DG000000000011', 'DX00000000001', 'UBG00000001', 'UBG0000000011',
      'JJD0000000000000002', 'ZZ000000000GB', `DG${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeProCarrierNumber(' dg-0000-0000-001 ')).toBe(DELIVERED);
  });

  it('routes a number filed under Pro Carrier, or in a tracker link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === proCarrierTrackingUrl(DELIVERED)
      ? html(page('delivered')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pro-carrier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pro-carrier', source: 'pro-carrier', result: { current_stage: 'delivered' } });
    for (const link of [`https://tracking.weareprocarrier.com/?tn=${DELIVERED}`, `https://tracking.weareprocarrier.com//?tn=${TRANSIT}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ carrier: 'pro-carrier', confidence: 'high' });
    }
  });
});

describe('Pro Carrier numbers', () => {
  it('offers DG and eleven digits beside La Poste, and leaves UBG numbers to their rule', () => {
    for (const number of [DELIVERED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['pro-carrier', 'la-poste']) });
    }
    expect(detectCarrierMatch(TRANSIT).candidates).not.toContain('pro-carrier');
  });
});

describe('Pro Carrier status vocabulary', () => {
  it('records every event name the map knows with the stage it gives, and its messages as gaps', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      if (entry.stage) {
        expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
        expect(proCarrierStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
        expect(statusMapAnswer({ carrier: 'pro-carrier', description: entry.wording }), entry.wording)
          .toEqual({ kind: 'mapped', stage: entry.stage });
      } else {
        expect(proCarrierStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'pro-carrier', description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
      }
    }
    // A capital letter does not change the name.
    expect(proCarrierStage('Parcel departed from retailers facility')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'pro-carrier', description: 'parcel sorted for linehaul' })).toEqual({ kind: 'unknown' });
  });
});

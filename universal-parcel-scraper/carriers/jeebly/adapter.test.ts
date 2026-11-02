import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JEEBLY_TRACKER, JeeblyTracker, jeeblyLookupUrl } from './adapter.js';
import { normalizeJeeblyNumber, parseJeebly, type JeeblyService } from './parser.js';
import { jeeblyMappedStage, jeeblyStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'JB1234568';
const IN_TRANSIT = 'JBP123456';
const UNKNOWN = 'JB0000000';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A fixture as the page answers it for another number or service: the search field and the checked service follow the lookup. */
const page = (name: string, number?: string, service: JeeblyService = 'Scheduled') => {
  const body = text(name).replace(/(name="service_type" value="\w+")\s*checked/, '$1')
    .replace(`name="service_type" value="${service}"`, `name="service_type" value="${service}" checked`);
  return number ? body.replace(/name="awb" value="[^"]*"/, `name="awb" value="${number}"`) : body;
};
/** Answers each lookup with the page the test gives for its service, else the not-found page. */
const byService = (found: Partial<Record<JeeblyService, string>> = {}) => vi.fn<typeof fetch>().mockImplementation(async (input) => {
  const url = new URL(String(input));
  const service = url.searchParams.get('service_type') as JeeblyService;
  const number = url.searchParams.get('awb')!;
  return html(found[service] ? page(found[service], number, service) : page('not-found.html', number, service));
});
const servicesAsked = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetcher.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('service_type'));
// One scan of the history, as the page writes it.
const STEP = /<div class="order-track-step">[\s\S]*?order-track-status-txt">[^<]*<\/span>\s*<\/div>\s*<\/div>/g;
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Jeebly HTTP adapter', () => {
  it('submits the tracking form with the whole number under the scheduled service first, through the supplied transport', async () => {
    const fetcher = byService({ Scheduled: 'delivered.html' });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JeeblyTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jb 123-4568 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${JEEBLY_TRACKER}?uae=uae&service_type=Scheduled&awb=${DELIVERED}`);
    expect(url).toBe(jeeblyLookupUrl(DELIVERED, 'Scheduled'));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jeebly', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history as wall clocks, staged by the status names, without the people or the package card', () => {
    const result = parseJeebly(text('delivered.html'), DELIVERED, 'Scheduled');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Consignment is delivered', last_update: null, last_update_local: '2026-05-14T16:42:00', expected_delivery: null,
      service_name: 'next day' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['2026-05-14T16:42:00', 'Delivered', 'delivered', 'Consignment is delivered'],
      ['2026-05-14T09:05:00', 'Out For Delivery', 'out_for_delivery', 'Consignment is out for delivery'],
      ['2026-05-13T21:30:00', 'Reached At Hub', 'in_transit', 'Consignment has been reached at the delivery hub and is marked for delivery'],
      // An edit of the order and a new delivery date move nothing.
      ['2026-05-13T18:10:00', 'Order Updated', null, 'Consignment Softdata Updated'],
      ['2026-05-13T18:10:00', 'Rescheduled', null, 'Shipment rescheduled to date 14-05-2026'],
      // A phone number in a line is dropped.
      ['2026-05-13T15:20:00', 'Undelivered', 'failed_attempt', 'Delivery attempt of the consignment has failed, call'],
      ['2026-05-13T08:45:00', 'Out For Delivery', 'out_for_delivery', 'Consignment is out for delivery'],
      ['2026-05-12T22:00:00', 'Inscan At Hub', 'in_transit', 'Consignment has been inscanned at hub'],
      // The repeated pickup is kept once.
      ['2026-05-12T19:33:00', 'Pickup Completed', 'accepted', 'Consignment has been picked up'],
      ['2026-05-11T10:15:00', 'Pickup Scheduled', 'registered', 'Consignment pickup_scheduled'],
      ['2026-05-11T10:15:00', 'Pickup Scheduled', 'registered', 'Consignment Softdata Uploaded'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined && event.stage_source !== 'none')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Merchant|Jane Example|Example Street|Villa|Sampleville|Prepaid|NON-DOCUMENT|FORWARD|\+971|000 000/);
  });

  it('reads an in-transit history of a JBP number, its newest scan first', () => {
    const result = parseJeebly(text('in-transit.html'), IN_TRANSIT, 'Scheduled');
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Consignment is out for delivery',
      last_update_local: '2026-03-01T07:40:00', service_name: 'next day' });
    expect(result.events!.map((event) => [event.local_time, event.stage])).toEqual([
      ['2026-03-01T07:40:00', 'out_for_delivery'], ['2026-02-28T20:12:00', 'in_transit'],
      ['2026-02-28T17:05:00', 'accepted'], ['2026-02-27T11:00:00', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Example Store|John Sample|COD|Example Tower/);
    // An oldest-first page is turned round.
    const steps = text('in-transit.html').match(STEP)!;
    expect(steps).toHaveLength(4);
    const reversed = text('in-transit.html').replace(steps.join(''), [...steps].reverse().join(''));
    expect(parseJeebly(reversed, IN_TRANSIT, 'Scheduled').events!.map((event) => event.local_time)).toEqual(result.events!.map((event) => event.local_time));
  });

  it('asks the express and Moveo services in turn, and reads a number none of them has as not found', async () => {
    const fetcher = byService();
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(servicesAsked(fetcher)).toEqual(['Scheduled', 'Express', 'Moveo']);
    expect(() => parseJeebly(text('not-found.html'), UNKNOWN, 'Scheduled')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('stops at the service that has the shipment', async () => {
    const fetcher = byService({ Express: 'delivered.html' });
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(servicesAsked(fetcher)).toEqual(['Scheduled', 'Express']);
  });

  it('keeps only a reply for the whole number and the service asked', async () => {
    expect(() => parseJeebly(text('delivered.html'), 'JB1234560', 'Scheduled'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jeebly answered another lookup' }));
    expect(() => parseJeebly(page('delivered.html', DELIVERED, 'Express'), DELIVERED, 'Scheduled'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jeebly answered another lookup' }));
    expect(() => parseJeebly(text('delivered.html').replace(`Reference No. ${DELIVERED}`, 'Reference No. JB1234560'), DELIVERED, 'Scheduled'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jeebly answered for another shipment' }));
    expect(() => parseJeebly(text('delivered.html').replace(`Reference No. ${DELIVERED}`, `Reference No. ${DELIVERED}0`), DELIVERED, 'Scheduled'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A reply for another number is not a missing shipment, and no other service is asked.
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(text('not-found.html')));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      // The form without a result, as the page answers a service it does not offer.
      delivered.replace(/<section class="order_tracking_page[\s\S]*?<\/section>/, ''),
      delivered.replace('class="order-track"', 'class="order-list"'),
      delivered.replace(`Reference No. ${DELIVERED}`, `AWB ${DELIVERED}`),
      delivered.replace('<p class="order-track-text-sub">14-May-26</p>', '<p class="order-track-text-sub">2026-05-14</p>'),
      delivered.replace('<p class="order-track-text-sub">14-May-26</p>', '<p class="order-track-text-sub">31-Apr-26</p>'),
      delivered.replace('<span class="order-track-text-time">16:42 </span>', '<span class="order-track-text-time">24:42 </span>'),
      delivered.replace('<span class="order-track-text-time">16:42 </span>', ''),
      delivered.replace('<p class="order-track-text-stat">Delivered</p>', '<p class="order-track-text-stat"></p>')
        .replace('<span class="order-track-status-txt"> Consignment is delivered</span>', '<span class="order-track-status-txt"> </span>'),
      delivered.replace('<div class="order-track-step">', '<div class="order-track-step"><p class="order-track-text-sub">x</p>'.repeat(501)),
    ].entries()) {
      expect(() => parseJeebly(body, DELIVERED, 'Scheduled'), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a shipment the page lists without scans', () => {
    const empty = text('delivered.html').replace(STEP, '');
    expect(() => parseJeebly(empty, DELIVERED, 'Scheduled')).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a browser check, a refusal, a sign-in, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: DELIVERED });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    // Jeebly's signed-in pages answer HTTP 200 with an empty body and a refresh to the sign-in page.
    await expect(lookup(() => html('', { headers: { Refresh: '0;url=https://myjeebly.jeebly.com/login' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://myjeebly.jeebly.com/login' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 301, headers: { Location: 'https://jeebly.com/' } }))).rejects.toMatchObject({ kind: 'transport', status: 301 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s without asking another service', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses what Jeebly does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JB12345', 'JB12345678', 'JBP1234567', 'JBP12345', 'XB1234567', '1234567', 'JB123456A', 'JB1234567,JB0000000', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJeeblyNumber(' jb-123 4568 ')).toBe(DELIVERED);
    expect(normalizeJeeblyNumber('jb123456')).toBe('JB123456');
    expect(normalizeJeeblyNumber('jbp123456')).toBe(IN_TRANSIT);
  });

  it('retries a read that fails to reach the site without asking again a service that answered', async () => {
    let failed = false;
    const answers = byService();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (!failed && new URL(String(input)).searchParams.get('service_type') === 'Express') {
        failed = true;
        throw new TypeError('fetch failed');
      }
      return answers(input, init);
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new JeeblyTracker({ fetcher, recorder }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(servicesAsked(fetcher)).toEqual(['Scheduled', 'Express', 'Express', 'Moveo']);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'not_found' }));
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
    expect(new UpstreamNetworkError('Jeebly', new Error('x'))).toMatchObject({ kind: 'transport' });
  });

  it('recognizes a shipment one service has, and not a number none has', async () => {
    await expect(carrier(byService({ Moveo: 'in-transit.html' })).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-01T07:40:00' });
    await expect(carrier(byService()).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('JB12345')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => html(CLOUDFLARE))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('routes a number filed under Jeebly to the adapter', async () => {
    const fetcher = byService({ Scheduled: 'delivered.html' });
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'jeebly' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jeebly', source: 'jeebly', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === jeeblyLookupUrl(DELIVERED, 'Scheduled'))).toBe(true);
  });
});

describe('Jeebly status vocabulary', () => {
  type Entry = { code: string; wording?: string; stage?: string };

  it('records every status name with the stage the map gives, or none on purpose', () => {
    for (const entry of statuses.entries as Entry[]) {
      const description = entry.wording ?? entry.code;
      const answer = statusMapAnswer({ carrier: 'jeebly', providerCode: entry.code, description });
      if (entry.stage) {
        expect(answer, entry.code).toEqual({ kind: 'mapped', stage: entry.stage });
        expect(jeeblyStage(entry.code, description), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      } else {
        expect(answer, entry.code).toMatchObject({ kind: 'intentional_gap' });
        expect(jeeblyStage(entry.code, description), entry.code).toBeNull();
      }
    }
  });

  it('leaves another status name to the shared rules', () => {
    expect(jeeblyMappedStage('Sample Status')).toBeUndefined();
    expect(jeeblyStage('Sample Status', 'Consignment is delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(jeeblyStage('Sample Status', 'Sample line')).toBeNull();
    expect(statusMap.stage('OUT FOR  DELIVERY', 'consignment is out for delivery')).toBe('out_for_delivery');
    expect(statusMapAnswer({ carrier: 'jeebly', providerCode: 'Sample Status', description: 'Sample line' })).toEqual({ kind: 'unknown' });
  });
});

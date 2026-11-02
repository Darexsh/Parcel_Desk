import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DOMAIN_LOGISTICS_API, DomainLogisticsTracker, domainLogisticsTrackUrl } from './adapter.js';
import { normalizeDomainLogisticsNumber, parseDomainLogistics } from './parser.js';
import { domainLogisticsMappedStage, domainLogisticsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const ORDER = '123406789013';
const UNKNOWN = '000000000000';

type Row = Record<string, unknown>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Row[];
const changed = (name: string, change: (rows: Row[]) => void) => {
  const rows = fixture(name);
  change(rows);
  return rows;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Domain Logistics HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DomainLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 0678-9013 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    // The reply never repeats the number: the path carries it whole, and a redirect is not followed.
    expect(String(url)).toBe(`${DOMAIN_LOGISTICS_API}${ORDER}`);
    expect(domainLogisticsTrackUrl(ORDER)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'domain-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered order on Ontario wall clocks, newest first, without the page’s notes or a passed estimate', () => {
    expect(parseDomainLogistics(fixture('delivered'))).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your order has been delivered!',
      last_update: null, last_update_local: '2026-03-12T20:22:00',
      expected_delivery: null,
      service_name: 'Express Delivery',
      events: [
        { local_time: '2026-03-12T20:22:00', description: 'Your order has been delivered!', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-12T16:10:00', description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-11T14:40:00', description: 'Your order has been shipped!', stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(parseDomainLogistics(fixture('delivered')))).not.toMatch(/Synthetic advice/);
  });

  it('reads a shipped order with the day of its estimated window, and an order out for delivery with its arrival day', () => {
    expect(parseDomainLogistics(fixture('in-transit'))).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Your order has been shipped!',
      last_update: null, last_update_local: '2026-03-11T14:40:00',
      expected_delivery: '2026-03-13',
      service_name: 'Express Delivery',
      events: [{ local_time: '2026-03-11T14:40:00', description: 'Your order has been shipped!', stage: 'in_transit', stage_source: 'carrier_map' }],
    });
    const out = parseDomainLogistics(fixture('delivered').slice(1));
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', expected_delivery: '2026-03-12' });
    // An estimate that is not a day, or whose day passed before the newest status, is no estimate.
    for (const Estimated of ['', null, 'Pending', '2026-02-30', '2026-03-10<br/>05:00 PM – 10:30 PM']) {
      expect(parseDomainLogistics(changed('in-transit', (rows) => { rows[0]!.Estimated = Estimated; })).expected_delivery, String(Estimated)).toBeNull();
    }
    expect(parseDomainLogistics(changed('in-transit', (rows) => { rows[0]!.Service = ''; }))).not.toHaveProperty('service_name');
  });

  it('reads twelve o’clock both ways, lists rows by their clocks and counts a repeated row once', () => {
    const at = (Date: string) => parseDomainLogistics(changed('in-transit', (rows) => { rows[0]!.Date = Date; })).last_update_local;
    expect(at('2026-03-11<br/>12:05 AM')).toBe('2026-03-11T00:05:00');
    expect(at('2026-03-11<br/>12:05 PM')).toBe('2026-03-11T12:05:00');
    expect(at('2026-03-11<br>9:05 pm')).toBe('2026-03-11T21:05:00');
    const shuffled = parseDomainLogistics(changed('delivered', (rows) => { rows.reverse(); rows.push({ ...rows[0]! }); }));
    expect(shuffled.events!.map((event) => event.description)).toEqual(['Your order has been delivered!', 'Out for Delivery', 'Your order has been shipped!']);
    expect(shuffled.current_stage).toBe('delivered');
  });

  it('keeps rows of one minute in the order of a reply listed oldest first', () => {
    const result = parseDomainLogistics(changed('delivered', (rows) => {
      rows.reverse();
      rows.splice(2, 0, { ...rows[1]!, Status: 'Arrived at the delivery depot' });
    }));
    expect(result.events!.map((event) => event.description)).toEqual(['Your order has been delivered!', 'Arrived at the delivery depot',
      'Out for Delivery', 'Your order has been shipped!']);
  });

  it('stages another wording by the shared rules, keeps an unread one without a stage, and strips markup', () => {
    const newest = (Status: unknown) => parseDomainLogistics(changed('in-transit', (rows) => {
      rows.unshift({ ...rows[0]!, Status, Date: '2026-03-13<br/>06:00 PM', Estimated: '2026-03-14' });
    }));
    expect(newest('Delivery attempted')).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(newest('Returned to sender')).toMatchObject({ current_stage: 'returned', expected_delivery: null });
    const unread = newest('Synthetic step');
    expect(unread.events![0]).toEqual({ local_time: '2026-03-13T18:00:00', description: 'Synthetic step' });
    expect(unread).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Synthetic step', expected_delivery: '2026-03-14' });
    expect(newest('<b>Out for Delivery</b>').events![0]).toMatchObject({ description: 'Out for Delivery', stage: 'out_for_delivery' });
    const alone = parseDomainLogistics([{ ...fixture('in-transit')[0], Status: 'Synthetic step' }]);
    expect(alone).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic step' });
    expect(alone).not.toHaveProperty('current_stage');
  });

  it('reads an order without a status yet as no history', () => {
    for (const payload of [[], null]) {
      expect(() => parseDomainLogistics(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (rows: Row[]) => { rows[0] = 'row' as never; },
      (rows: Row[]) => { delete rows[0]!.Status; },
      (rows: Row[]) => { rows[0]!.Status = '<br/>'; },
      (rows: Row[]) => { rows[0]!.Status = ['Out for Delivery']; },
      (rows: Row[]) => { rows[0]!.Service = { name: 'Express Delivery' }; },
      (rows: Row[]) => { rows[0]!.Note = 5; },
      (rows: Row[]) => { rows[0]!.Estimated = 20260313; },
      (rows: Row[]) => { delete rows[0]!.Date; },
      (rows: Row[]) => { rows[0]!.Date = '2026-03-11'; },
      (rows: Row[]) => { rows[0]!.Date = '2026-03-11T14:40:00'; },
      (rows: Row[]) => { rows[0]!.Date = '2026-03-11<br/>14:40'; },
      (rows: Row[]) => { rows[0]!.Date = '2026-03-11<br/>13:40 PM'; },
      (rows: Row[]) => { rows[0]!.Date = '2026-03-11<br/>00:40 AM'; },
      (rows: Row[]) => { rows[0]!.Date = '2026-03-11<br/>02:60 PM'; },
      (rows: Row[]) => { rows[0]!.Date = '2026-02-30<br/>02:40 PM'; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 100 }, () => rows[0]!)); },
    ]) {
      expect(() => parseDomainLogistics(changed('in-transit', change))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of ['reply', { Data: fixture('in-transit') }, fixture('service-error'), 5]) {
      expect(() => parseDomainLogistics(payload), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown order, a failing service, a moved route, a browser check, a quota and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup('', { status: 400 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ Message: 'The request is invalid.' }, { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(CLOUDFLARE, { status: 400, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup([])).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(lookup(fixture('service-error'), { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('', { status: 503 })).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup({ Message: 'No HTTP resource was found that matches the request URI.' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://domainlogistics.ca/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '120' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    await expect(lookup('', { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('<html><title>Domain Logistics — Tracking</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fixture('in-transit'), { status: 202 })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('rejects numbers Domain does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345', 'ABCDEFGHI', '12345678901/', '../123456789', '0'.repeat(41), '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: ORDER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDomainLogisticsNumber('1234 0678 9013')).toBe(ORDER);
    expect(normalizeDomainLogisticsNumber('abc123def')).toBe('ABC123DEF');
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('delivered')) }]);
    const answered = carrier(recovered.fetcher).track({ number: ORDER }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: ORDER }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
    // An HTTP answer is never asked again.
    const failing = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('service-error'), { status: 500 }));
    await expect(carrier(failing).track({ number: ORDER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Domain Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input) === domainLogisticsTrackUrl(ORDER)
      ? reply(fixture('in-transit')) : reply('', { status: 400 }));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: ORDER, carrier: 'domain-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'domain-logistics', source: 'domain-logistics', result: { current_stage: 'in_transit' } });
  });
});

describe('Domain Logistics numbers', () => {
  it('leaves twelve bare digits to no rule of Domain’s', () => {
    expect(detectCarrierMatch(ORDER).candidates).not.toContain('domain-logistics');
  });
});

describe('Domain Logistics status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    const staged = (statuses.entries as { wording: string; stage?: string }[]).filter((entry) => entry.stage);
    expect(staged).toHaveLength(6);
    for (const entry of staged) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(domainLogisticsStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'domain-logistics', description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('maps a wording whatever its case and spacing, and leaves other wordings to the shared rules', () => {
    expect(domainLogisticsMappedStage('OUT FOR  delivery')).toBe('out_for_delivery');
    expect(domainLogisticsMappedStage('Synthetic step')).toBeUndefined();
    expect(domainLogisticsMappedStage('constructor')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'domain-logistics', description: 'Synthetic step' })).toEqual({ kind: 'unknown' });
    expect(domainLogisticsStage('Synthetic step')).toBeNull();
  });
});

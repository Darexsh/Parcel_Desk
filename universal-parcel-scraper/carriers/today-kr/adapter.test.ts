import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TODAY_PAGE, TODAY_PASSPHRASE, todayOpen, TodayTracker } from './adapter.js';
import { normalizeTodayNumber, parseToday, todayPage, type TodayPageType } from './parser.js';
import { statusMap, todayStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '100000000017';
const IN_DELIVERY = '100000000025';
const SHOWN = '998000000033';
const RETURNING = '100000000033';
const UNKNOWN = '100000000009';

type Row = Record<string, unknown>;
type Data = Row & {
  sanitizedLoad: Row; sanitizedOrder: Row; progress: Row;
  steps: Row & { logs: (Row & { station: Row })[]; source: Row; destination: Row };
};
type Fixture = { type: TodayPageType; data: Data };
type Page = { type: TodayPageType; data: unknown };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture;
const changed = (name: string, change: (data: Data) => void) => {
  const reply = fixture(name);
  change(reply.data);
  return reply;
};
const parse = ({ type, data }: Page, number: string) => parseToday(type, data, number);

/** `CryptoJS.AES.encrypt(text, passphrase)` with a fixed salt, as the page's server seals its answer. */
function seal(text: string, passphrase = TODAY_PASSPHRASE): string {
  const salt = Buffer.alloc(8, 7);
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (blocks.length < 3) {
    previous = createHash('md5').update(Buffer.concat([previous, Buffer.from(passphrase), salt])).digest();
    blocks.push(previous);
  }
  const material = Buffer.concat(blocks);
  const cipher = createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}
/** The tracking page as the server renders it, its lookup sealed in the Next.js data. */
const html = ({ type, data }: Page, sealed = seal(JSON.stringify(data))) => '<!DOCTYPE html><html><head><title>배송조회 - Today</title></head>'
  + '<body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">'
  + JSON.stringify({ props: { pageProps: { type, [type === 'ERROR' ? 'error' : 'result']: sealed, _sentryTraceData: 'synthetic' }, __N_SSP: true },
    page: '/track/[invoiceNumber]', query: { invoiceNumber: 'synthetic' }, buildId: 'synthetic-build', isFallback: false, gssp: true })
  + '</script></body></html>';
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseToday>) => result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage]);

describe('To-Day HTTP adapter', () => {
  it('asks the tracking page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(html(fixture('delivered'))));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TodayTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000-0000-0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TODAY_PAGE}${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'today-kr', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('opens the page’s sealed lookup with the passphrase its script uses', () => {
    const page = todayPage(html(fixture('delivered')));
    expect(page).toMatchObject({ type: 'NORMAL' });
    expect(todayOpen(page!.sealed)).toEqual(fixture('delivered').data);
    expect(() => todayOpen(seal('{}', 'another passphrase'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => todayOpen(Buffer.from('not sealed at all, just text').toString('base64'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => todayOpen(seal('not json'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(todayPage('<html><title>Today</title></html>')).toBeNull();
  });

  it('reads a delivered history as the page draws it, without the people, places or products', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송완료', last_update: '2026-05-12T14:02:09+09:00', delivered_at: '2026-05-12T14:02:09+09:00' });
    expect(rows(result)).toEqual([
      ['2026-05-12T14:02:09+09:00', '배송완료', null, 'delivered'],
      // The departure from the last station is the rail's start of delivery.
      ['2026-05-12T13:20:45+09:00', '배송중', '마바', 'out_for_delivery'],
      ['2026-05-12T12:05:00+09:00', '도착', '마바', 'in_transit'],
      ['2026-05-12T11:30:00+09:00', '출발', '다라허브-1', 'in_transit'],
      ['2026-05-12T11:02:00+09:00', '도착', '다라허브-1', 'in_transit'],
      // The rail's first departure is this row.
      ['2026-05-12T10:15:30+09:00', '출발', '가나', 'in_transit'],
      ['2026-05-12T09:40:00+09:00', '도착', '가나', 'in_transit'],
      // A pickup at the sender's address keeps no place.
      ['2026-05-12T09:05:11+09:00', '픽업', null, 'accepted'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('provider_code');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(JSON.stringify(result)).not.toMatch(/Sample|샘|000-0000|37\.|127\.|SAMPLE-ORDER|payload|0000-4000/);
  });

  it('dates the rail’s first departure, and the first station a parcel picked up elsewhere reached, which the page lists no row for', () => {
    // A route from a station heads the pickup with it and lists the stations after it.
    const fromStation = (data: Data) => { data.steps.shippingType = 'STATION_TO_LM'; data.steps.source.title = '가나'; };
    const result = parse(changed('delivered', fromStation), DELIVERED);
    expect(rows(result).slice(-5)).toEqual([
      ['2026-05-12T11:30:00+09:00', '출발', '다라허브-1', 'in_transit'],
      ['2026-05-12T11:02:00+09:00', '도착', '다라허브-1', 'in_transit'],
      ['2026-05-12T10:15:30+09:00', '배송시작', null, 'in_transit'],
      ['2026-05-12T09:40:00+09:00', '도착', '가나', 'in_transit'],
      ['2026-05-12T09:05:11+09:00', '픽업', null, 'accepted'],
    ]);
    // A parcel picked up at the station itself is picked up there.
    const atStation = parse(changed('delivered', (data) => {
      fromStation(data);
      data.steps.logs[0]!.arrivalTime = data.steps.source.time;
    }), DELIVERED);
    expect(rows(atStation).slice(-2)).toEqual([
      ['2026-05-12T10:15:30+09:00', '배송시작', null, 'in_transit'],
      ['2026-05-12T09:05:11+09:00', '픽업', '가나', 'accepted'],
    ]);
  });

  it('reads a parcel out for delivery by the number the page shows, without the shipper’s pickup point', () => {
    const result = parse(fixture('in-delivery'), SHOWN);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: '배송중',
      last_update: '2026-05-20T18:49:13+09:00', delivered_at: null });
    expect(rows(result)).toEqual([
      ['2026-05-20T18:49:13+09:00', '배송중', '가나', 'out_for_delivery'],
      ['2026-05-20T17:42:38+09:00', '도착', '가나', 'in_transit'],
      ['2026-05-20T17:42:38+09:00', '픽업', null, 'accepted'],
    ]);
    // To-Day's own waybill finds the same parcel.
    expect(parse(fixture('in-delivery'), IN_DELIVERY).events).toEqual(result.events);
    expect(JSON.stringify(result)).not.toMatch(/Sample|샘|37\.|127\./);
  });

  it('reads a return between its two ends, without the shipper’s return point', () => {
    const result = parse(fixture('returning'), RETURNING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '출발',
      last_update: '2026-06-02T19:45:00+09:00', delivered_at: null });
    expect(rows(result)).toEqual([
      ['2026-06-02T19:45:00+09:00', '출발', '가나', 'in_transit'],
      ['2026-06-02T16:10:00+09:00', '도착', '가나', 'in_transit'],
      ['2026-06-02T14:31:20+09:00', '인수', null, 'accepted'],
    ]);
    const delivered = parse(changed('returning', (data) => {
      Object.assign(data.steps.destination, { deliveryState: 'DELIVERED', deliveryTime: '2026-06-03T10:00:00+09:00' });
    }), RETURNING);
    expect(delivered).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-06-03T10:00:00+09:00' });
    expect(delivered.events![0]).not.toHaveProperty('location');
    // A collection registered and not yet picked up says so.
    const waiting = parse(changed('returning', (data) => { data.steps.logs = []; data.steps.source.time = null; data.sanitizedLoad.state = 'PENDING_COLLECT'; }), RETURNING);
    expect(waiting).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: '반품 접수가 완료되었어요', events: [] });
    expect(waiting).not.toHaveProperty('provider_code');
  });

  it('names why a delivery was held, and reads a lost or stopped parcel as an exception', () => {
    const held = parse(changed('in-delivery', (data) => {
      Object.assign(data, { state: 'HOLDING_DELIVERY', title: '<공동현관 비밀번호가 없어> 배송하지 못했어요.', description: '공동현관 비밀번호를 알려주시면 다시 찾아갈게요.' });
      data.sanitizedLoad.state = 'HOLDING_DELIVERY';
    }), SHOWN);
    expect(held).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: '공동현관 비밀번호가 없어 배송하지 못했어요.', last_update: '2026-05-20T18:49:13+09:00' });
    expect(statusMapAnswer({ carrier: 'today-kr', providerCode: null, description: held.last_status_text! })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    for (const state of ['LOST', 'QUIT']) {
      expect(parse(changed('in-delivery', (data) => { data.sanitizedLoad.state = state; }), SHOWN)).toMatchObject({ current_stage: 'exception' });
    }
    // A delivery stands, whatever the load's state says.
    expect(parse(changed('delivered', (data) => { data.sanitizedLoad.state = 'QUIT'; }), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads a parcel the driver has not picked up from the page’s state', () => {
    const result = parse(changed('in-delivery', (data) => {
      Object.assign(data, { state: 'BEFORE_COLLECT', title: '투데이가 출발지에서\n물품을 픽업할 예정이에요' });
      data.sanitizedLoad.state = 'PENDING_COLLECT';
      data.progress = { loadState: 'PENDING_COLLECT', pickUpTime: null, shippingTime: null, deliveryStartTime: null, deliveryTime: null, holdingDelivery: false };
      data.steps.source.time = null;
      for (const log of data.steps.logs) Object.assign(log, { arrivalTime: null, departureTime: null });
      data.steps.destination.deliveryState = 'NOT_STARTED';
    }), SHOWN);
    expect(result).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: '투데이가 출발지에서 물품을 픽업할 예정이에요', provider_code: 'BEFORE_COLLECT', last_update: null, delivered_at: null, events: [] });
  });

  it('names the partner a parcel was handed on to only when the page links it and the number is one it issues', () => {
    const handed = (info: Row | undefined, where: 'sanitizedLoad' | 'sanitizedOrder' = 'sanitizedLoad') =>
      parse(changed('delivered', (data) => { data[where].forwardingInfo = info; }), DELIVERED);
    const info = (deliveryOrganizationName: string, invoiceNumber: string, brokerOrganizationName = 'WITHU') =>
      ({ brokerOrganizationName, deliveryOrganizationId: 'synthetic', deliveryOrganizationName, handoverTime: '2026-05-12T12:00:00+09:00', invoiceNumber });
    expect(handed(info('HANJIN', '5000-0000-0001', 'HANJIN'))).toMatchObject({ delivery_carrier: 'hanjin', delivery_tracking_number: '500000000001' });
    expect(handed(info('CJ', '600000000002'))).toMatchObject({ delivery_carrier: 'cj-logistics', delivery_tracking_number: '600000000002' });
    expect(handed(info('EMS', 'EE000000005KR', ''))).toMatchObject({ delivery_carrier: 'korea-post', delivery_tracking_number: 'EE000000005KR' });
    expect(handed(info('CJ', '600000000002'), 'sanitizedOrder')).toMatchObject({ delivery_carrier: 'cj-logistics' });
    // To-Day delivers what a broker carried part of the way, and a number a partner does not issue is no hand-off.
    for (const other of [info('TO_DAY', '500000000001', 'HANJIN'), info('HANJIN', '5000000000'), info('EMS', 'EE000000004KR'), info('LOGEN', '700000000003')]) {
      expect(handed(other)).not.toHaveProperty('delivery_carrier');
      expect(handed(other)).not.toHaveProperty('delivery_tracking_number');
    }
    expect(handed(undefined)).not.toHaveProperty('delivery_carrier');
  });

  it('counts a shipment only when it carries the number asked', () => {
    expect(() => parse(fixture('delivered'), IN_DELIVERY)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'To-Day answered for another shipment' }));
    // The shipper's own number the page does not show is not enough.
    expect(() => parse(changed('in-delivery', (data) => { data.sanitizedLoad.displayInvoiceNumber = IN_DELIVERY; }), SHOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // An older page without the number it shows binds by To-Day's own.
    expect(parse(changed('delivered', (data) => { delete data.sanitizedLoad.displayInvoiceNumber; }), DELIVERED).events).toHaveLength(8);
    expect(() => parse(changed('delivered', (data) => { delete data.sanitizedLoad.displayInvoiceNumber; delete data.sanitizedLoad.invoiceNumber; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads an unknown number as not found and a parcel delivered long ago as expired', () => {
    expect(() => parse(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('expired'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'history_expired' }));
    expect(() => parse(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'To-Day answered for another number' }));
    expect(() => parse({ type: 'ERROR', data: { type: 'UNAVAILABLE', invoiceNumber: UNKNOWN } }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (data: Data) => { delete (data as Row).sanitizedLoad; },
      (data: Data) => { data.sanitizedLoad.invoiceNumber = 100000000017; delete data.sanitizedLoad.displayInvoiceNumber; },
      (data: Data) => { delete (data as Row).steps; },
      (data: Data) => { data.steps.logs = 'logs' as never; },
      (data: Data) => { data.steps.logs = Array.from({ length: 51 }, () => data.steps.logs[0]!); },
      (data: Data) => { data.steps.logs[0] = { arrivalTime: null } as never; },
      (data: Data) => { data.steps.logs[0]!.arrivalTime = '12.05.2026 09:40'; },
      (data: Data) => { data.steps.logs[0]!.arrivalTime = '2026-02-30T09:40:00+09:00'; },
      (data: Data) => { data.steps.logs[0]!.departureTime = 1778548530000; },
      (data: Data) => { data.steps.source.time = '2026-05-12T25:00:00+09:00'; },
      (data: Data) => { data.steps.logs[1]!.station.name = ['다라']; },
      (data: Data) => { data.progress.deliveryStartTime = {}; },
      (data: Data) => { data.state = 4; },
    ]) {
      expect(() => parse(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseToday('NORMAL', 'reply', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a time without an offset on Korea’s clock', () => {
    const result = parse(changed('delivered', (data) => { data.steps.destination.deliveryTime = '2026-05-12T14:02:09.5'; }), DELIVERED);
    expect(result.events![0]).toMatchObject({ time: '2026-05-12T14:02:09+09:00', description: '배송완료' });
    const utc = parse(changed('delivered', (data) => { data.steps.destination.deliveryTime = '2026-05-12T05:02:09Z'; }), DELIVERED);
    expect(utc.delivered_at).toBe('2026-05-12T14:02:09+09:00');
  });

  it('keeps an unknown number, a moved route, a browser check, a refusal, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(html(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers an unknown number itself: a 404 or a redirect is a moved route.
    await expect(lookup(html(fixture('not-found')), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 308, headers: { Location: 'https://my.amazing.today/' } })).rejects.toMatchObject({ kind: 'transport' });
    // Vercel's checkpoint, with its header or by its page.
    await expect(lookup('<html><title>Vercel Security Checkpoint</title></html>', { status: 429, headers: { 'x-vercel-mitigated': 'challenge' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Vercel Security Checkpoint</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Forbidden', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Retry-After': '30' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup('<html><title>배송조회 - Today</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<script id="__NEXT_DATA__" type="application/json">{"props":</script>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(html(fixture('not-found'), seal('{}', 'another passphrase')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(html({ type: 'SOMETHING' as TodayPageType, data: {} }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number To-Day does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(html(fixture('delivered'))))
      .mockResolvedValueOnce(reply(html(fixture('not-found'))))
      .mockResolvedValueOnce(reply(html(fixture('delivered'))))
      .mockResolvedValueOnce(reply(html(fixture('expired'))));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-12T05:02:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // Another parcel in the answer is no answer about this one.
    await expect(carrier(fetcher).recognize!(IN_DELIVERY)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
    await expect(carrier(fetcher).recognize!('1000000000170000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects numbers To-Day does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['10000000001', '1000000000170000', 'SAMPLETRACKING', 'TD000000001KRX', '1'.repeat(80)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTodayNumber('1000-0000-0017')).toBe(DELIVERED);
    expect(normalizeTodayNumber('1000000000171')).toBe('1000000000171');
    expect(normalizeTodayNumber('ee-000000005-kr')).toBe('EE000000005KR');
  });

  it('gives its one read the whole budget and ends a hanging read inside it', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under To-Day to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(html(fixture('delivered'))));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'today-kr' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'today-kr', source: 'today-kr', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${TODAY_PAGE}${DELIVERED}`)).toBe(true);
  });
});

describe('To-Day status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(todayStage(entry.wording), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'today-kr', providerCode: null, description: '배송중' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'today-kr', providerCode: 'BEFORE_COLLECT', description: '투데이가 출발지에서 물품을 픽업할 예정이에요' }))
      .toEqual({ kind: 'mapped', stage: 'registered' });
    expect(statusMapAnswer({ carrier: 'today-kr', providerCode: 'IN_DELIVERY', description: 'Synthetic headline' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'today-kr', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});

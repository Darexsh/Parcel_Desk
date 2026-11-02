import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NEXT_LEVEL_API, NextLevelTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeNextLevelNumber, parseNextLevel } from './parser.js';
import { nextLevelStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '0000000000011';
const ABROAD = '0000000000022';
const RETURNED = '00000033';
const PARTNER = 'SYNTH0000000099';

type Row = Record<string, unknown>;
type Reply = Row[][];

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const movements = (name: string) => JSON.parse(fixture(name)) as Reply;
const changed = (name: string, change: (rows: Row[]) => void): Reply => {
  const reply = movements(name);
  change(reply[0]!);
  return reply;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => reply(body, { ...init, headers: { 'Content-Type': 'text/html' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const lookup = (response: Response, number = DELIVERED) => carrier(answering(() => response)).track({ number });
const hanging = () => vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
}));
const rows = (result: ReturnType<typeof parseNextLevel>) => result.events!.map((event) =>
  [event.time ?? event.local_time, event.description, event.location ?? null, event.provider_code ?? null, event.stage ?? null]);

describe('Next Level HTTP adapter', () => {
  it('posts the whole waybill to the tracker page’s lookup once, anonymously, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('abroad')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NextLevelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000000 000022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(NEXT_LEVEL_API);
    expect(String(url)).toBe('https://api.nextlevel.delivery/v1/track');
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), body: JSON.stringify({ ids: [ABROAD] }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    const headers = Object.keys(init!.headers as Row).map((name) => name.toLowerCase());
    expect(headers).not.toContain('cookie');
    expect(headers).not.toContain('authorization');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'next-level-delivery', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered waybill newest first on Sofia time, with the offices and towns its movements name', () => {
    const result = parseNextLevel(movements('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Доставена', last_update: '2026-03-03T13:47:21+02:00', delivered_at: '2026-03-03T13:47:21+02:00' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(rows(result)).toEqual([
      // A delivery can be at the recipient's address: its place is not kept.
      ['2026-03-03T13:47:21+02:00', 'Доставена', null, '11', 'delivered'],
      // A place holding a number other than the postcode may be a street.
      ['2026-03-03T09:02:33+02:00', 'Предадена на куриер', null, '5', 'out_for_delivery'],
      // The movement listed twice is kept once.
      ['2026-03-03T06:12:09+02:00', 'Пристигнала в офис', 'ОФИС ДРУГО', '6', 'in_transit'],
      ['2026-03-02T21:30:00+02:00', 'Натоварена на линия', 'ОФИС ПРИМЕРНО', '6', 'in_transit'],
      ['2026-03-02T18:05:47+02:00', 'Пристигнала в офис', 'ОФИС ПРИМЕРНО', '6', 'in_transit'],
      // The town keeps no postcode.
      ['2026-03-02T16:40:11+02:00', 'Приета от куриер', 'Примерно', '2', 'accepted'],
      // A parcel still at the sender can name the sender's site.
      ['2026-03-02T10:15:03+02:00', 'Създадена товарителница', null, '1', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps no person, comment, phone number, address, postcode, shop or original waybill', () => {
    const text = ['delivered', 'abroad', 'returned'].map((name) =>
      JSON.stringify(parseNextLevel(movements(name), { delivered: DELIVERED, abroad: ABROAD, returned: RETURNED }[name]!))).join('');
    for (const kept of ['Иван', 'Петър', 'Мария', 'Георги', 'Ivan', 'Synthetic Worker', 'Partner Courier', 'Получил', 'Обадете', '0800',
      'Синтетична', '999', 'МАГАЗИН', 'Другоград', 'Synthetic partner note', '0000000000044', 'worker', 'comment']) {
      expect(text, kept).not.toContain(kept);
    }
  });

  it('reports the subcontractor’s waybill and keeps the subcontractor’s clocks and the repeated hour as local time', () => {
    const result = parseNextLevel(movements('abroad'), ABROAD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Synthetic status',
      last_update: null, last_update_local: '2026-10-27T13:41:16', delivery_tracking_number: PARTNER });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivered_at');
    expect(rows(result)).toEqual([
      // An id the map does not know is left to the shared rules.
      ['2026-10-27T13:41:16', 'Synthetic status', 'Exampleville', '99', null],
      ['2026-10-27T12:54:45', 'Пристигнала в офис', 'ОФИС ПОДИЗПЪЛНИТЕЛ', '6', 'in_transit'],
      // From the subcontractor's acceptance on, the clocks may be another country's.
      ['2026-10-27T05:04:00', 'Приета от подизпълнител', 'ОФИС ПОДИЗПЪЛНИТЕЛ', null, 'in_transit'],
      ['2026-10-25T05:32:28+02:00', 'Натоварена на линия', 'ОФИС СОФИЯ', '6', 'in_transit'],
      // The hour the autumn change repeats is no instant.
      ['2026-10-25T03:30:00', 'Пристигнала в офис', 'ОФИС СОФИЯ', '6', 'in_transit'],
      ['2026-10-24T11:32:28+03:00', 'Received by courier', 'Sofia', '2', 'accepted'],
      ['2026-10-23T17:20:44+03:00', 'Създадена товарителница', null, '1', 'registered'],
    ]);
    expect(result.events![0]).not.toHaveProperty('stage_source');
    expect(result.events!.every((event) => !('time' in event && 'local_time' in event))).toBe(true);
  });

  it('reads a return shipment picked up for the return and delivered back to its sender as returned', () => {
    const result = parseNextLevel(movements('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Delivered to sender',
      last_update: '2026-03-12T12:47:28+02:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(rows(result)).toEqual([
      ['2026-03-12T12:47:28+02:00', 'Delivered to sender', null, '14', 'returned'],
      ['2026-03-11T11:46:37+02:00', 'Picked up by courier for return', null, '17', 'returned'],
      ['2026-03-10T10:54:34+02:00', 'Received by courier', 'Примерно', '2', 'accepted'],
      ['2026-03-09T14:29:51+02:00', 'Получена информация за пратка', null, '1', 'registered'],
    ]);
  });

  it('counts a reply only when every movement names the number asked as the waybill', () => {
    const others: [string, (rows: Row[]) => void][] = [
      ['another waybill', (rows) => { for (const row of rows) row.parcel = '0000000000012'; }],
      ['a longer waybill', (rows) => { for (const row of rows) row.parcel = `${DELIVERED}9`; }],
      ['one movement of another waybill', (rows) => { rows[3]!.parcel = '0000000000012'; }],
      ['no waybill', (rows) => { delete rows[0]!.parcel; }],
      // The original waybill a return shipment names binds nothing.
      ['the original waybill only', (rows) => { for (const row of rows) { row.original_parcel = DELIVERED; row.parcel = '00000034'; } }],
    ];
    for (const [label, change] of others) {
      expect(() => parseNextLevel(changed('delivered', change), DELIVERED), label).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The tracker also finds a shipment by its subcontractor's waybill; that is the subcontractor's shipment.
    const partner = '0000000000099';
    const handedOver = changed('abroad', (rows) => { for (const row of rows) row.courier_awb = partner; });
    expect(parseNextLevel(handedOver, ABROAD)).toMatchObject({ delivery_tracking_number: partner });
    expect(() => parseNextLevel(handedOver, partner)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('subcontractor') }));
    for (const change of [(rows: Row[]) => { rows[0]!.parcel = { awb: DELIVERED }; }, (rows: Row[]) => { rows[0]!.courier_awb = [DELIVERED]; }]) {
      expect(() => parseNextLevel(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a subcontractor’s waybill only when there is one and it is a number', () => {
    expect(parseNextLevel(changed('abroad', (rows) => { rows[2]!.courier_awb = 'SYNTH0000000098'; }), ABROAD)).not.toHaveProperty('delivery_tracking_number');
    expect(parseNextLevel(changed('abroad', (rows) => { for (const row of rows) row.courier_awb = 'n/a'; }), ABROAD)).not.toHaveProperty('delivery_tracking_number');
    expect(parseNextLevel(changed('abroad', (rows) => { for (const row of rows) row.courier_awb = null; }), ABROAD)).not.toHaveProperty('delivery_tracking_number');
  });

  it('rejects a changed reply', () => {
    const broken: [string, (rows: Row[]) => void][] = [
      ['no clock', (rows) => { delete rows[0]!.date; }],
      ['another clock format', (rows) => { rows[0]!.date = '02.03.2026 10:15'; }],
      ['an impossible day', (rows) => { rows[0]!.date = '2026-02-30 10:15:03'; }],
      ['no description or label', (rows) => { rows[0]!.description = ' '; rows[0]!.status = ''; }],
      ['a description that is not text', (rows) => { rows[0]!.description = { bg: 'Доставена' }; rows[0]!.status = null; }],
      ['a status id that is not an id', (rows) => { rows[0]!.status_id = 'Delivered'; }],
      ['a negative status id', (rows) => { rows[0]!.status_id = -1; }],
      ['a status id that is a record', (rows) => { rows[0]!.status_id = { id: 11 }; }],
      ['a movement that is not a record', (rows) => { rows[0] = 'Доставена' as unknown as Row; }],
      ['too many movements', (rows) => { rows.push(...Array.from({ length: 501 }, () => rows[0]!)); }],
    ];
    for (const [label, change] of broken) {
      expect(() => parseNextLevel(changed('delivered', change), DELIVERED), label).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [[], {}, null, DELIVERED, movements('delivered')[0], [...movements('delivered'), []], [{ movements: [] }]]) {
      expect(() => parseNextLevel(payload, DELIVERED), JSON.stringify(payload).slice(0, 40)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the tracker’s empty list as not found, and keeps a bot check, a moved route and a broken reply apart', async () => {
    await expect(lookup(reply(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(html('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><head><title>Just a moment...</title></head></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'challenge' });
    // The lookup answers every number with HTTP 200: a 404 is a moved route, whatever it says.
    await expect(lookup(reply('{"error":{"code":404,"message":"Not found"}}', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('{"error":{"code":405,"message":"The POST method is not supported for this route."}}', { status: 405 })))
      .rejects.toMatchObject({ kind: 'transport' });
    // The tracker page itself, which shows nothing until its script asks the lookup, is no reply.
    for (const body of ['', '<html><div id="__next"></div></html>', '{}', 'null', '[]', '[[], []]']) {
      await expect(lookup(html(body)), body).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = answering(() => new Response('{"message":"Synthetic"}', { status }));
      await expect(carrier(fetcher).track({ number: ABROAD })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('does not ask again after the tracker’s not-found answer', async () => {
    const fetcher = answering(() => reply(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends a read that did not reach Next Level once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('abroad')));
    await expect(carrier(fetcher).track({ number: ABROAD }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a reply over its size limit', async () => {
    await expect(lookup(reply('[[]]', { headers: { 'Content-Length': String(3_000_000) } }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects numbers Next Level does not issue, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000000001', '00000000000001', '0000000', '000000000', PARTNER, 'AB000000001BG', '', '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeNextLevelNumber('0000-0000 00011')).toBe(DELIVERED);
    expect(normalizeNextLevelNumber(' 0000 0033 ')).toBe(RETURNED);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: ABROAD }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('ends with the caller’s reason, without a retry, when the caller cancels', async () => {
    const fetcher = hanging();
    await expect(carrier(fetcher).track({ number: ABROAD }, { signal: AbortSignal.abort(new Error('caller cancelled')) }))
      .rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = createTracker({ fetcher, providers: [], env: {} })
      .track({ number: ABROAD, carrier: 'next-level-delivery' }, { signal: controller.signal, budgetMs: 2000 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a lookup for Next Level, and its tracking link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url) === NEXT_LEVEL_API ? reply(fixture('delivered')) : new Response('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'next-level-delivery' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'next-level-delivery', source: 'next-level-delivery', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === NEXT_LEVEL_API && init?.body === JSON.stringify({ ids: [DELIVERED] }))).toBe(true);
    expect(parseTrackingInput(`https://nextlevel.delivery/track?awb=${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'next-level-delivery' });
  });

  it('declares no recognition: no rule claims thirteen or eight digits', () => {
    expect(carrier(vi.fn<typeof fetch>())).not.toHaveProperty('recognize');
  });
});

describe('Next Level numbers', () => {
  it('accepts every number the tracker confirms, and leaves them to detection’s other candidates', () => {
    const confirmed = numbers.records.filter((record) => record.context.assessment === 'confirmed');
    expect(confirmed.length).toBeGreaterThan(0);
    for (const record of confirmed) {
      expect(normalizeNextLevelNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number).carrier, record.number).not.toBe('next-level-delivery');
      expect(recognitionCandidates(record.number), record.number).not.toContain('next-level-delivery');
      expect(parseTrackingInput(`https://nextlevel.delivery/track?awb=${record.number}`), record.number)
        .toMatchObject({ trackingNumber: record.number, carrier: 'next-level-delivery' });
    }
  });
});

describe('Next Level status vocabulary', () => {
  it('records every status id and wording with the stage the map gives it', () => {
    expect(statuses.entries.filter((entry) => entry.confirmedBy === 'live')).toHaveLength(8);
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code : null;
      expect(nextLevelStage(code ?? null, entry.wording), `${code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'next-level-delivery', providerCode: code ?? null, description: entry.wording }), `${code} ${entry.wording}`)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('leaves the return request out on purpose and an unknown id or wording unknown', () => {
    for (const gap of statusMap.gaps) {
      expect(nextLevelStage(gap.code!, 'Client return requested'), gap.code).toBeUndefined();
      expect(statusMapAnswer({ carrier: 'next-level-delivery', providerCode: gap.code!, description: 'Client return requested' }), gap.code)
        .toEqual({ kind: 'intentional_gap', note: gap.note });
    }
    expect(statusMapAnswer({ carrier: 'next-level-delivery', providerCode: '99', description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'next-level-delivery', providerCode: null, description: 'Доставена' })).toEqual({ kind: 'unknown' });
  });
});

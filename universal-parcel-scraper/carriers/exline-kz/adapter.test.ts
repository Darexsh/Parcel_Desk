import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EXLINE_API, ExlineTracker } from './adapter.js';
import { normalizeExlineNumber, parseExline } from './parser.js';
import { exlineStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '0000000001';
const IN_TRANSIT = '1234567890';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Scan = Record<string, unknown>;
type Order = Record<string, unknown> & { statushistory: Scan[] };
const fixture = (name: string): Order => JSON.parse(text(name)) as Order;
const edited = (name: string, change: (order: Order) => void): Order => {
  const order = fixture(name);
  change(order);
  return order;
};
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const GATEWAY = '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>openresty</center></body></html>';
const failure = (code: string, cause?: string) => JSON.stringify({ error: { code, message: 'Sample error', trace_id: '0' },
  ...(cause === undefined ? {} : { ctx: { measoft_error: cause } }) });

describe('Exline tracking adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ExlineTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 000-0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(EXLINE_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Accept-Language': 'ru', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ orderno: DELIVERED });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'exline-kz', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, with each scan’s wall clock, branch and code, and without people, prices or the note', () => {
    const result = parseExline(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Доставлен', last_update: null, last_update_local: '2026-05-14T11:00:00', expected_delivery: null, weight_kg: 2.5 });
    // Scans in the same second keep the order MeaSoft recorded them in, the later first.
    expect(result.events!.map((event) => [event.local_time, event.location, event.provider_code, event.stage])).toEqual([
      ['2026-05-14T11:00:00', 'Офис в Примерске, Примерск город', 'COMPLETE', 'delivered'],
      ['2026-05-14T11:00:00', 'Офис в Примерске, Примерск город', 'COURIERDELIVERED', 'delivered'],
      ['2026-05-14T09:20:45', 'Офис в Примерске, Примерск город', 'DELIVERY', 'out_for_delivery'],
      ['2026-05-14T09:20:45', 'Офис в Примерске, Примерск город', 'COURIERRETURN', 'failed_attempt'],
      ['2026-05-12T10:05:10', 'Офис в Примерске, Примерск город', 'DELIVERY', 'out_for_delivery'],
      ['2026-05-12T09:30:00', 'Офис в Примерске, Примерск город', 'ACCEPTED', 'in_transit'],
      ['2026-05-12T09:30:00', 'Офис в Примерске, Примерск город', 'PICKUPTRANS', 'in_transit'],
      ['2026-05-11T16:45:30', 'Образцово, Образцово город', 'DEPARTURE', 'in_transit'],
      ['2026-05-11T16:40:05', 'Образцово, Образцово город', 'DEPARTURING', 'in_transit'],
      ['2026-05-11T10:15:20', 'Офис в Примерске, Примерск город', 'NEW', 'registered'],
    ]);
    expect(result.events![1]!.description).toBe('Доставлен (предварительно)');
    // The reply names no zone, so no scan gets an instant.
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    const kept = new Set(['local_time', 'location', 'description', 'provider_code', 'stage', 'stage_source']);
    expect(result.events!.flatMap((event) => Object.keys(event)).filter((key) => !kept.has(key))).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/Образцов(?! город|о)|Тестов|80000000000|KZ0000000000|12345|1234\.50/);
  });

  it('reads a parcel between branches as in transit, with its planned day, and keeps a repeated scan once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Отправлено со склада', last_update_local: '2026-05-18T18:02:13', expected_delivery: '2026-05-20', weight_kg: 0.3 });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['DEPARTURE', 'DEPARTURING', 'ACCEPTED', 'NEW']);
    expect(JSON.stringify(result)).not.toMatch(/Позвонить|Тестов|80000000000|000000"|1\.234567|12\.345678|Образец Pay|1234\.00/);
  });

  it('takes the order’s current status over the scans, and the newest staged scan when the status moves nothing', () => {
    // An operator's correction can leave the current status behind a later scan.
    const corrected = parseExline(edited('delivered', (order) => { order.status = { code: 'RETURNING', name: null, title: 'Планируется возврат' }; }), DELIVERED);
    expect(corrected).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', last_status_text: 'Доставлен' });
    const counted = parseExline(edited('in-transit', (order) => { order.status = { code: 'INVENTORY', name: null, title: 'Инвентаризация' }; }), IN_TRANSIT);
    expect(counted).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    // A status without wording shows its code, as the page does; one with a name shows that.
    const named = parseExline(edited('in-transit', (order) => {
      order.statushistory.push({ event_time: '2026-05-19 08:00:00', event_store: null, event_town: 'Примерск город',
        status: { code: 'SAMPLE_CODE', name: 'Образец статуса', title: null } });
      order.statushistory.push({ event_time: '2026-05-19 09:00:00', status: { code: 'SAMPLE_OTHER', name: null, title: null } });
      order.status = null;
    }), IN_TRANSIT);
    expect(named).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'SAMPLE_OTHER' });
    expect(named.events!.slice(0, 2)).toEqual([
      { local_time: '2026-05-19T09:00:00', description: 'SAMPLE_OTHER', provider_code: 'SAMPLE_OTHER' },
      { local_time: '2026-05-19T08:00:00', location: 'Примерск город', description: 'Образец статуса', provider_code: 'SAMPLE_CODE' },
    ]);
    const bare = parseExline(edited('in-transit', (order) => {
      order.statushistory = [{ event_time: '2026-05-19 08:00:00', status: { code: 'DATECHANGE', title: 'Перенос' } }];
      order.status = { code: 'DATECHANGE', title: 'Перенос' };
    }), IN_TRANSIT);
    expect(bare).toMatchObject({ status: 'unknown', last_status_text: 'Перенос', expected_delivery: '2026-05-20' });
    expect(bare.current_stage).toBeUndefined();
    // A planned day that is no calendar day, or a weight of another shape, is left out.
    const odd = parseExline(edited('in-transit', (order) => { order.receiver_date = '0000-00-00'; order.weight = '0'; }), IN_TRANSIT);
    expect(odd.expected_delivery).toBeNull();
    expect(odd).not.toHaveProperty('weight_kg');
    expect(parseExline(edited('in-transit', (order) => { order.receiver_date = '2026-05-21 00:00:00'; order.weight = 1.5; }), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-05-21', weight_kg: 1.5 });
  });

  it('reads MeaSoft’s answer without an order as not found, and any other failure as inconclusive', async () => {
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: DELIVERED });
    await expect(lookup(text('not-found'), 502)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(failure('MEASOFT_ERROR', 'Connection refused'), 502)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(failure('INTERNAL_ERROR', 'Missing <order> node in tracking response'), 502)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(failure('MEASOFT_ERROR'), 502)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(GATEWAY, 502, 'text/html')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('{"error":', 502)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(failure('VALIDATION_ERROR'), 400)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('delivered')}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('binds the reply to the whole requested number and rejects changed replies', () => {
    expect(() => parseExline(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Exline answered for another shipment' }));
    expect(() => parseExline(edited('delivered', (order) => { order.orderno = `${DELIVERED}1`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const payload of [null, [], 'COMPLETE', {},
      edited('delivered', (order) => { delete order.orderno; }),
      edited('delivered', (order) => { order.orderno = 0; }),
      edited('delivered', (order) => { order.status = 'COMPLETE'; }),
      edited('delivered', (order) => { order.status = { code: 'COMPLETE', name: null, title: ['Доставлен'] }; }),
      edited('delivered', (order) => { order.status = { code: 'Sample code', title: 'Доставлен' }; }),
      edited('delivered', (order) => { order.status = { code: null, name: null, title: null }; }),
      edited('delivered', (order) => { (order as Record<string, unknown>).statushistory = {}; }),
      edited('delivered', (order) => { (order.statushistory as unknown[])[1] = 'scan'; }),
      edited('delivered', (order) => { order.statushistory[1]!.status = null; }),
      edited('delivered', (order) => { order.statushistory[1]!.event_time = '11.05.2026 16:40'; }),
      edited('delivered', (order) => { order.statushistory[1]!.event_time = '2026-02-30 16:40:05'; }),
      edited('delivered', (order) => { order.statushistory[1]!.event_time = '2026-05-11 24:00:00'; }),
      edited('delivered', (order) => { order.statushistory[1]!.event_time = '2026-05-11T16:40:05+05:00'; }),
      edited('delivered', (order) => { order.statushistory[1]!.event_time = null; }),
      edited('delivered', (order) => { order.statushistory[1]!.event_store = 7; }),
      edited('delivered', (order) => { order.receiver_date = 20260520; }),
      edited('delivered', (order) => { order.statushistory = Array.from({ length: 501 }, () => order.statushistory[0]!); })]) {
      expect(() => parseExline(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseExline(edited('delivered', (order) => { order.statushistory = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes ten-digit waybill numbers and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000000', '00000000000', 'EMU0000000000', 'KZ0000000000', 'SAMPLEABCD', `${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeExlineNumber(' 123 456-7890 ')).toBe(IN_TRANSIT);
  });

  it('recognizes a known parcel and an unknown number from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found'), 502));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-14T11:00:00' });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [422, 'schema'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(failure('SAMPLE_ERROR'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under Exline to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'exline-kz' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'exline-kz', source: 'exline-kz', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === EXLINE_API)).toBe(true);
  });

  it('claims no bare ten-digit number, so preflight does not ask it, and opens its tracking links', () => {
    expect(detectCarrierMatch(IN_TRANSIT)?.carrier).not.toBe('exline-kz');
    expect(recognitionAskedCarriers(IN_TRANSIT)).not.toContain('exline-kz');
    for (const language of ['ru', 'kz', 'en', 'uz']) {
      expect(parseTrackingInput(`https://exline.kz/${language}/tracking?id=${IN_TRANSIT}`))
        .toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'exline-kz', source: 'link' });
    }
  });
});

describe('Exline status vocabulary', () => {
  it('maps every code it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(exlineStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'exline-kz', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(exlineStage('complete', 'Доставлен')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(exlineStage('INVENTORY', 'Доставлен')).toBeNull();
    expect(exlineStage('SAMPLE_CODE', 'Образец статуса')).toBeNull();
    expect(statusMapAnswer({ carrier: 'exline-kz', providerCode: 'DATECHANGE', description: 'Перенос' }))
      .toMatchObject({ kind: 'intentional_gap' });
    for (const code of ['constructor', 'toString', 'SAMPLE_CODE']) expect(statusMap.stage(code, ''), code).toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPX_ID_API } from './adapter.js';
import { normalizeSpxIdNumber, parseSpxId, SPX_ID } from './parser.js';
import { spxDeliveryWording, SpxRegionalTracker } from './regional.js';
import { spxIdStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// A marketplace parcel asked by its SPX number; the reply names its Shopee number.
const DELIVERED = 'SPXID26000000001A';
const DELIVERED_SLS = 'ID260000000001A';
const IN_TRANSIT = 'SPXID26000000002B';
const UNKNOWN = 'SPXID26000000003C';
const UNKNOWN_SLS = 'ID260000000003C';

type Row = Record<string, unknown>;
type Tracking = Row & { records: Row[] };
type Reply = Row & { data: Row & { sls_tracking_info: Tracking } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (tracking: Tracking, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data.sls_tracking_info, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPX Express Indonesia HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number once, in the page’s language, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SpxRegionalTracker(SPX_ID, { fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(' spxid 2600-0000-002b ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SPX_ID_API}?spx_tn=${IN_TRANSIT}&language_code=id`);
    expect(SPX_ID_API).toBe('https://spx.co.id/shipment/order/open/order/get_order_info');
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'spx-id', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the visible scans of a delivery once, as instants, without the receiver, the seller’s area or addresses', () => {
    const result = parseSpxId(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Pesanan tiba di alamat tujuan.', last_update: '2026-05-19T08:40:00Z', delivered_at: '2026-05-19T08:40:00Z' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-05-19T08:40:00Z', 'F980', 'delivered', null],
      ['2026-05-19T04:40:00Z', 'F600', 'out_for_delivery', null],
      ['2026-05-18T22:40:00Z', 'F599', 'in_transit', 'Hub Contoh'],
      // The end of the line haul names the place it left.
      ['2026-05-18T21:40:00Z', 'F580', 'in_transit', null],
      ['2026-05-18T12:40:00Z', 'F550', 'in_transit', 'DC Sampel'],
      // The repeated sorting scan is kept once.
      ['2026-05-18T02:40:00Z', 'F510', 'in_transit', 'DC Sampel'],
      // The pickup names the seller's area, which is not kept.
      ['2026-05-17T16:40:00Z', 'F100', 'accepted', null],
      ['2026-05-17T06:40:00Z', 'F000', 'registered', null],
    ]);
    expect(result.events![2]).toMatchObject({ point: { latitude: -6.2, longitude: 106.8 },
      description: 'Pesanan diproses di lokasi transit Kota Contoh, Hub Contoh.' });
    expect(result.events!.every((event) => !('local_time' in event))).toBe(true);
    expect(result).not.toHaveProperty('timezone');
    expect(JSON.stringify(result)).not.toMatch(/Orang Contoh|diterima|Penjual|Jalan|1000000000000000001/);
    // Asked by its Shopee number, the parcel answers the same.
    expect(parseSpxId(fixture('delivered'), DELIVERED_SLS)).toEqual(result);
  });

  it('files a parcel on a line haul in transit, with a scan without a line of its own under its tracking name', () => {
    const result = parseSpxId(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Paket dalam proses pengiriman, menunggu jadwal keberangkatan operator transportasi', last_update: '2026-05-18T08:40:00Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['F550', 'in_transit', 'DC Sampel'],
      ['F515', 'in_transit', 'DC Sampel'],
      ['F510', 'in_transit', 'DC Sampel'],
      ['F450', 'in_transit', 'Hub Awal'],
      ['F440', 'in_transit', 'Hub Awal'],
      ['F100', 'accepted', null],
      ['F004', 'registered', null],
      ['F000', 'registered', null],
    ]);
    expect(result.events![1]!.description).toBe('Packed in Domestic Sorting Centre');
  });

  it('reads a failed attempt, a return, a stalled return and a code it does not know', () => {
    const at = (code: string, description: string, name = 'Synthetic') => changed('delivered', (tracking) => {
      Object.assign(tracking.records[0]!, { tracking_code: code, tracking_name: name, description });
    });
    expect(parseSpxId(at('F650', 'Pengiriman ditunda karena Pesanan ditolak pembeli.'), DELIVERED))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    const returned = parseSpxId(at('F999', 'Pesanan dikembalikan ke Pengirim '), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Pesanan dikembalikan ke Pengirim' });
    expect(returned).not.toHaveProperty('delivered_at');
    expect(parseSpxId(at('F680', 'Pesanan sedang dikembalikan ke alamat Pengirim.'), DELIVERED))
      .toMatchObject({ current_stage: 'returned', events: expect.arrayContaining([expect.objectContaining({ provider_code: 'F680', location: 'Hub Contoh' })]) });
    expect(parseSpxId(at('F699', 'Synthetic'), DELIVERED)).toMatchObject({ current_stage: 'exception' });
    const unmapped = parseSpxId(at('F777', 'Pemberitahuan sintetis'), DELIVERED);
    // A scan nothing stages leaves the stage to the newest scan that has one.
    expect(unmapped.events![0]).not.toHaveProperty('stage');
    expect(unmapped).toMatchObject({ last_status_text: 'Pemberitahuan sintetis', current_stage: 'out_for_delivery' });
  });

  it('reads the way back of a return the page hides, and leaves out the rest of what it hides', () => {
    const row = (code: string, time: number, description: string, flag: number, place = '') => ({
      tracking_code: code, tracking_name: 'Synthetic', description, actual_time: time, display_flag: flag,
      ...(place ? { current_location: { location_name: place, lng: '106.8', lat: '-6.2' } } : {}),
    });
    const result = parseSpxId(changed('delivered', (tracking) => {
      tracking.records = [
        row('F680', 1_779_300_000, 'Pesanan telah melewati batas pengiriman dan akan dikembalikan ke Penjual.', 1),
        row('F677', 1_779_180_000, 'Pesanan dikirim dari Kota Contoh, Hub Contoh ke kota asal.', 0, 'Hub Contoh'),
        row('F672', 1_779_172_100, 'Pengembalian pesanan dikonfirmasi untuk dikirim ke lokasi selanjutnya.', 0, 'Hub Contoh'),
        row('F671', 1_779_172_001, 'Pengembalian pesanan tiba di lokasi sortir Kota Contoh, Hub Contoh.', 0, 'Hub Contoh'),
        row('F599', 1_779_172_000, 'Pesanan diproses di lokasi transit Kota Contoh, Hub Contoh.', 0, 'Hub Contoh'),
        row('F650', 1_779_170_700, 'Pengiriman ditunda karena Pesanan ditolak pembeli.', 0),
        row('F600', 1_779_170_400, 'Pesanan dalam proses pengantaran.', 0),
        row('F598', 1_779_170_300, 'Kurir sudah ditugaskan. Pesanan akan dikirim.', 0, 'Hub Contoh'),
        row('F650', 1_779_170_000, 'Pengiriman ditunda karena Pesanan ditolak pembeli.', 1),
        ...tracking.records.slice(1),
      ];
    }), DELIVERED);
    expect(result.events!.slice(0, 6).map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['F680', 'returned', null],
      ['F677', 'returned', 'Hub Contoh'],
      ['F671', 'returned', 'Hub Contoh'],
      ['F599', 'in_transit', 'Hub Contoh'],
      ['F650', 'failed_attempt', null],
      ['F600', 'out_for_delivery', null],
    ]);
    expect(result.events!.filter((event) => event.provider_code === 'F650')).toHaveLength(1);
    expect(result.events!.map((event) => event.provider_code)).not.toContain('F672');
    expect(result).toMatchObject({ current_stage: 'returned' });
  });

  it('takes whoever received the parcel out of a delivery’s wording only', () => {
    expect(spxDeliveryWording('Pesanan tiba di alamat tujuan. diterima oleh Yang bersangkutan.')).toBe('Pesanan tiba di alamat tujuan.');
    expect(spxDeliveryWording('[Hub Contoh] Your parcel has been delivered [Orang Contoh] ')).toBe('[Hub Contoh] Your parcel has been delivered');
    expect(spxDeliveryWording('Parcel has been delivered, received by Orang Contoh')).toBe('Parcel has been delivered');
    expect(spxDeliveryWording('Pesanan tiba di alamat tujuan.')).toBe('Pesanan tiba di alamat tujuan.');
    // Other scans keep their wording as it came.
    const sorted = parseSpxId(changed('in-transit', (tracking) => {
      tracking.records[0]!.description = 'Paket telah diterima oleh Pusat Sortir Contoh';
    }), IN_TRANSIT);
    expect(sorted.last_status_text).toBe('Paket telah diterima oleh Pusat Sortir Contoh');
  });

  it('reads an unknown SPX number as not found, the same answer for a Shopee number and other failures as inconclusive', () => {
    expect(() => parseSpxId(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A marketplace parcel is often found only by its SPX number.
    expect(() => parseSpxId(fixture('not-found'), UNKNOWN_SLS)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const several = { ...fixture('not-found'), message: String(fixture('not-found').message).replace('find [0]', 'find [2]') };
    expect(() => parseSpxId(several, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpxId({ retcode: 2001, message: 'param is invalid' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A parcel whose scans the lookup no longer holds, or holds none it shows.
    expect(() => parseSpxId(fixture('no-history'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSpxId({ retcode: 0, data: { fulfillment_info: {} } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSpxId(changed('delivered', (tracking) => { tracking.records = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseSpxId(changed('delivered', (tracking) => {
      tracking.records = tracking.records.filter((row) => row.tracking_code !== 'F599');
      for (const row of tracking.records) row.display_flag = 0;
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked, or a Shopee number for an SPX number', () => {
    const another = { kind: 'indeterminate', message: 'SPX Express Indonesia answered for another shipment' };
    // Asked by another Shopee number.
    expect(() => parseSpxId(fixture('delivered'), 'ID260000000009Z')).toThrow(expect.objectContaining(another));
    // A reply naming a number of another country's layout.
    expect(() => parseSpxId(changed('delivered', (tracking) => { tracking.sls_tn = 'MY260000000001A'; }), DELIVERED))
      .toThrow(expect.objectContaining(another));
    // A standalone order names its SPX number, which must be the one asked.
    const standalone = (spx: string) => changed('delivered', (_tracking, body) => {
      body.data.order_info = { sls_tn: DELIVERED_SLS, spx_tn: spx };
    });
    expect(parseSpxId(standalone(DELIVERED), DELIVERED).events).toHaveLength(8);
    expect(parseSpxId(standalone(DELIVERED), DELIVERED_SLS).events).toHaveLength(8);
    expect(() => parseSpxId(standalone(IN_TRANSIT), DELIVERED)).toThrow(expect.objectContaining(another));
    expect(parseSpxId(changed('delivered', (tracking) => { tracking.sls_tn = DELIVERED_SLS.toLowerCase(); }), DELIVERED_SLS).events).toHaveLength(8);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_tracking: Tracking, body: Reply) => { delete (body as Row).retcode; },
      (_tracking: Tracking, body: Reply) => { body.data = 'shipment' as never; },
      (_tracking: Tracking, body: Reply) => { body.data.sls_tracking_info = 'tracking' as never; },
      (_tracking: Tracking, body: Reply) => { body.data.order_info = 'order'; },
      (tracking: Tracking) => { delete (tracking as Row).sls_tn; },
      (tracking: Tracking) => { tracking.records = 'records' as never; },
      (tracking: Tracking) => { tracking.records = Array.from({ length: 1001 }, () => tracking.records[0]!); },
      (tracking: Tracking) => { tracking.records[0] = 'scan' as never; },
      (tracking: Tracking) => { tracking.records[0]!.actual_time = '1779180000'; },
      (tracking: Tracking) => { tracking.records[0]!.actual_time = 1_779_180_000_000; },
      (tracking: Tracking) => { delete tracking.records[0]!.actual_time; },
      (tracking: Tracking) => { tracking.records[0]!.description = ['Pesanan tiba']; },
      (tracking: Tracking) => { tracking.records[0]!.tracking_code = 'F 980'; },
      (tracking: Tracking) => { tracking.records[0]!.description = ''; tracking.records[0]!.tracking_name = ''; },
      (tracking: Tracking) => { (tracking.records[3]!.current_location as Row).location_name = 42; },
    ]) {
      expect(() => parseSpxId(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a gateway page and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://spx.co.id/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!doctype html><html><title>Verify</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"retcode":0,')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('offers no recognition: SPX numbers need none and a Shopee number’s absence proves nothing', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('rejects numbers SPX Indonesia does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SPXID2600000001A', 'SPXID260000000001AB', 'SPXMY26000000001A', 'ID26000000001', 'ID260000000001AB', 'PH260000000001A']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpxIdNumber('spxid 2600 0000 002 b')).toBe(IN_TRANSIT);
    expect(normalizeSpxIdNumber('ID260000000001')).toBe('ID260000000001');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes an SPX Indonesia number to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'spx-id', source: 'spx-id', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED_SLS, carrier: 'spx-id' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'spx-id', source: 'spx-id' });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(SPX_ID_API))).toBe(true);
  });
});

describe('SPX Express Indonesia numbers', () => {
  it('claims its SPX numbers and only suggests it for a Shopee number', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'spx-id', confidence: 'high' });
    expect(detectCarrierMatch(DELIVERED_SLS)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['spx-id']) });
  });
});

describe('SPX Express Indonesia status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    // The legacy feed's names come from the tracker's older replies, which the adapter does not read.
    for (const entry of (statuses.entries as { code: string; wording: string; stage: string; note?: string }[])
      .filter((entry) => !entry.note?.startsWith('Legacy feed status.'))) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(spxIdStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'spx-id', providerCode: 'F600', description: 'Pesanan dalam proses pengantaran.' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'spx-id', providerCode: 'F777', description: 'Pemberitahuan sintetis' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(spxIdStage('F981', 'Your parcel has been delivered')).toMatchObject({ stage: 'delivered' });
    expect(spxIdStage('F777', 'Pemberitahuan sintetis')).toBeNull();
  });
});

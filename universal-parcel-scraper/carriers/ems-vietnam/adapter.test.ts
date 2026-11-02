import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EMS_VIETNAM_API, EmsVietnamTracker } from './adapter.js';
import { emsVietnamScanText, normalizeEmsVietnamNumber, parseEmsVietnam } from './parser.js';
import { emsVietnamStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'EB000000014VN';
const IN_TRANSIT = 'EE000000028VN';
const LEGACY = 'ER000000059VN';
const ABROAD = 'EE000000045VN';
const UNKNOWN = 'EB000000076VN';
// A national-post item, which the express tracker does not hold.
const POSTAL = 'RR000000062VN';

type Row = Record<string, unknown>;
type Reply = Row & { List_TBL_DINH_VI: Row[]; List_TBL_DELIVERY: Row[] | null; TBL_INFO: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const NULLS = { List_TBL_DINH_VI: null, List_TBL_DELIVERY: null, List_TBL_DELIVERY_lIST: null, TBL_INFO: null };
// ASP.NET's answer to a number the service cannot look up, such as a national-post item.
const FAILED = { Message: 'An error has occurred.' };
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('EMS Vietnam HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EmsVietnamTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ee 000 000 028 vn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${EMS_VIETNAM_API}?itemcode=${IN_TRANSIT}EMS&language=0`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ems-vietnam', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history on Vietnam’s clock, without the receiver, the helpline or the notes’ stage', () => {
    const result = parseEmsVietnam(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Đã thu tiền bưu tá', last_update: '2026-05-07T20:09:28+07:00', expected_delivery: null,
      delivered_at: '2026-05-07T10:30:33+07:00', weight_kg: 0.25, destination_country: 'VN' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('history_truncated');
    // The repeated arrival is kept once.
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage ?? null, event.location])).toEqual([
      ['2026-05-07T20:09:28+07:00', null, null, 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-07T10:30:33+07:00', 'EMI', 'delivered', 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-07T10:30:33+07:00', null, null, 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-07T09:03:35+07:00', null, null, 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-07T09:03:35+07:00', 'EDG', 'out_for_delivery', 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-06T19:32:16+07:00', 'EMH', 'failed_attempt', 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-06T08:54:15+07:00', null, null, 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-06T08:54:15+07:00', 'EDG', 'out_for_delivery', 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-06T06:18:41+07:00', null, 'in_transit', 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-06T06:02:27+07:00', null, 'in_transit', 'BCVH Mẫu Ba - Thành phố Mẫu B'],
      ['2026-05-06T03:18:00+07:00', null, 'in_transit', 'EMS Mẫu LT - Thành phố Mẫu B'],
      ['2026-05-05T20:40:28+07:00', null, 'in_transit', 'EMS Mẫu LT - Thành phố Mẫu B'],
      ['2026-05-05T09:42:44+07:00', null, 'in_transit', 'KTC1 Mẫu - Tỉnh Mẫu A'],
      ['2026-05-05T09:05:41+07:00', null, 'in_transit', 'KTC1 Mẫu - Tỉnh Mẫu A'],
      ['2026-05-05T07:56:11+07:00', null, null, 'Bưu cục Mẫu A - Tỉnh Mẫu A'],
      ['2026-05-04T17:45:18+07:00', 'EMA', 'accepted', 'Bưu cục Mẫu A - Tỉnh Mẫu A'],
    ]);
    expect(result.events!.slice(0, 2).map((event) => event.description)).toEqual(['Đã thu tiền bưu tá', 'Phát thành công (Delivered)']);
    expect(result.events!.at(-1)).toMatchObject({ description: 'Chấp nhận gửi (Posting / Collection)', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/Người|CSKH|0000|Số \d|Đường|Phường|C000000000|Chưa phát/);
  });

  it('reads an item on its way, from the pickup request, without the sender’s reference', () => {
    const result = parseEmsVietnam(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Đã đến bưu cục (Arrival at PO)', last_update: '2026-05-12T03:09:00+07:00', weight_kg: 1.2 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.stage)).toEqual(
      ['in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'accepted', 'registered', 'registered']);
    expect(result.events!.at(-2)).toMatchObject({ description: 'Đang đi thu gom', location: 'Bưu cục Mẫu A - Tỉnh Mẫu A' });
    expect(JSON.stringify(result)).not.toContain('MAU-0001');
  });

  it('reads the older layout’s offices from the position field, without the postman or the phones', () => {
    const result = parseEmsVietnam(fixture('legacy'), LEGACY);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-03-19T09:55:03+07:00', weight_kg: 0.028 });
    expect(result.events!.map((event) => [event.time, event.description, event.stage, event.location])).toEqual([
      ['2026-03-19T09:55:03+07:00', 'Phát thành công', 'delivered', 'BCP Mẫu 2'],
      ['2026-03-19T08:55:22+07:00', 'Đã giao cho bưu tá', 'out_for_delivery', 'BCP Mẫu 2'],
      ['2026-03-18T21:18:00+07:00', 'Đã xác nhận đến', 'in_transit', 'KT EMS Mẫu nội tỉnh'],
      ['2026-03-18T20:38:49+07:00', '[BĐ8]Đã tới bưu cục nhận', 'in_transit', 'KT EMS Mẫu nội tỉnh'],
      ['2026-03-18T16:51:12+07:00', '[BĐ8]Đã xác nhận đi', 'in_transit', 'Bưu cục Mẫu A'],
      ['2026-03-18T15:25:15+07:00', 'Đã đóng chuyến thư đi', 'in_transit', 'Bưu cục Mẫu A'],
      ['2026-03-18T09:37:08+07:00', 'Chấp nhận gửi', 'accepted', 'Bưu cục Mẫu A'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/NGUYỄN|SĐT|ÐT|0900|000\.|mẫu\./);
  });

  it('keeps a scan outside Vietnam on its wall clock and marks the international exchange as missing', () => {
    const result = parseEmsVietnam(fixture('international'), ABROAD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'Đến nước nhận (Arrival at destination country)', last_update: null,
      last_update_local: '2026-05-05T23:10:00', destination_country: 'US', history_truncated: true });
    expect(result.events![0]).toEqual({ local_time: '2026-05-05T23:10:00', description: 'Đến nước nhận (Arrival at destination country)',
      stage: 'in_transit', stage_source: 'wording:language' });
    expect(result.events!.slice(1).map((event) => [event.time, event.local_time])).toEqual([
      ['2026-05-03T07:45:51+07:00', undefined], ['2026-05-02T15:20:05+07:00', undefined], ['2026-05-02T10:12:40+07:00', undefined],
    ]);
    // A domestic delivery table repeats the history's delivery scans.
    expect(parseEmsVietnam(fixture('delivered'), DELIVERED)).not.toHaveProperty('history_truncated');
  });

  it('reads a history listed newest first as it is', () => {
    const result = parseEmsVietnam(changed('in-transit', (body) => { body.List_TBL_DINH_VI.reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-05-12T03:09:00+07:00', last_status_text: 'Đã đến bưu cục (Arrival at PO)' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Đã phân hướng lấy hàng (Data out for Pickup)' });
  });

  it('takes the code, the office, people and phone numbers out of a scan’s wording', () => {
    expect(emsVietnamScanText('EMI - Phát thành công (Delivered) (700300: BCVH Mẫu - Thành phố Mẫu B    ) (Đầu mối CSKH: 0000 000000)'))
      .toEqual({ code: 'EMI', description: 'Phát thành công (Delivered)', office: 'BCVH Mẫu - Thành phố Mẫu B' });
    expect(emsVietnamScanText('Đã đến bưu cục (Arrival at PO) (700300: BCVH Mẫu (Quận Mẫu) - Thành phố Mẫu B)'))
      .toEqual({ code: '', description: 'Đã đến bưu cục (Arrival at PO)', office: 'BCVH Mẫu (Quận Mẫu) - Thành phố Mẫu B' });
    expect(emsVietnamScanText('Chấp nhận gửi (Đầu mối CSKH: 000.00.000.000\r\n)').description).toBe('Chấp nhận gửi');
    expect(emsVietnamScanText('Đã giao cho bưu tá:  NGUYỄN VĂN MẪU SĐT:0900000000').description).toBe('Đã giao cho bưu tá');
    expect(emsVietnamScanText('EDG - Đã giao bưu tá phát: Người Mẫu').description).toBe('Đã giao bưu tá phát');
    expect(emsVietnamScanText('Đã phát thành công . Người nhận:()Người Nhận Mẫu').description).toBe('Đã phát thành công');
    expect(emsVietnamScanText('Phát thành công, người ký: Người Mẫu').description).toBe('Phát thành công');
    expect(emsVietnamScanText('Phát không thành công - Điện thoại: 0900 000 000').description).toBe('Phát không thành công');
    expect(emsVietnamScanText('Liên hệ người nhận 0900.000.000 để hẹn lại').description).toBe('Liên hệ người nhận để hẹn lại');
    // Short numbers stay.
    expect(emsVietnamScanText('[BĐ8]Đã xác nhận đi').description).toBe('[BĐ8]Đã xác nhận đi');
  });

  it('reads the tracker’s own unknown-number answers as not found and anything else as inconclusive', () => {
    expect(() => parseEmsVietnam(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEmsVietnam({ ...NULLS, Code: '99', Message: 'Không tìm thấy thông tin bưu gửi' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEmsVietnam({ ...NULLS, Code: '99', Message: 'Lỗi hệ thống' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEmsVietnam({ ...NULLS, Code: '01', Message: 'Không tìm thấy thông tin bưu gửi' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEmsVietnam(FAILED, POSTAL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Delivery rows alone name no item.
    for (const info of [null, {}]) {
      expect(() => parseEmsVietnam(changed('international', (body) => { body.List_TBL_DINH_VI = []; body.TBL_INFO = info as never; }), ABROAD))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'EMS Vietnam answered without naming the item' }));
    }
    for (const scans of [[], null]) {
      expect(() => parseEmsVietnam(changed('delivered', (body) => { body.List_TBL_DINH_VI = scans as never; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('counts a record only when it names the number asked', () => {
    // A number that is not an item's matches sender references, so the record must be checked.
    expect(() => parseEmsVietnam(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'EMS Vietnam answered for another item' }));
    expect(parseEmsVietnam(changed('in-transit', (body) => { body.TBL_INFO.MAE1 = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(8);
  });

  it('rejects a changed reply', () => {
    const scan = (body: Reply) => body.List_TBL_DINH_VI[0]!;
    for (const change of [
      (body: Reply) => { delete (body as Row).Code; },
      (body: Reply) => { body.Code = 0; },
      (body: Reply) => { body.Code = null; },
      (body: Reply) => { body.TBL_INFO = 'item' as never; },
      (body: Reply) => { delete body.TBL_INFO.MAE1; },
      (body: Reply) => { body.List_TBL_DINH_VI = 'scans' as never; },
      (body: Reply) => { body.List_TBL_DINH_VI = Array.from({ length: 501 }, () => scan(body)); },
      (body: Reply) => { body.List_TBL_DINH_VI[0] = 'scan' as never; },
      (body: Reply) => { body.List_TBL_DELIVERY = 'rows' as never; },
      (body: Reply) => { scan(body).NGAY = '2026-05-04'; },
      (body: Reply) => { scan(body).NGAY = '30/02/2026'; },
      (body: Reply) => { scan(body).GIO = '17:45'; },
      (body: Reply) => { scan(body).GIO = '24:00:00'; },
      (body: Reply) => { delete scan(body).GIO; },
      (body: Reply) => { scan(body).TRANG_THAI = 7; },
      (body: Reply) => { scan(body).TRANG_THAI = ''; },
    ]) {
      expect(() => parseEmsVietnam(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', [], {}, null]) {
      expect(() => parseEmsVietnam(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a national-post item, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit, number = UNKNOWN) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(FAILED, { status: 500 }, POSTAL)).rejects.toMatchObject({ kind: 'indeterminate' });
    // The service answers an unknown number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://ems.com.vn/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>EMS Việt Nam</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number EMS Vietnam does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-07T13:09:28.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('EB00000001VN')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers EMS Vietnam does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['EB00000001VN', 'EB000000015VN', 'SAMPLETRACKING', `EB${'0'.repeat(70)}VN`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEmsVietnamNumber('eb 000 000 014 vn')).toBe(DELIVERED);
  });

  it('gives its one read the whole budget and ends a hanging read inside it', async () => {
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

  it('routes a number filed under EMS Vietnam to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ems-vietnam' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ems-vietnam', source: 'ems-vietnam', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(EMS_VIETNAM_API))).toBe(true);
  });
});

describe('EMS Vietnam numbers', () => {
  it('leaves its S10 numbers to generic postal detection, which the national post shares', () => {
    for (const number of [DELIVERED, IN_TRANSIT, POSTAL]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post' });
    }
  });

  it('is asked first about E-series items only', () => {
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('ems-vietnam');
    expect(recognitionAskedCarriers(IN_TRANSIT)[0]).toBe('ems-vietnam');
    expect(recognitionAskedCarriers(POSTAL)).not.toContain('ems-vietnam');
  });
});

describe('EMS Vietnam status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? '';
      if (entry.unmapped) {
        expect(statusMap.stage(code || null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(emsVietnamStage(code, entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'ems-vietnam', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(code || null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(emsVietnamStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ems-vietnam', providerCode: 'EMH', description: 'Phát không thành công (Attempted / Unsuccessful delivery)' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'ems-vietnam', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to its wording, then to the shared rules.
    expect(emsVietnamStage('EXA', 'Đã đến bưu cục (Arrival at PO)')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(emsVietnamStage('EXZ', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(emsVietnamStage('', 'Synthetic note')).toBeNull();
    expect(emsVietnamStage('emi', 'Phát thành công (Delivered)')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});

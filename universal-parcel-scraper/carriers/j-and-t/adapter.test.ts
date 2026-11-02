import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { JNT_ROUTER, JNT_SIGNING_SECRET, parseJnt } from './app.js';
import { JNT_CODES } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Every waybill, name, town, phone number, secret and time here is invented.
const NUMBER = 'JX0000000001';
const PRIVATE = /PRIVATE|SYNTHETIC|\+62|example\.invalid|\.000001/;

interface Row { billCode: string; code: number | string; status?: string; customerTracking?: string;
  scanTime: { date: Record<string, number>; time: Record<string, number> }; [field: string]: unknown }
interface Bill { billCode: string; process?: number; details: Row[] }
interface Envelope { code: number; success: boolean; data: { bills: Bill[] }; [field: string]: unknown }

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as Envelope;
/** The reply as the router sends it: `data` is a JSON document inside a string. */
const wire = (payload: Envelope | Record<string, unknown> = fixture()) =>
  JSON.stringify({ ...payload, ...(typeof payload.data === 'object' ? { data: JSON.stringify(payload.data) } : {}) });
const edited = (edit: (payload: Envelope) => void) => { const payload = fixture(); edit(payload); return payload; };
const rows = (payload: Envelope) => payload.data.bills[0]!.details;
const empty = { code: 200, data: '{"bills":[]}', desc: '成功', success: true, sessionid: null, sqlid: null, traceId: null };
const instance = (fetcher: typeof fetch) => adapter({
  fetcher, env: {}, browserExecutablePath: null, trawl: null, recorder: NOOP_RECORDER, userAgent: 'Host/1.0',
});
const replying = (body: string, init?: ResponseInit) => vi.fn<typeof fetch>(async () => new Response(body, init));

describe('J&T Indonesia router reply', () => {
  it('binds the waybill, keeps newest-first local clocks and projects no personal or internal data', () => {
    const result = parseJnt(JSON.parse(wire()), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package has been delivered', last_update: null, last_update_local: '2026-01-04T10:15:00' });
    expect(result.timezone).toBeUndefined();
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['100', 'delivered'], ['94', 'out_for_delivery'], ['110', 'exception'], ['92', 'in_transit'],
      ['50', 'in_transit'], ['92', 'in_transit'], ['10', 'accepted'], ['210', 'accepted'],
    ]);
    expect(result.events?.map((event) => event.description)).toEqual([
      'Package has been delivered',
      'Package will be delivered',
      'Shipment process is being delayed for the reason: Telepon tidak diangkat atau non-aktif',
      'Package has been arrived at KOTA TUJUAN Drop Point',
      'Package will be departed to KOTA TUJUAN Drop Point',
      'Package has been arrived at KOTA ASAL Transit Center',
      'Package has been processed at KOTA ASAL Drop Point',
      'Pick-Up',
    ]);
    expect(result.events?.[0]).toEqual({ local_time: '2026-01-04T10:15:00', description: 'Package has been delivered',
      location: 'KOTA TUJUAN, PROVINSI TUJUAN', provider_code: '100', stage: 'delivered', stage_source: 'carrier_map' });
    // A departure's scan fields name the next stop, not the place it leaves.
    expect(result.events?.[4]).not.toHaveProperty('location');
    expect(result.events?.[5]?.location).toBe('KOTA ASAL, PROVINSI ASAL');
    expect(result.events?.every((event) => event.time === undefined && event.point === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('reads data sent as an object as well as inside a string', () => {
    expect(parseJnt(fixture(), NUMBER)).toEqual(parseJnt(JSON.parse(wire()), NUMBER));
  });

  it('restores newest-first order, drops repeated scans and bounds the history', () => {
    const reversed = edited((payload) => { rows(payload).reverse(); });
    expect(parseJnt(reversed, NUMBER).events).toEqual(parseJnt(fixture(), NUMBER).events);
    const repeated = edited((payload) => { rows(payload).splice(1, 0, structuredClone(rows(payload)[0]!)); });
    expect(parseJnt(repeated, NUMBER).events).toHaveLength(8);
    const long = edited((payload) => {
      payload.data.bills[0]!.details = Array.from({ length: 150 }, (_, index) => ({ ...rows(payload)[3]!,
        scanTime: { date: { year: 2026, month: 1, day: 1 + Math.floor(index / 60) }, time: { hour: 0, minute: index % 60, second: 0 } } })).reverse();
    });
    const result = parseJnt(long, NUMBER);
    expect(result.events).toHaveLength(100);
    expect(result.last_update_local).toBe('2026-01-03T00:29:00');
  });

  it('falls back to the English label for unknown wording and leaves unknown codes to the shared classifier', () => {
    const result = parseJnt(edited((payload) => {
      rows(payload)[0]!.code = 999;
      rows(payload)[0]!.status = 'Returned';
      rows(payload)[0]!.customerTracking = 'Package handed back to PRIVATE SENDER at +620000000004';
      rows(payload)[3]!.customerTracking = 'New wording naming PRIVATE RECIPIENT';
    }), NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Returned' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result.events?.[0]).not.toHaveProperty('stage_source');
    expect(result.events?.[3]?.description).toBe('On Shipping');
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('repeats only the hold reasons read live', () => {
    for (const reason of ['Hubungi 0812-000-000', 'Kirim ke private@example.invalid', 'Lihat https://example.invalid/x',
      'Lihat www.example.invalid', 'Penerima PRIVATE RECIPIENT menolak', 'Hubungi kurir di nol delapan satu dua PRIVATE']) {
      const result = parseJnt(edited((payload) => {
        rows(payload)[2]!.customerTracking = `Shipment process is being delayed for the reason: ${reason}`;
      }), NUMBER);
      expect(result.events?.[2]?.description).toBe('Shipment process is being delayed');
      expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    }
  });

  it('gives way to the label when a kept sentence names anything but the scan town and a facility type', () => {
    const result = parseJnt(edited((payload) => {
      rows(payload)[3]!.customerTracking = 'Package has been arrived at KOTA TUJUAN Drop Point by PRIVATE COURIER';
      rows(payload)[4]!.customerTracking = 'Package will be departed to KOTA TUJUAN Drop Point, received by PRIVATE RECIPIENT';
      rows(payload)[5]!.customerTracking = 'Package has been arrived at PRIVATE 0812000000 Drop Point.';
      rows(payload)[6]!.customerTracking = 'Package has been processed at www.example.invalid by PRIVATE COURIER';
    }), NUMBER);
    expect(result.events?.slice(3, 7).map((event) => event.description)).toEqual(['On Shipping', 'On Shipping', 'On Shipping', 'Pick-Up']);
    const elsewhere = parseJnt(edited((payload) => {
      rows(payload)[3]!.customerTracking = 'Package has been arrived at PRIVATE TOWN Drop Point.';
      rows(payload)[6]!.customerTracking = 'Package has been processed at KOTA ASAL Sorting Desk by PRIVATE COURIER';
    }), NUMBER);
    expect([elsewhere.events?.[3]?.description, elsewhere.events?.[6]?.description]).toEqual(['On Shipping', 'Pick-Up']);
    expect(JSON.stringify([result, elsewhere])).not.toMatch(PRIVATE);
  });

  it("gives a scan from the router's own system network no place", () => {
    const result = parseJnt(edited((payload) => {
      Object.assign(rows(payload)[2]!, { scanNetworkCode: 'SISTEM01', scanNetworkName: 'DP_AUTO',
        customerTracking: 'Shipment process is being delayed for the reason: Pengiriman dihentikan/diterminasi' });
      Object.assign(rows(payload)[3]!, { scanNetworkCode: 'SISTEM02', scanNetworkName: 'KOTA TUJUAN SYNTHETIC' });
      Object.assign(rows(payload)[5]!, { scanNetworkCode: 'SYN01', scanNetworkName: 'TC_AUTO' });
    }), NUMBER);
    expect(result.events?.[2]).toEqual({ local_time: '2026-01-03T17:40:05', provider_code: '110', stage: 'exception', stage_source: 'carrier_map',
      description: 'Shipment process is being delayed for the reason: Pengiriman dihentikan/diterminasi' });
    expect(result.events?.[3]).toMatchObject({ description: 'On Shipping', stage: 'in_transit' });
    expect(result.events?.[3]).not.toHaveProperty('location');
    expect(result.events?.[5]).toMatchObject({ description: 'On Shipping', stage: 'in_transit' });
    expect(result.events?.[5]).not.toHaveProperty('location');
    expect(result.events?.[6]?.location).toBe('KOTA ASAL, PROVINSI ASAL');
  });

  it.each([
    ['a different waybill', (payload: Envelope) => { payload.data.bills[0]!.billCode = 'JX0000000002'; }],
    ['a scan of a different waybill', (payload: Envelope) => { rows(payload)[4]!.billCode = 'JX0000000002'; }],
    ['several waybills', (payload: Envelope) => { payload.data.bills.push(structuredClone(payload.data.bills[0]!)); }],
    ['no scan list', (payload: Envelope) => { delete (payload.data.bills[0] as Partial<Bill>).details; }],
    ['an impossible scan time', (payload: Envelope) => { rows(payload)[1]!.scanTime.date.month = 13; }],
    ['a missing scan time', (payload: Envelope) => { delete (rows(payload)[1] as Partial<Row>).scanTime; }],
    ['a non-numeric scan code', (payload: Envelope) => { rows(payload)[1]!.code = 'PRIVATE'; }],
    ['an empty scan', (payload: Envelope) => { rows(payload)[7]!.status = ''; }],
    ['success false on code 200', (payload: Envelope) => { payload.success = false; }],
    ['no bills list', (payload: Envelope) => { (payload.data as Record<string, unknown>).bills = 'PRIVATE'; }],
  ])('refuses %s as a schema error', (_, edit) => {
    let error: unknown;
    try { parseJnt(edited(edit), NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'schema' });
    expect(String(error)).not.toMatch(PRIVATE);
  });

  it('refuses data that is not JSON and a reply that is not an object', () => {
    expect(() => parseJnt({ ...empty, data: '{PRIVATE' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJnt([], NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reports an empty answer as absence only for a waybill Indonesia issues', () => {
    for (const number of [NUMBER, 'JD0000000001', 'JO0000000001', 'JP0000000001', 'JY0000000001']) {
      expect(() => parseJnt(empty, number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    }
    for (const number of ['JA0000000001', 'JT0000000001', 'JT0000000000001', '100000000001']) {
      expect(() => parseJnt(empty, number)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    }
    expect(() => parseJnt(edited((payload) => { payload.data.bills[0]!.details = []; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
  });

  it.each([
    [617, 'challenge'], [490, 'transport'], [500, 'indeterminate'], [999005060, 'indeterminate'],
  ])('keeps router code %s apart from absence', (code, kind) => {
    expect(() => parseJnt({ code, data: '', desc: 'PRIVATE', success: false }, NUMBER)).toThrow(expect.objectContaining({ kind }));
  });
});

describe('J&T Indonesia vocabulary', () => {
  it('maps every recorded scan code to its recorded stage', () => {
    expect(Object.fromEntries(statuses.entries.map((entry) => [entry.code, entry.stage])))
      .toEqual(Object.fromEntries(Object.entries(JNT_CODES).map(([code, mapped]) => [code, mapped.stage])));
  });
});

describe('J&T Indonesia transport', () => {
  it("sends one signed form request with the host's User-Agent, the lookup's signal and the included secret", async () => {
    const fetcher = replying(wire());
    const result = await instance(fetcher).track({ number: 'jx 0000-000001' }, { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(JNT_ROUTER);
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), cache: 'no-store', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('Host/1.0');
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(headers.get('platform')).toBe('Android');
    expect(headers.get('lang')).toBe('en');
    const time = headers.get('time')!;
    expect(time).toMatch(/^\d{13}$/);
    expect(headers.get('sign')).toBe(createHash('md5')
      .update(`interface:order.massOrderTrack,time:${time},billCodes:${NUMBER},secretKey:${JNT_SIGNING_SECRET}`).digest('hex'));
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toMatchObject({ method: 'order.massOrderTrack', v: '1.0', format: 'json', sessionid: '' });
    const data = JSON.parse(form.get('data')!) as { parameter: string };
    expect(JSON.parse(data.parameter)).toEqual({ billCodes: NUMBER, lang: 'en' });
  });

  it('answers an unknown Indonesian waybill as not found', async () => {
    await expect(instance(replying(JSON.stringify(empty))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([
    [401, 'challenge'], [403, 'challenge'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance'],
  ])('keeps HTTP %s apart from absence', async (status, kind) => {
    await expect(instance(replying('', { status })).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });

  it('passes on a rate limit with its retry window', async () => {
    const fetcher = replying('', { status: 429, headers: { 'Retry-After': '30' } });
    await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 30_000 });
  });

  it('treats a web page as a challenge and bounds odd replies', async () => {
    await expect(instance(replying('<!DOCTYPE html><html><title>Just a moment</title></html>')).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(instance(replying('x'.repeat(2_000_001))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(instance(replying('not json')).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(instance(replying('')).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each(['network', 'rate limit', 'server error', 'body read'])('drops the request, signature and waybill from a %s failure', async (mode) => {
    const privateData = `PRIVATE RECIPIENT ${NUMBER} ${JNT_SIGNING_SECRET}`;
    const fetcher: typeof fetch = async () => {
      if (mode === 'network') throw new Error(privateData);
      if (mode === 'rate limit') return new Response(privateData, { status: 429, headers: { 'Retry-After': '60' } });
      if (mode === 'server error') return new Response(privateData, { status: 502 });
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateData)); } }));
    };
    const error: unknown = await instance(fetcher).track({ number: NUMBER }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: { network: 'transport', 'rate limit': 'rate_limited', 'server error': 'indeterminate', 'body read': 'transport' }[mode] });
    if (mode === 'rate limit') expect(error).toMatchObject({ status: 429, retryAfterMs: 60_000 });
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('diagnostics');
    expect((error as Error).cause).toBeUndefined();
    const visible = `${String(error)} ${JSON.stringify(error)}`;
    expect(visible).not.toMatch(/PRIVATE|JX0000000001|sign/);
    expect(visible).not.toContain(JNT_SIGNING_SECRET);
  });

  it('recognizes an Indonesian waybill by its history and its absence', async () => {
    const number = 'JD0000000001';
    const history = replying(wire(edited((payload) => {
      payload.data.bills[0]!.billCode = number;
      for (const row of rows(payload)) row.billCode = number;
    })));
    await expect(instance(history).recognize!(number, { budgetMs: 5000 })).resolves.toMatchObject({ known: true });
    expect(history).toHaveBeenCalledOnce();
    expect(history.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    await expect(instance(replying(JSON.stringify(empty))).recognize!(number)).resolves.toMatchObject({ known: false });
    await expect(instance(replying(JSON.stringify({ code: 500, data: '', success: false }))).recognize!(number))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('answers recognition for a shape other networks share without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['100000000001', 'JT0000000000001', 'JA0000000001', 'bad']) {
      await expect(instance(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('starts no request for a number it cannot look up or an aborted lookup', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['bad', 'JX000000001', 'JX00000000012', '12345678901', 'JT000000000001']) {
      await expect(instance(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(instance(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

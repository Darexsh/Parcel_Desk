import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LION_PARCEL_API, LionParcelTracker } from './adapter.js';
import { lionParcelWording, normalizeLionParcelNumber, parseLionParcel } from './parser.js';
import { lionParcelStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '55LP0000000000001';
const IN_TRANSIT = '55LP0000000000002';
const UNKNOWN = '55LP0000000000003';

type Row = Record<string, unknown>;
type Shipment = Row & { histories: Row[] };
type Reply = Row & { data: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Lion Parcel HTTP adapter', () => {
  it('asks for the whole number in capitals as the page does, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LionParcelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 55lp 0000000000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LION_PARCEL_API}?q=${IN_TRANSIT}&captcha_token=&country=ID`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0',
        'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'lion-parcel', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history at each site’s offset, newest first, without the people named in it', () => {
    const result = parseLionParcel(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Paketmu telah sampai di tujuan & diterima', last_update: '2026-03-10T17:05:00+08:00',
      delivered_at: '2026-03-10T17:05:00+08:00', expected_delivery: null, service_name: 'REGPACK' });
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      // The destination's scans are shown in central Indonesia's zone, as the page does.
      ['2026-03-10T17:05:00+08:00', 'POD', 'delivered', 'CONTOH CITY'],
      // Scans at the same moment keep the reply's order.
      ['2026-03-10T15:50:00+08:00', 'DEL', 'out_for_delivery', 'CONTOH CITY'],
      ['2026-03-10T15:50:00+08:00', 'STI-DEST', 'in_transit', 'CONTOH CITY'],
      ['2026-03-10T00:15:00+07:00', 'CARGO PLANE', 'in_transit', 'SAMPLE CITY'],
      ['2026-03-10T00:10:00+07:00', 'STI', 'in_transit', 'SAMPLE CITY'],
      ['2026-03-09T22:30:00+07:00', 'STO-SC', 'in_transit', 'SAMPLE CITY'],
      // The repeated scan is kept once.
      ['2026-03-09T22:10:00+07:00', 'STI-SC', 'in_transit', 'SAMPLE CITY'],
      ['2026-03-09T22:10:00+07:00', 'PUP', 'in_transit', 'SAMPLE CITY'],
      ['2026-03-09T20:30:00+07:00', 'BKD', 'accepted', 'SAMPLE CITY'],
      // The pickup scans name no zone and keep the reply's UTC; their place is the sender's district.
      ['2026-03-09T08:02:10Z', 'CRROTW', 'registered', null],
      ['2026-03-09T08:00:01Z', 'CRRSRC', 'registered', null],
      ['2026-03-09T04:00:01Z', 'SHPSCD', 'registered', null],
      ['2026-03-09T01:20:00Z', 'SHPCRT', 'registered', null],
    ]);
    expect(result.events!.map((event) => event.description).filter((text) => /kurir/i.test(text!))).toEqual([
      'Paketmu diantar ke alamat penerima oleh kurir. Pastikan nomor penerima dapat dihubungi oleh kurir',
      'Kurir dalam perjalanan untuk Pick Up paketmu',
      'Mencari kurir untuk Pick Up paketmu',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Recipient|Courier|Pickup)|SAMPLE PICKUP|YBS|storage\.example|SAMPLE01|Kecamatan Sampel|Daerah Sampel|SAMPLE KELURAHAN, SAMPLE KECAMATAN, SAMPLE KOTA|CONTOH KOTA/);
  });

  it('reads a parcel on its way with its delivery window, in eastern Indonesia’s zone at the destination', () => {
    const result = parseLionParcel(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Paketmu sampai di Gudang Lion Parcel TIMUR CITY, TIMUR KELURAHAN, TIMUR KECAMATAN',
      last_update: '2026-04-22T10:20:00+09:00', expected_delivery: '2026-04-25', expected_delivery_from: '2026-04-23', service_name: 'JAGOPACK' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-04-22T10:20:00+09:00', 'STI-DEST', 'in_transit'],
      ['2026-04-22T03:40:00+07:00', 'TRANSIT', 'in_transit'],
      // A price adjustment moves nothing.
      ['2026-04-21T16:00:00+07:00', 'STT ADJUSTED', null],
      // The wait for a flight repeats each day.
      ['2026-04-21T15:10:00+07:00', 'CARGO PLANE', 'in_transit'],
      ['2026-04-20T15:10:00+07:00', 'CARGO PLANE', 'in_transit'],
      ['2026-04-20T13:00:00+07:00', 'STI', 'in_transit'],
      ['2026-04-20T11:30:00+07:00', 'PUP', 'in_transit'],
      ['2026-04-20T09:00:00+07:00', 'BKD', 'accepted'],
    ]);
  });

  it('keeps a one-day window as a day, and drops a stale or unreadable one', () => {
    const window = (value: unknown, change: (shipment: Shipment) => void = () => {}) => {
      const result = parseLionParcel(changed('in-transit', (shipment) => { shipment.estimation_date = value; change(shipment); }), IN_TRANSIT);
      return [result.expected_delivery_from ?? null, result.expected_delivery ?? null];
    };
    expect(window('2026-04-24 - 2026-04-24')).toEqual([null, '2026-04-24']);
    // A window that ended before the newest scan's day is stale.
    expect(window('2026-04-20 - 2026-04-21')).toEqual([null, null]);
    expect(window('2026-04-22 - 2026-04-22')).toEqual([null, '2026-04-22']);
    for (const value of ['', '-', '2026-04-25 - 2026-04-23', '2026-02-30 - 2026-03-01', '25/04/2026 - 26/04/2026', null]) {
      expect(window(value), String(value)).toEqual([null, null]);
    }
    // A parcel whose journey stopped has no estimate.
    expect(window('2026-04-23 - 2026-04-25', (shipment) => { shipment.current_status = 'CNX'; })).toEqual([null, null]);
  });

  it('takes the summary’s code for the stage, and the scans’ when the code says nothing', () => {
    const stage = (code: unknown, change: (shipment: Shipment) => void = () => {}) => parseLionParcel(changed('in-transit', (shipment) => {
      shipment.current_status = code;
      change(shipment);
    }), IN_TRANSIT);
    expect(stage('CLAIM')).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    expect(stage('CNX')).toMatchObject({ current_stage: 'exception' });
    expect(stage('RTS')).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(stage('DEL')).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    // A delivery the summary gives over scans that do not say it has no moment.
    expect(stage('POD')).toMatchObject({ current_stage: 'delivered' });
    expect(stage('POD')).not.toHaveProperty('delivered_at');
    // A code the map does not stage, or a price adjustment, leaves the stage to the newest staged scan.
    expect(stage('HAL')).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(stage('STT ADJUSTED')).toMatchObject({ current_stage: 'in_transit' });
    expect(stage('')).toMatchObject({ current_stage: 'in_transit' });
    // The reply's cancellation flag stands for a code the map does not know.
    expect(stage('SYNTHETIC', (shipment) => { shipment.is_cnx = true; })).toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map' });
  });

  it('keeps an older parcel the tracker lists without scans as a summary', () => {
    const summary = parseLionParcel(changed('delivered', (shipment) => { shipment.histories = null as never; }), DELIVERED);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      provider_code: 'POD', summary_only: true, events: [], expected_delivery: null, service_name: 'REGPACK' });
    expect(() => parseLionParcel(changed('delivered', (shipment) => { shipment.histories = []; shipment.current_status = ''; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('takes the courier, the person who took the parcel and phone numbers out of the wording', () => {
    expect(lionParcelWording('Paketmu diantar ke alamat penerima oleh kurir M. Sample Courier. Pastikan nomor penerima dapat dihubungi oleh kurir'))
      .toBe('Paketmu diantar ke alamat penerima oleh kurir. Pastikan nomor penerima dapat dihubungi oleh kurir');
    expect(lionParcelWording('Paketmu diantar ke alamat penerima oleh kurir LION PARCEL.')).toBe('Paketmu diantar ke alamat penerima oleh kurir.');
    expect(lionParcelWording('Paketmu gagal diantar oleh kurir Sample Courier karena alamat tidak ditemukan'))
      .toBe('Paketmu gagal diantar oleh kurir karena alamat tidak ditemukan');
    expect(lionParcelWording('Paketmu telah sampai di tujuan & diterima oleh  Sample Person (KAR)')).toBe('Paketmu telah sampai di tujuan & diterima');
    expect(lionParcelWording('Hubungi 0812-0000-0000 untuk info')).toBe('Hubungi untuk info');
    expect(lionParcelWording('Paket sedang menunggu kurir untuk diantar')).toBe('Paket sedang menunggu kurir untuk diantar');
    // A scan without a description takes its label; one without either is skipped.
    const labelled = parseLionParcel(changed('in-transit', (shipment) => { shipment.histories[0]!.description = ''; }), IN_TRANSIT);
    expect(labelled.events!.at(-1)).toMatchObject({ description: 'Diproses Agen', provider_code: 'BKD' });
    const bare = parseLionParcel(changed('in-transit', (shipment) => {
      shipment.histories[0]!.description = '';
      shipment.histories[0]!.status_label = null;
    }), IN_TRANSIT);
    expect(bare.events).toHaveLength(7);
  });

  it('keeps the reply’s offset when the site’s zone is missing or not one a clock can have', () => {
    const result = parseLionParcel(changed('in-transit', (shipment) => {
      shipment.histories[7]!.GMT = '';
      shipment.histories[6]!.GMT = 'GMT+15:00';
      shipment.histories[5]!.GMT = 'WIB';
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 3).map((event) => event.time))
      .toEqual(['2026-04-22T08:20:00+07:00', '2026-04-22T03:40:00+07:00', '2026-04-21T16:00:00+07:00']);
  });

  it('reads an unknown number as not found', () => {
    expect(() => parseLionParcel(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The echo is compared whole and in capitals.
    expect(() => parseLionParcel(changed('not-found', (shipment) => { shipment.q = UNKNOWN.toLowerCase(); }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('counts an entry only when its own STT is the number asked', () => {
    expect(() => parseLionParcel(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Lion Parcel did not answer for the number' }));
    // The tracker also finds a shipment by its booking code, under its own STT.
    expect(() => parseLionParcel(changed('in-transit', (shipment) => { shipment.q = DELIVERED; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Lion Parcel answered for another shipment' }));
    expect(() => parseLionParcel(changed('not-found', (shipment) => { shipment.stt_id = IN_TRANSIT; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLionParcel(changed('in-transit', (shipment) => { shipment.is_exist = false; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLionParcel({ data: [] }, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const both = fixture('delivered');
    both.data.push(...fixture('in-transit').data, ...fixture('not-found').data);
    expect(parseLionParcel(both, IN_TRANSIT)).toMatchObject({ service_name: 'JAGOPACK' });
    expect(() => parseLionParcel(both, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    both.data.push(fixture('in-transit').data[0]!);
    expect(() => parseLionParcel(both, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).data; },
      (_shipment: Shipment, body: Reply) => { body.data = { shipment: true } as never; },
      (_shipment: Shipment, body: Reply) => { body.data = Array.from({ length: 51 }, () => body.data[0]!); },
      (_shipment: Shipment, body: Reply) => { body.data[0] = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.q; },
      (shipment: Shipment) => { shipment.stt_id = 7; },
      (shipment: Shipment) => { shipment.is_exist = 'true'; },
      (shipment: Shipment) => { shipment.is_cnx = 1; },
      (shipment: Shipment) => { shipment.histories = 'scans' as never; },
      (shipment: Shipment) => { shipment.histories = Array.from({ length: 501 }, () => shipment.histories[0]!); },
      (shipment: Shipment) => { shipment.histories[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.histories[0]!.description = ['Diproses Agen']; },
      (shipment: Shipment) => { shipment.histories[0]!.status = 7; },
      (shipment: Shipment) => { shipment.histories[0]!.location = { city: 'SAMPLE' }; },
      (shipment: Shipment) => { shipment.histories[0]!.status_date = '2026-04-20 09:00:00'; },
      (shipment: Shipment) => { shipment.histories[0]!.status_date = '2026-04-20T09:00:00'; },
      (shipment: Shipment) => { shipment.histories[0]!.status_date = '2026-02-30T09:00:00+07:00'; },
      (shipment: Shipment) => { delete shipment.histories[0]!.status_date; },
      (shipment: Shipment) => { shipment.histories[0]!.GMT = 7; },
      (shipment: Shipment) => { shipment.current_status = ['STI']; },
      (shipment: Shipment) => { shipment.product_type = { name: 'JAGOPACK' }; },
      (shipment: Shipment) => { shipment.estimation_date = 20260425; },
    ]) {
      expect(() => parseLionParcel(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers an unknown number with HTTP 200; a moved route redirects to the home page.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=/"></head></html>',
      { status: 302, headers: { Location: '/', 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Lion Parcel</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Lion Parcel does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-10T09:05:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('SAMPLE01')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Lion Parcel does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A booking code finds the shipment on the tracker, but under its STT.
    for (const number of ['SAMPLE01', '5LP0000000000001', '55LP000000000001', '55LP00000000000001', '55XP0000000000001', `55LP${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLionParcelNumber('55lp-0000-0000-00001')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Lion Parcel, or detected as one of its STTs, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'lion-parcel' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'lion-parcel', source: 'lion-parcel', result: { current_stage: 'in_transit' } });
    await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'lion-parcel', source: 'lion-parcel' });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(`${LION_PARCEL_API}?`))).toBe(true);
  });
});

describe('Lion Parcel numbers', () => {
  it('claims the STT layout with high confidence', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'lion-parcel', confidence: 'high' });
    }
  });
});

describe('Lion Parcel status vocabulary', () => {
  it('stages every code seen with the stage its record gives', () => {
    const coded = (statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]).filter((entry) => entry.code);
    for (const entry of coded) {
      if (entry.unmapped) {
        expect(lionParcelStage(entry.code!, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'lion-parcel', providerCode: entry.code!, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(lionParcelStage(entry.code!, entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'lion-parcel', providerCode: 'STI-DEST', description: 'Paketmu sampai di Gudang Lion Parcel SAMPLE' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    // A code the map does not know falls to the shared wording rules.
    expect(lionParcelStage('SYNTHETIC', 'Paketmu sedang transit di Kota SAMPLE')).toMatchObject({ stage: 'in_transit' });
    expect(lionParcelStage('SYNTHETIC', 'Catatan sampel')).toBeNull();
  });
});

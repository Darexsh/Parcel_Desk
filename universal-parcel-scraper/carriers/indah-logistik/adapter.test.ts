import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, INDAH_LOGISTIK_API, IndahLogistikTracker } from './adapter.js';
import { normalizeIndahLogistikNumber, parseIndahLogistik } from './parser.js';
import { indahLogistikStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'ZZA1CS00000011';
const IN_TRANSIT = 'ZZB1CS000000000022';
const UNKNOWN = 'ZZC1CS00000033';

type Row = Record<string, unknown>;
type Waybill = { data_resi: Row; list_status_informasi_resi: Row[] };
type Reply = { result: Waybill[]; code: string; message: string };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
/** The lookup, answering each number from `bodies` and anything else as unknown. */
const service = (bodies: Record<string, unknown>) => vi.fn<typeof fetch>(async (_input, init) => {
  const { nomorResi } = JSON.parse(String(init?.body)) as { nomorResi: string };
  return json(bodies[nomorResi] ?? fixture('not-found'));
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseIndahLogistik>) => result.events!.map((event) =>
  [event.local_time, event.stage ?? null, event.location ?? null, event.description]);

describe('Indah Logistik HTTP adapter', () => {
  it('asks the app’s lookup for the whole number with the app’s login, through the supplied transport', async () => {
    const fetcher = service({ [IN_TRANSIT]: fixture('in-transit') });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new IndahLogistikTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' zzb1cs 0000-0000-0022 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe('https://indahonline.com/api/internal/indahonlinemobile/getresidetail?english=0');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0',
        Authorization: expect.stringMatching(/^Basic [A-Za-z0-9+/]+=*$/) } });
    expect(JSON.parse(String(init.body))).toEqual({ nomorResi: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'indah-logistik', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, with towns and without anyone’s details', () => {
    const result = parseIndahLogistik(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Paket telah diterima', last_update: null, last_update_local: '2026-03-06T15:42:08',
      service_name: 'Indah Logistic Cargo (Darat)', weight_kg: 10 });
    expect(rows(result)).toEqual([
      ['2026-03-06T15:42:08', 'delivered', null, 'Paket telah diterima'],
      // The repeated attempt is one row.
      ['2026-03-06T11:30:15', 'failed_attempt', null, 'Alamat Tidak Ditemukan / Penerima Tidak Dapat Di Hubungi'],
      ['2026-03-06T09:00:00', 'out_for_delivery', null, 'Paket sedang diantar oleh kurir'],
      // A delivery booked for a later run, without its note.
      ['2026-03-04T08:21:40', 'in_transit', null, 'PENGANTARAN TERJADWAL'],
      ['2026-03-04T08:20:30', 'out_for_delivery', null, 'Paket sedang diantar oleh kurir'],
      ['2026-03-04T07:45:12', 'in_transit', 'SAMPLE TOWN (Sample Town)', 'Paket telah sampai di gudang tujuan'],
      // Two rows at one second, in the order the lookup lists them.
      ['2026-03-03T02:10:00', 'in_transit', 'SAMPLE HUB', 'Paket telah berangkat dari gudang transit'],
      ['2026-03-03T02:10:00', 'in_transit', 'SAMPLE HUB', 'Paket telah sampai di gudang transit'],
      ['2026-03-02T18:30:05', 'in_transit', 'SAMPLE CITY', 'Paket dalam perjalanan dari gudang asal'],
      ['2026-03-02T10:02:41', 'accepted', 'SAMPLE CITY', 'Paket sudah berada di gudang asal'],
      ['2026-03-02T09:15:20', 'accepted', 'SAMPLE CITY', 'Transaksi'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.time && !event.provider_code)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Recipient|SAMPLE (?:COURIER|DRIVER|GOODS)|SAMPLE\.|YANG BERSANGKUTAN|LINTAS|0800|B 000|RGZZ|ATZZ|\*\*/);
  });

  it('reads an in-transit history by sea', () => {
    const result = parseIndahLogistik(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Paket telah sampai di gudang transit',
      last_update_local: '2026-04-13T06:05:45', service_name: 'Indah Logistic Cargo (Laut)', weight_kg: 12.5 });
    expect(rows(result).map(([, stage, location]) => [stage, location])).toEqual([
      ['in_transit', 'SAMPLE HARBOUR'], ['in_transit', 'SAMPLE PORT'], ['accepted', 'SAMPLE PORT'], ['accepted', 'SAMPLE PORT'],
    ]);
  });

  it('keeps a wording it does not know without the text after its dash, staged only by the shared rules', () => {
    const result = parseIndahLogistik(changed('in-transit', (reply) => {
      const rows = reply.result[0]!.list_status_informasi_resi;
      rows.push({ ...rows.at(-1)!, tanggal_status: '2026-04-14 10:00:00', status: 'Paket ditahan sementara - Sample Person 0800 0000 0000' });
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ local_time: '2026-04-14T10:00:00', description: 'Paket ditahan sementara' });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Paket ditahan sementara' });
    expect(indahLogistikStage('Synthetic wording')).toBeNull();
  });

  it('leaves out the service and weight the waybill does not give', () => {
    const result = parseIndahLogistik(changed('in-transit', (reply) => {
      Object.assign(reply.result[0]!.data_resi, { NAMA_JASA: '', VIA: '', BERAT: '0.00000' });
    }), IN_TRANSIT);
    expect(result).not.toHaveProperty('service_name');
    expect(result).not.toHaveProperty('weight_kg');
    expect(parseIndahLogistik(changed('in-transit', (reply) => {
      Object.assign(reply.result[0]!.data_resi, { VIA: null, BERAT: 'heavy' });
    }), IN_TRANSIT)).toMatchObject({ service_name: 'Indah Logistic Cargo' });
  });

  it('reads the lookup’s not-found answer as not found, and a waybill without rows as inconclusive', () => {
    expect(() => parseIndahLogistik(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIndahLogistik(changed('delivered', (reply) => { reply.result[0]!.list_status_informasi_resi = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps only the waybill and rows that echo the whole number asked', () => {
    expect(() => parseIndahLogistik(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Indah Logistik answered for another shipment' }));
    for (const other of [DELIVERED.slice(0, -1), `${DELIVERED}0`]) {
      expect(() => parseIndahLogistik(changed('delivered', (reply) => { reply.result[0]!.data_resi.NO_RESI = other; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The lookup echoes a resi in upper case.
    expect(parseIndahLogistik(fixture('delivered'), DELIVERED.toLowerCase())).toMatchObject({ current_stage: 'delivered' });
    // A second waybill, or a row, filed under another resi is another shipment's.
    const mixed = parseIndahLogistik(changed('in-transit', (reply) => {
      const other = fixture('delivered').result[0]!;
      reply.result.unshift(other);
      const rows = reply.result[1]!.list_status_informasi_resi;
      rows.push({ ...rows.at(-1)!, no_resi: UNKNOWN, tanggal_status: '2026-04-20 10:00:00', status: 'Paket telah diterima - Someone' });
    }), IN_TRANSIT);
    expect(mixed).toMatchObject({ current_stage: 'in_transit', service_name: 'Indah Logistic Cargo (Laut)' });
    expect(mixed.events).toHaveLength(4);
    expect(() => parseIndahLogistik(changed('in-transit', (reply) => {
      for (const row of reply.result[0]!.list_status_informasi_resi) row.no_resi = UNKNOWN;
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Indah Logistik answered for another shipment' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (reply: Reply) => { (reply as Row).result = 'waybills'; },
      (reply: Reply) => { delete (reply as Row).result; },
      (reply: Reply) => { reply.code = '500'; },
      (reply: Reply) => { reply.code = '403'; reply.result = []; reply.message = 'Parameter Tidak Lengkap.'; },
      (reply: Reply) => { reply.result = []; },
      (reply: Reply) => { reply.code = '203'; },
      (reply: Reply) => { reply.result[0] = 'waybill' as never; },
      (reply: Reply) => { (reply.result[0] as Row).data_resi = null; },
      (reply: Reply) => { (reply.result[0] as Row).list_status_informasi_resi = 'scans'; },
      (reply: Reply) => { reply.result[0]!.list_status_informasi_resi = Array.from({ length: 501 }, () => reply.result[0]!.list_status_informasi_resi[0]!); },
      (reply: Reply) => { reply.result[0]!.list_status_informasi_resi[0] = 'scan' as never; },
      (reply: Reply) => { reply.result[0]!.list_status_informasi_resi[0]!.tanggal_status = '2026-03-02T09:15:20+07:00'; },
      (reply: Reply) => { reply.result[0]!.list_status_informasi_resi[0]!.tanggal_status = '2026-02-30 09:15:20'; },
      (reply: Reply) => { reply.result[0]!.list_status_informasi_resi[0]!.tanggal_status = '2026-03-02 24:00:00'; },
      (reply: Reply) => { delete reply.result[0]!.list_status_informasi_resi[0]!.tanggal_status; },
      (reply: Reply) => { reply.result[0]!.list_status_informasi_resi[0]!.status = ''; },
      (reply: Reply) => { reply.result[0]!.list_status_informasi_resi[0]!.status = ['Transaksi']; },
    ]) {
      expect(() => parseIndahLogistik(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseIndahLogistik('[]', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A waybill without its rows is a waybill without history.
    expect(() => parseIndahLogistik(changed('delivered', (reply) => {
      delete (reply.result[0] as Row).list_status_informasi_resi;
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps an unknown number, a moved route, a refused login, a rate limit, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => json({ result: [], code: '208', message: 'Failed Authentication' }, { status: 401 })))
      .rejects.toMatchObject({ kind: 'challenge', status: 401 });
    await expect(lookup(() => json({ result: [], code: '208', message: 'Failed Authentication' }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json({ result: [], code: '403', message: 'Parameter Tidak Lengkap.' }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response('<html><title>Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://indahonline.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    await expect(lookup(() => new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    // The site's own pages load Turnstile for its form; one in place of the reply is a changed route.
    await expect(lookup(() => new Response('<html><title>Cek Resi</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js">'
      + '</script><div class="cf-turnstile"></div></html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(fixture('delivered')))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number by its rows and an unknown one by the not-found answer', async () => {
    const fetcher = service({ [DELIVERED]: fixture('delivered') });
    const indah = carrier(fetcher);
    // The rows' wall clocks name no zone, so they date the last activity without an instant.
    await expect(indah.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-06T15:42:08' });
    await expect(indah.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(indah.recognize!('ZZ1CS00000011')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Indah Logistik does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ1CS00000011', '1ZZ1CS00000011', 'ZZA1CS0000001A', 'ZZA1CS00011', `ZZA1CS${'0'.repeat(20)}`, `ZZA${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeIndahLogistikNumber('zza-1cspl 0000 0000 0044')).toBe('ZZA1CSPL000000000044');
    // The shorter shapes a news guide printed still reach the lookup, which decides.
    expect(normalizeIndahLogistikNumber('ZZACS0000001')).toBe('ZZACS0000001');
  });

  it('tries once more after a failed connection, and ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return json(fixture('delivered'));
    });
    await clock.settle(expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' }));
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a detected resi to the adapter', async () => {
    const fetcher = service({ [DELIVERED]: fixture('delivered') });
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'indah-logistik', source: 'indah-logistik', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === INDAH_LOGISTIK_API)).toBe(true);
  });
});

describe('Indah Logistik numbers', () => {
  it('names Indah Logistik for its resi layouts, and leaves the shorter shapes the lookup does not know', () => {
    for (const number of [DELIVERED, IN_TRANSIT, 'ZZA1CSPL000000000044']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'indah-logistik', confidence: 'high' });
    }
    for (const number of ['ZZA1CS0000001', 'ZZACS0000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('indah-logistik');
      expect(recognitionAskedCarriers(number), number).not.toContain('indah-logistik');
    }
  });
});

describe('Indah Logistik status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(indahLogistikStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'indah-logistik', providerCode: null, description: 'Paket telah diterima' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'indah-logistik', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });
});

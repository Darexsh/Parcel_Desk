import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SAPX_ENDPOINT, SapxTracker } from './adapter.js';
import { parseSapx } from './parser.js';
import { sapxMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'CGK8000000000017';
const TRANSIT = 'VXQ00000000017';
// A Tokopedia booking code, printed `TKP01-AB12CD34`.
const RETURNED = 'TKP01AB12CD34';
const UNKNOWN = 'CGK0000000000001';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseSapx>) => result.events!.map((event) => [event.local_time, event.description, event.stage]);
// One event of the history, as the page renders it.
const STEP = /<div class="process-step">[\s\S]*?<\/p>\s*<\/div>\s*<\/div>/g;
// The in-transit page with its newest event replaced.
const scan = (heading: string, remark = '') => page('in-transit')
  .replace(/Dalam Perjalanan ke Kantor Hub\s+Selanjutnya\s*<\/h4>\s*<p class="">\s*<\/p>/, `${heading}</h4><p class="">${remark}</p>`);
const CAPTCHA = '<html><body><form method="POST"><div class="g-recaptcha" data-sitekey="synthetic"></div></form></body></html>';
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'interactive\'};</script></body></html>';
const PRIVATE = ['Budi', 'Rekaan', 'Andi', 'Penerima', 'Ibu ', 'Bpk', '0812', 'Kurir:', 'Keterangan', 'Hubungi', 'Staff', 'Desa Fiktif',
  'Kota Contoh,', 'Return To Client', 'Kab ]', '(021)'];

describe('SAPX Express tracking adapter', () => {
  it('asks the result page once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SapxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cgk 800-000 000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.sapx.id/id/cek-awb/${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sapx-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('asks for a Tokopedia booking code with its dash, as the tracker holds it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('returned')));
    await expect(carrier(fetcher).track({ number: 'tkp01ab12cd34' })).resolves.toMatchObject({ current_stage: 'returned' });
    await expect(carrier(fetcher).track({ number: 'TKP01-AB12CD34' })).resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${SAPX_ENDPOINT}TKP01-AB12CD34`, `${SAPX_ENDPOINT}TKP01-AB12CD34`]);
  });

  it('reads a delivery newest first as wall clocks, without the receiver, the courier, the remarks or the route', () => {
    const result = parseSapx(page('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Paket Telah Diterima', last_update: null, last_update_local: '2026-03-09T17:56:00', expected_delivery: null,
      service_name: 'SATRIA ODS',
      events: [
        { local_time: '2026-03-09T17:56:00', description: 'Paket Telah Diterima', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T08:15:00', description: 'Paket Diantar Kurir Satria', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-08T10:48:00', location: 'Kabupaten Fiktif', description: 'Sampai di Kantor Cabang Kabupaten Fiktif',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-08T10:35:00', description: 'Incoming Smu', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-07T23:53:00', description: 'Dalam Perjalanan ke Kantor Hub Selanjutnya', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-07T23:04:00', description: 'Multi Bagging Cmo', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-07T21:51:00', description: 'Keluar dari Kantor Pusat', stage: 'in_transit', stage_source: 'carrier_map' },
        // The head office the check-in remark names is no place.
        { local_time: '2026-03-07T21:10:00', description: 'Verifikasi Paket', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('reads a parcel on its way by its scans, not by a summary cut short', () => {
    const result = parseSapx(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Dalam Perjalanan ke Kantor Hub Selanjutnya', last_update: null, last_update_local: '2025-12-31T00:55:00',
      service_name: 'SATRIA REG' });
    expect(rows(result)).toEqual([
      ['2025-12-31T00:55:00', 'Dalam Perjalanan ke Kantor Hub Selanjutnya', 'in_transit'],
      ['2025-12-30T23:27:00', 'Multi Bagging Cmo', 'in_transit'],
      ['2025-12-30T23:25:00', 'Keluar dari Kantor Pusat', 'in_transit'],
      ['2025-12-30T22:04:00', 'Verifikasi Paket', 'accepted'],
    ]);
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('reads a failed run and a return, keeping each scan once with its code, its reason and its office', () => {
    const result = parseSapx(page('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Paket Telah Dikembalikan', last_update_local: '2026-02-02T14:25:00', service_name: 'SATRIA REG' });
    expect(rows(result)).toEqual([
      ['2026-02-02T14:25:00', 'Paket Telah Dikembalikan', 'returned'],
      ['2026-01-30T09:40:00', 'Paket Diantar Kurir untuk Dikembalikan', 'returned'],
      ['2026-01-14T21:52:00', 'Shipment Hold', 'exception'],
      ['2026-01-14T21:51:00', 'Serah Terima Paket dari Kurir ke Kantor Hub', 'in_transit'],
      ['2026-01-14T16:04:00', 'Paket Belum Berhasil Terkirim: Pindah', 'failed_attempt'],
      ['2026-01-14T09:04:00', 'Paket Diantar Kurir Satria', 'out_for_delivery'],
      ['2026-01-13T10:07:00', 'Sampai di Kantor Cabang Kabupaten Fiktif', 'in_transit'],
      ['2026-01-12T14:02:00', 'Keluar dari Kantor Pusat', 'in_transit'],
      ['2026-01-12T08:26:00', 'Sampai di Kantor Pusat', 'in_transit'],
      ['2026-01-12T02:09:00', 'Keluar dari Kantor Cabang Kota Contoh Barat', 'in_transit'],
      ['2026-01-12T01:05:00', 'Verifikasi Paket', 'accepted'],
      ['2026-01-11T22:18:00', 'Paket Telah Dipick Up', 'accepted'],
      ['2026-01-11T16:08:00', 'Sedang Dipick Up', 'registered'],
    ]);
    expect(result.events!.map((event) => [event.provider_code, event.location])).toEqual([
      ['DL', undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], ['O1', undefined], [undefined, undefined],
      [undefined, 'Kabupaten Fiktif'], [undefined, undefined], [undefined, undefined], [undefined, 'Kota Contoh Barat'],
      // A check-in takes the office its remark names.
      [undefined, 'Kota Contoh Barat'], [undefined, undefined], [undefined, undefined],
    ]);
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('drops who took the parcel and phone numbers from a heading, and a reason that is not a plain label', () => {
    expect(parseSapx(scan('Paket Telah Diterima oleh Ibu Rekaan 0812 0000 0000 (Keluarga)'), TRANSIT).events![0])
      .toEqual({ local_time: '2025-12-31T00:55:00', description: 'Paket Telah Diterima', stage: 'delivered', stage_source: 'carrier_map' });
    expect(parseSapx(scan('Paket Belum Berhasil Terkirim', '[kurir: Andi Contoh] [status: Undelivered - N1 - Hubungi 0812-0000-0000] - Keterangan: Bu Rekaan'),
      TRANSIT).events![0]).toEqual({ local_time: '2025-12-31T00:55:00', description: 'Paket Belum Berhasil Terkirim', provider_code: 'N1',
      stage: 'failed_attempt', stage_source: 'carrier_map' });
    // A heading's branch without a name, or with digits in it, is no place.
    for (const heading of ['Sampai di Kantor Cabang', 'Sampai di Kantor Cabang Jl Contoh 1234']) {
      expect(parseSapx(scan(heading), TRANSIT).events![0]!.location, heading).toBeUndefined();
    }
  });

  it('stages an unknown heading by the shared rules, or leaves it without a stage, and falls back on the summary', () => {
    const shared = parseSapx(scan('Shipment delivered'), TRANSIT);
    expect(shared).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language' });
    const unknown = parseSapx(scan('Catatan Gudang'), TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Catatan Gudang' });
    expect(unknown.events![0]).toEqual({ local_time: '2025-12-31T00:55:00', description: 'Catatan Gudang' });
    const bare = page('in-transit').replace(/Dalam Perjalanan ke Kantor Hub\s+Selanjutnya|Multi Bagging Cmo|Keluar dari Kantor Pusat|Verifikasi Paket/g, 'Catatan Gudang');
    const unstaged = parseSapx(bare, TRANSIT);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Catatan Gudang' });
    expect(unstaged.current_stage).toBeUndefined();
    expect(parseSapx(bare.replace(/Sampai di\s*<\/td>/, 'Dalam Perjalanan ke Kantor Hub</td>'), TRANSIT))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
  });

  it('turns an oldest-first history round', () => {
    const html = page('delivered');
    const steps = html.match(STEP)!;
    expect(steps).toHaveLength(8);
    let reversed = html;
    steps.forEach((step, index) => { reversed = reversed.replace(step, `@@${index}@@`); });
    steps.forEach((_, index) => { reversed = reversed.replace(`@@${index}@@`, steps[steps.length - 1 - index]!); });
    expect(parseSapx(reversed, DELIVERED)).toEqual(parseSapx(html, DELIVERED));
  });

  it('binds the page to the requested number and rejects pages it cannot read', () => {
    expect(() => parseSapx(page('delivered'), 'CGK8000000000018')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSapx(page('returned'), 'TKP01AB12CD35')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker echoes the number as it was typed.
    expect(parseSapx(page('in-transit').replace(`Nomor Resi: ${TRANSIT}`, 'Nomor Resi: vxq00000000017'), TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
    const table = page('delivered').match(/<table[\s\S]*?<\/table>/)![0];
    const step = page('delivered').match(STEP)![0];
    for (const html of [
      page('delivered').replace(table, table + table),
      page('delivered').replace('09 Mar 2026 | 17:56', '09 Mar 2026 | 24:10'),
      page('delivered').replace('09 Mar 2026 | 17:56', '31 Feb 2026 | 17:56'),
      page('delivered').replace('09 Mar 2026 | 17:56', '09 Xyz 2026 | 17:56'),
      page('delivered').replace('09 Mar 2026 | 17:56', '2026-03-09 17:56'),
      page('delivered').replace(/<span class="text-success">Paket Telah Diterima oleh[\s\S]*?<\/span>/, ''),
      page('delivered').replace(/<h4 class="mb-0 text-3 font-weight-semi-bold">\s*09 Mar 2026 \| 17:56\s*<\/h4>/, ''),
      page('delivered').replace('<p class="">', '<p class=""></p><p class="">'),
      page('delivered').replace(step, step.repeat(301)),
      page('not-found').replace('Nomor Resi Anda Tidak Ditemukan', 'Layanan sedang tidak tersedia'),
      '<html><body>Pemeliharaan</body></html>']) {
      expect(() => parseSapx(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A table without a single event is a shipment without history.
    expect(() => parseSapx(page('delivered').replace(STEP, ''), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('reads only the tracker’s notice as a missing shipment, and a bot check as a challenge', () => {
    expect(() => parseSapx(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const html of [CAPTCHA, CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseSapx(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes eight to twenty-four letters and digits only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234567', 'ABCDEFGHIJ', 'CGK800000000001700000000017', 'CGK8000/0000017', '', `CGK${'0'.repeat(62)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the notice for an unknown number as not found and recognizes a known shipment, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('in-transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2025-12-31T00:55:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A page for another number is no answer either way.
    await expect(carrier(fetcher).recognize!('VXQ00000000018')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    for (const html of [CAPTCHA, CHALLENGE]) {
      const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(html));
      await expect(carrier(challenged).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
      await expect(carrier(challenged).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    }
    const redirected = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302,
      headers: { Location: 'https://www.sapx.id/id/cek-awb' } }));
    await expect(carrier(redirected).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(redirected).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '  ']) {
      const empty = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(empty).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(empty).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('not-found')));
    await expect(carrier(flaky).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('not-found')));
    await expect(carrier(immediate).track({ number: UNKNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: UNKNOWN }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes its links to the adapter, and claims no number layout', async () => {
    for (const number of [DELIVERED, TRANSIT, RETURNED, '800000000017']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('sapx-express');
      expect(recognitionAskedCarriers(number), number).not.toContain('sapx-express');
    }
    for (const link of [`https://www.sapx.id/id/cek-awb/${DELIVERED}`, `https://www.sap-express.id/layanan/tracking/details/${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'sapx-express', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'sapx-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'sapx-express', source: 'sapx-express', result: { current_stage: 'delivered' } });
    expect(answer.result.receiver_name).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(SAPX_ENDPOINT))).toBe(true);
  });
});

describe('SAPX Express status vocabulary', () => {
  it('records every heading the map knows, and every code under the heading it comes with, with the stage it gives', () => {
    for (const entry of statuses.entries) {
      if ('code' in entry) {
        // A code only comes in a run's remark, under the heading that stages it.
        const heading = /^undelivered/i.test(entry.wording) ? 'Paket Belum Berhasil Terkirim' : 'Paket Telah Dikembalikan';
        const event = parseSapx(scan(heading, `[kurir: ] [penerima: ] [hub: ] [status: ${entry.wording}]`), TRANSIT).events![0]!;
        expect(event, entry.wording).toMatchObject({ provider_code: entry.code, stage: entry.stage, stage_source: 'carrier_map' });
        continue;
      }
      expect(sapxMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(parseSapx(scan(entry.wording), TRANSIT).events![0]!.stage, entry.wording).toBe(entry.stage);
    }
    expect(sapxMappedStage('  PAKET belum berhasil terkirim: Sulit Ditemui ')).toBe('failed_attempt');
    for (const wording of ['constructor', 'toString', 'Paket', 'Paket Diantarkan', 'Sampai di', 'Shipment']) {
      expect(sapxMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMapAnswer({ carrier: 'sapx-express', providerCode: 'O1', description: 'Paket Belum Berhasil Terkirim: Pindah' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
  });
});

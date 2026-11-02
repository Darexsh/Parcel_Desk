import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PTT_ENDPOINT, PttTracker } from './adapter.js';
import { parsePtt } from './parser.js';
import { pttScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'KP99000000001';
const COLLECTED = '9900000000001';
const RETURNED = 'KP99000000002';
const ABROAD = 'ZZ000000005TR';
const ABSENT = 'KP99999999999';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
const reply = (body: string, status = 200, headers: Record<string, string> = { 'Content-Type': 'application/json;charset=UTF-8' }) =>
  new Response(body, { status, headers });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

type Row = { IMERK: string; ISAAT: string; ISLEM: string; ITARIH: string; siraNo: number };
type Reply = { BARNO?: unknown; GR?: string; sonucKodu: unknown; sonucAciklama?: string; dongu?: Row[] };
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name) as Reply;
  change(payload);
  return payload;
};
const rows = (result: ReturnType<typeof parsePtt>) =>
  result.events!.map(event => [event.local_time, event.description, event.location, event.stage]);

describe('PTT tracking adapter', () => {
  it('posts the whole barcode once as JSON through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PttTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' kp 9900 0000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://pttreklamws.ptt.gov.tr/PttBirlesikMobil/takip/gonderiSorgulav2');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Accept-Language': 'tr', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ barkod: DELIVERED });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ptt', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first, as wall clocks, without the names the reply masks', () => {
    const result = parsePtt(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'TESLİM EDİLDİ', last_update: null, last_update_local: '2026-03-06T16:40:05', expected_delivery: null,
      weight_kg: 1.25 });
    // The repeated transfer scan appears once, and empty place separators are dropped.
    expect(rows(result)).toEqual([
      ['2026-03-06T16:40:05', 'TESLİM EDİLDİ', 'ÖRNEKKÖY ŞUBE ÖRNEKİL-MERKEZ', 'delivered'],
      ['2026-03-06T09:12:41', 'DAĞITIMDA', 'ÖRNEKKÖY ŞUBE ÖRNEKİL-MERKEZ', 'out_for_delivery'],
      ['2026-03-05T22:03:10', 'PTT İşyerine Girdi:PTT İşyerinden Çıktı İL İÇİ AKTARMADA', 'ÖRNEKİL PDM - ÖRNEKİL-MERKEZ', 'in_transit'],
      ['2026-03-05T04:18:34', 'TRANSFER SÜRECİNDE', 'DEMO PKİM', 'in_transit'],
      ['2026-03-04T15:28:40', 'KABUL EDİLDİ', 'DEMO KABUL ŞUBE DEMOİL-YENİİLÇE', 'accepted'],
    ]);
    expect(result.pickup_point).toBeUndefined();
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
    for (const name of ['delivered', 'collected', 'returned', 'abroad']) {
      const number = { delivered: DELIVERED, collected: COLLECTED, returned: RETURNED, abroad: ABROAD }[name]!;
      const serialized = JSON.stringify(parsePtt(fixture(name), number));
      expect(serialized, name).not.toContain('*');
      expect(serialized, name).not.toContain('DEMO KABUL"');
    }
  });

  it('names the office a parcel was collected from, and the one it waits at', () => {
    const collected = parsePtt(fixture('collected'), COLLECTED);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', pickup_point: 'ÖRNEKKÖY ŞUBE ÖRNEKİL-MERKEZ',
      weight_kg: 0.3 });
    expect(rows(collected).slice(1, 3)).toEqual([
      ['2026-03-10T17:45:12', 'PTT İŞYERİNDE', 'ÖRNEKKÖY ŞUBE ÖRNEKİL-MERKEZ', 'ready_for_pickup'],
      ['2026-03-10T12:15:14', 'TESLİM EDİLEMEDİ Adreste Yok/Kapalı-Haber Kağıdı Bırakıldı', 'ÖRNEKKÖY ŞUBE ÖRNEKİL-MERKEZ', 'failed_attempt'],
    ]);
    const waiting = parsePtt(edited('collected', payload => { payload.dongu!.shift(); }), COLLECTED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'ÖRNEKKÖY ŞUBE ÖRNEKİL-MERKEZ' });
    // Brought to the door after a failed attempt: no pickup point.
    const door = parsePtt(edited('collected', payload => { payload.dongu!.splice(1, 1); }), COLLECTED);
    expect(door).toMatchObject({ current_stage: 'delivered' });
    expect(door.pickup_point).toBeUndefined();
  });

  it('reads a return and the office holding it as such, not as a delivery or a pickup', () => {
    const result = parsePtt(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'PTT İŞYERİNDE (MEVKUF) Elde Kalmış Gönderi', weight_kg: 1.016 });
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result).slice(0, 3).map(row => row[3])).toEqual(['exception', 'returned', 'ready_for_pickup']);
    expect(parsePtt(edited('returned', payload => { payload.dongu!.splice(0, 1); }), RETURNED))
      .toMatchObject({ current_stage: 'returned', last_status_text: 'İADE Tanınmıyor' });
  });

  it('keeps a foreign post’s relayed events on their own clocks and names the country without an offset', () => {
    const result = parsePtt(fixture('abroad'), ABROAD);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-04-08T11:32:00',
      weight_kg: 0.076 });
    expect(rows(result).slice(0, 6)).toEqual([
      ['2026-04-08T11:32:00', 'Gonderi teslim edildi (Gelen) TESLİM EDİLDİ', 'Examplestan', 'delivered'],
      ['2026-04-08T11:27:00', 'Teslim girisiminde bulunuldu veya Teslim edilemedi (Gelen) TESLİM EDİLEMEDİ', 'Examplestan', 'failed_attempt'],
      ['2026-04-08T06:53:00', 'Gonderi teslim merkezinde alindi (Gelen) TRANSFER SÜRECİNDE Gonderi teslim merkezinde alindi', 'Examplestan',
        'in_transit'],
      ['2026-04-06T22:08:00', 'Gonderi gumrukten çıktı (Gelen) TRANSFER SÜRECİNDE Gönderi gümrükten çıktı', 'Examplestan', 'in_transit'],
      ['2026-04-06T21:57:00', 'Gonderi gumruge sevk edildi (Gelen) TRANSFER SÜRECİNDE Gönderi Gümrüğe Sevk Edildi', 'Examplestan', 'customs'],
      ['2026-04-02T10:18:00', 'Gönderi Yurt Içi Merkezine Sevk Edildi TRANSFER SÜRECİNDE Yurticinde sevk edildi', 'Examplestan', 'in_transit'],
    ]);
  });

  it('orders shuffled movements by clock, keeps equal clocks in PTT’s order and reads clocks without seconds', () => {
    const result = parsePtt(fixture('collected'), COLLECTED);
    const shuffled = edited('collected', payload => { payload.dongu!.reverse(); });
    expect(parsePtt(shuffled, COLLECTED).events).toEqual(result.events);
    const tied = edited('collected', payload => {
      payload.dongu![2] = { ...payload.dongu![2]!, ISAAT: '17:45' };
      payload.dongu![1] = { ...payload.dongu![1]!, ISAAT: '17:45' };
      payload.dongu!.reverse();
    });
    expect(parsePtt(tied, COLLECTED).events!.slice(1, 3).map(event => [event.local_time, event.stage])).toEqual([
      ['2026-03-10T17:45:00', 'ready_for_pickup'], ['2026-03-10T17:45:00', 'failed_attempt']]);
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const unknown = parsePtt(edited('delivered', payload => { payload.dongu![0]!.ISLEM = ' TARTILDI  '; }), DELIVERED);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'TARTILDI' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-06T16:40:05', description: 'TARTILDI', location: 'ÖRNEKKÖY ŞUBE ÖRNEKİL-MERKEZ' });
    // An unknown weight is left out.
    expect(parsePtt(edited('delivered', payload => { payload.GR = '1,2'; }), DELIVERED).weight_kg).toBeUndefined();
  });

  it('binds the reply to the whole requested barcode and rejects malformed histories', () => {
    expect(() => parsePtt(fixture('delivered'), RETURNED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePtt(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const many = Array.from({ length: 501 }, (_, index) => ({ IMERK: 'DEMO PKİM', ISAAT: '10:00:00', ISLEM: ' TRANSFER SÜRECİNDE  ',
      ITARIH: '01/03/2026', siraNo: index }));
    for (const payload of [null, [], {}, { sonucKodu: '0' }, { sonucKodu: 0.5 },
      edited('delivered', reply => { delete reply.BARNO; }),
      edited('delivered', reply => { reply.BARNO = 99000000001; }),
      edited('delivered', reply => { reply.BARNO = `${DELIVERED} ${RETURNED}`; }),
      edited('delivered', reply => { delete reply.dongu; }),
      edited('delivered', reply => { reply.dongu = many; }),
      edited('delivered', reply => { reply.dongu![2]!.ISAAT = '25:61:00'; }),
      edited('delivered', reply => { reply.dongu![2]!.ITARIH = '2026-03-05'; }),
      edited('delivered', reply => { reply.dongu![2]!.ITARIH = '31/02/2026'; }),
      edited('delivered', reply => { reply.dongu![2]!.ISLEM = ' / Z**** Y****'; }),
      edited('delivered', reply => { (reply.dongu as unknown[])[2] = 'scan'; }),
      edited('delivered', reply => { (reply.dongu![2] as { ISLEM: unknown }).ISLEM = 7; })]) {
      expect(() => parsePtt(payload, DELIVERED), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the service’s no-movement notice as a missing item', () => {
    expect(() => parsePtt(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const english = edited('not-found', reply => { reply.sonucAciklama = 'No tracking history found for the entered barcode.'; });
    expect(() => parsePtt(english, ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePtt(fixture('invalid'), ABSENT)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    for (const payload of [edited('not-found', reply => { reply.sonucAciklama = 'Sistem hatası.'; }),
      edited('not-found', reply => { reply.sonucKodu = 3; }),
      edited('not-found', reply => { reply.sonucKodu = -1; }),
      edited('delivered', reply => { reply.dongu = []; reply.BARNO = ABSENT; })]) {
      expect(() => parsePtt(payload, ABSENT), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('takes KP numbers, thirteen-digit barcodes and S10 codes with a valid check digit, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000006TR', 'KP9900000000', 'KP990000000011', '990000000000', '99000000000011', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { barkod } = JSON.parse(String(init!.body)) as { barkod: string };
      return reply(text('not-found').replace(ABSENT, barkod));
    });
    for (const number of [ABROAD, 'RR000000014DE', COLLECTED]) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('recognizes a known parcel and the no-movement notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-06T16:40:05' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[302, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: 'Sayfalar/Anasayfa.aspx' } })
        : reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages, empty and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>', 'challenge'],
      ['<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>', 'challenge'],
      ['<html><body>Bakım çalışması</body></html>', 'schema'], ['', 'indeterminate'], ['  ', 'indeterminate'],
      ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, 200, { 'Content-Type': 'text/html' }));
      await expect(carrier(fetcher).recognize!(DELIVERED), body).rejects.toMatchObject({ kind });
    }
    const bom = vi.fn<typeof fetch>().mockResolvedValue(reply(`\uFEFF${text('delivered')}`));
    await expect(carrier(bom).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under PTT to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'ptt' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ptt', source: 'ptt', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === PTT_ENDPOINT)).toBe(true);
  });

  it('owns KP numbers and is asked about Turkish S10 codes, which detection leaves with the postal fallback', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'ptt', confidence: 'high' });
    expect(detectCarrierMatch(ABROAD)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(ABROAD)[0]).toBe('ptt');
    expect(recognitionAskedCarriers('ZZ000000006TR')).not.toContain('ptt');
    expect(recognitionAskedCarriers('RR000000014DE')).not.toContain('ptt');
  });
});

describe('PTT status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(pttScanStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(stage);
    }
    expect(pttScanStage('İl   İçi Aktarmada')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'PTT İşyerine Girdi', 'PTT İşyerinden Çıktı', 'Yurtdışına Sevk Edildi', 'TESLİMAT']) {
      expect(pttScanStage(wording), wording).toBeUndefined();
    }
    expect(pttScanStage('İADE TESLİM EDİLDİ')).toBe('returned');
    expect(statusMap.stage('7', 'teslim edildi')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'ptt', description: 'PTT İŞYERİNDE' })).toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HEPSIJET_API, HepsijetTracker } from './adapter.js';
import { hepsijetWording, normalizeHepsijetNumber, parseHepsijet } from './parser.js';
import { hepsijetStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ4DLVR0001HJ';
const IN_TRANSIT = 'ZZ00000000000014';
const RETURNED = 'ZZRTN00000000003';
const PICKUP = 'ZZPKP0000004';
const UNKNOWN = 'ZZ0000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { transactions: Row[] };
type Reply = Row & { data: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The security page Hepsiburada's Akamai edge serves to clients it refuses.
const SECURITY_PAGE = '<!DOCTYPE html><html lang="en"><head><title>Hepsiburada | Güvenlik</title></head><body>'
  + '<iframe src="https://static.hepsiburada.net/security/HBBlockandCaptcha.html?AKReferanceId=0.0"></iframe></body></html>';

describe('HepsiJET HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HepsijetTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz00-0000-0000-0014 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HEPSIJET_API}?customerDeliveryNo=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hepsijet', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s instant with its offset, newest first, and stages it by its delivery status', () => {
    const result = parseHepsijet(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Transfer Sürecinde', last_update: '2026-04-02T01:17:16+03:00', expected_delivery: '2026-04-03',
      service_name: 'Standart Teslimat' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location, event.description])).toEqual([
      ['2026-04-02T01:17:16+03:00', 'TRANSFERRING_TRANSFER', 'in_transit', 'Batıkent Tm Aktarma Merkezi', 'Transfer Sürecinde'],
      ['2026-04-01T22:41:09+03:00', 'READY', 'in_transit', 'Doğukent Tm Aktarma Merkezi', 'Transfer Merkezine Ulaştı'],
      ['2026-04-01T20:20:00+03:00', 'TRANSFERRING_COLLECT', 'in_transit', 'Doğukent Tm Aktarma Merkezi', 'Transfer Sürecinde'],
      ['2026-04-01T12:06:31+03:00', 'COLLECTED', 'accepted', 'Doğuköy Dağıtım Merkezi', 'Gönderi Alındı'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps the delivery without the recipient, their address, who took the parcel or the repeated scan', () => {
    const result = parseHepsijet(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Teslim edildi', last_update: '2026-03-12T16:41:05+03:00', delivered_at: '2026-03-12T16:41:05+03:00',
      expected_delivery: null, service_name: 'Standart Teslimat' });
    expect(result.events).toHaveLength(6);
    expect(result.events!.slice(0, 3).map((event) => [event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      // "With the recipient" is no place.
      ['DELIVERED', 'delivered', null, 'Teslim edildi'],
      ['DELIVERING', 'out_for_delivery', 'Örnekköy Dağıtım Merkezi', 'Kurye Dağıtıma Çıktı'],
      ['DISPATCHING', 'in_transit', 'Örnekköy Dağıtım Merkezi', 'Teslimat Şubesinde'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:P|Shop)|S\*\*\*\*\*|Kendi|ÖRNEKKÖY|Örnekşehir|SAMPLE|1000001|Alıcıda/);
  });

  it('reads a parcel sent back to its sender as returned, with the reason it was not delivered', () => {
    const result = parseHepsijet(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Satıcıya iade edildi', last_update: '2026-05-08T10:31:00+03:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      // Two scans at one clock keep the reply's order, newest last there.
      ['DELIVERED', 'returned', null, 'Satıcıya iade edildi'],
      ['DELIVERED', 'returned', null, 'İade Edildi'],
      ['TRANSFERRING_RETURN', 'returned', null, 'Transfer Merkezine Ulaştı'],
      ['TRANSFERRING_TRANSFER', 'in_transit', 'Kıyıkent Tm Aktarma Merkezi', 'Transfer Sürecinde'],
      ['UNDELIVERED', 'failed_attempt', 'Kıyıköy Dağıtım Merkezi', 'Teslim Edilemedi: Hasarlı'],
      ['TRANSFERRING_TRANSFER', 'in_transit', 'Kıyıkent Tm Aktarma Merkezi', 'Transfer Sürecinde'],
      ['COLLECTED', 'accepted', 'Merkezköy Dağıtım Merkezi', 'Gönderi Alındı'],
    ]);
  });

  it('reads a customer’s return from its booking to the branch, without the customer or an estimate', () => {
    const result = parseHepsijet(fixture('return-pickup'), PICKUP);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Dağıtım Merkezine Ulaştı',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      ['COLLECTED', 'accepted', 'Tepeköy Dağıtım Merkezi', 'Dağıtım Merkezine Ulaştı'],
      // "In the delivery van" is no place, and the person who handed the return over is dropped.
      ['COLLECTED', 'accepted', null, 'Teslim Alındı'],
      ['COLLECTING', 'registered', null, 'Teslim Almaya Çıktı'],
      ['WAITING_FOR_DISPATCH', 'registered', null, 'Teslim Alma Randevusu Oluşturuldu'],
      ['WAITING_FOR_DISPATCH', 'registered', null, 'İade Siparişi Alındı'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample Kişi|Örnek \(|S\*\*\*\*\*|SAMPLE_MERCHANT/);
    const failed = parseHepsijet(changed('return-pickup', (shipment) => {
      shipment.transactions = shipment.transactions.slice(0, 3);
      shipment.transactions.push({ deliveryStatus: 'UNABLE_TO_COLLECT', operationStatus: 'IN_CUSTOMER', transactionType: 'COLLECT_ATTEMPT',
        transactionDateTime: '2026-06-02T11:54:05+03:00', nonDeliveryReturnReason: 'REFUSED',
        nonDeliveryReturnReasonMessage: 'Alıcı İade\'den vazgeçmiş', transaction: 'Teslim alınamadı' });
    }), PICKUP);
    expect(failed).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Teslim alınamadı: Alıcı İade\'den vazgeçmiş' });
  });

  it('reads a clock without an offset in Istanbul and skips the estimate it cannot read', () => {
    const result = parseHepsijet(changed('in-transit', (shipment) => {
      shipment.transactions.at(-1)!.transactionDateTime = '2026-04-02T01:17:16';
      shipment.deliveryDatePromised = 'yarın';
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-04-02T01:17:16+03:00', expected_delivery: null });
    // An estimate given as an instant elsewhere is the day it is in Istanbul.
    expect(parseHepsijet(changed('in-transit', (shipment) => { shipment.deliveryDatePromised = '2026-04-03T21:30:00Z'; }), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-04-04' });
  });

  it('takes the person who took the parcel out of the wording', () => {
    expect(hepsijetWording('Teslim edildi - Sample P***** (Kendi)')).toBe('Teslim edildi');
    expect(hepsijetWording('Teslim Alındı - Evden Alındı (Yakını)')).toBe('Teslim Alındı');
    expect(hepsijetWording('Teslim Edilemedi', 'Yetersiz Adres')).toBe('Teslim Edilemedi: Yetersiz Adres');
    expect(hepsijetWording('  Kurye  Dağıtıma Çıktı ')).toBe('Kurye Dağıtıma Çıktı');
    expect(hepsijetWording('', 'Hasarlı')).toBe('');
  });

  it('reads an unknown number as not found, a parcel not handed over as no history and another failure as inconclusive', () => {
    expect(() => parseHepsijet(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHepsijet(fixture('not-received'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // The page reports an empty list as a missing shipment.
    expect(() => parseHepsijet({ status: 'OK', data: [] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHepsijet({ status: 'OK', data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHepsijet({ message: 'Barkod bilgisi boş bırakılamaz!', status: 'FAIL' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHepsijet(changed('delivered', (shipment) => { shipment.transactions = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a shipment only when its number or barcode is the number asked', () => {
    expect(() => parseHepsijet(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'HepsiJET answered for another shipment' }));
    const byBarcode = changed('in-transit', (shipment) => { shipment.customerDeliveryNo = 'ZZ-ORDER-0001'; });
    expect(parseHepsijet(byBarcode, IN_TRANSIT).events).toHaveLength(4);
    const second = fixture('in-transit');
    second.data.unshift({ ...second.data[0]!, customerDeliveryNo: 'ZZ00000000000099', barcode: 'ZZ00000000000099', transactions: [] });
    expect(parseHepsijet(second, IN_TRANSIT).events).toHaveLength(4);
    // A longer number that starts with the one asked is someone else's.
    expect(() => parseHepsijet(changed('in-transit', (shipment) => {
      shipment.customerDeliveryNo = `${IN_TRANSIT}1`;
      shipment.barcode = `${IN_TRANSIT}1`;
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).status; },
      (_shipment: Shipment, body: Reply) => { body.status = 'PENDING'; },
      (_shipment: Shipment, body: Reply) => { body.data = 'shipment' as never; },
      (_shipment: Shipment, body: Reply) => { body.data = ['shipment'] as never; },
      (_shipment: Shipment, body: Reply) => { body.data = Array.from({ length: 21 }, () => body.data[0]!); },
      (shipment: Shipment) => { delete shipment.customerDeliveryNo; delete shipment.barcode; },
      (shipment: Shipment) => { shipment.customerDeliveryNo = 14; delete shipment.barcode; },
      (shipment: Shipment) => { shipment.transactions = 'scans' as never; },
      (shipment: Shipment) => { shipment.transactions = Array.from({ length: 301 }, () => shipment.transactions[0]!); },
      (shipment: Shipment) => { shipment.transactions[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.transactions[0]!.transactionDateTime = '01.04.2026 12:06'; },
      (shipment: Shipment) => { shipment.transactions[0]!.transactionDateTime = '2026-02-30T12:06:31+03:00'; },
      (shipment: Shipment) => { delete shipment.transactions[0]!.transactionDateTime; },
      (shipment: Shipment) => { shipment.transactions[0]!.transaction = ['Gönderi Alındı']; },
      (shipment: Shipment) => { shipment.transactions[0]!.transaction = ' - '; },
      (shipment: Shipment) => { shipment.transactions[0]!.deliveryStatus = 'collected; drop'; },
      (shipment: Shipment) => { shipment.transactions[0]!.location = { name: 'Doğuköy' }; },
      (shipment: Shipment) => { shipment.productName = 7; },
    ]) {
      expect(() => parseHepsijet(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a firewall refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.hepsijet.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // Akamai refuses clients it takes for bots with Hepsiburada's security page.
    await expect(lookup(SECURITY_PAGE, { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(SECURITY_PAGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>HepsiJET</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    // A missing parameter's failure, which says nothing about the parcel.
    await expect(lookup({ message: 'Response status 400', status: 'FAIL' }, { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its newest scan and the unknown-number answer, and asks nothing for a number it does not take', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T13:41:05.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ZZ-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers HepsiJET does not take and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ00000', 'ZZ_0000000000', `ZZ${'0'.repeat(29)}`, 'ZZ0000000000/1']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHepsijetNumber('kjet 0000-000 sm0t')).toBe('KJET0000000SM0T');
  });

  it('tries a request that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed under HepsiJET, or opened from its tracking page, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'hepsijet' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'hepsijet', source: 'hepsijet', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(HEPSIJET_API))).toBe(true);
    expect(parseTrackingInput(`https://www.hepsijet.com/gonderi-takibi/${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'hepsijet' });
    // Merchants print their own codes, so no rule claims a bare number.
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('hepsijet');
  });
});

describe('HepsiJET status vocabulary', () => {
  it('records every delivery status and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(hepsijetStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'hepsijet', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'hepsijet', providerCode: 'SYNTHETIC_STATUS', description: 'Örnek' })).toEqual({ kind: 'unknown' });
    // A status the map does not know falls to the shared wording rules.
    expect(hepsijetStage('SYNTHETIC_STATUS', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(hepsijetStage('', 'Örnek')).toBeNull();
    expect(hepsijetStage('delivered', 'İADE EDİLDİ')).toEqual({ stage: 'returned', source: 'carrier_map' });
  });
});

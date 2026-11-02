import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EVDEMO_PAGE, EvdemoTracker, evdemoLookupUrl } from './adapter.js';
import { normalizeEvdemoNumber, parseEvdemo } from './parser.js';
import { evdemoMappedStage, evdemoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '123406789013';
const OTHER = '000000000000';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Evdemo Lojistik HTTP adapter', () => {
  it('opens the tracking page with the number in its address, as the form and links do', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EvdemoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 0678 9013 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${EVDEMO_PAGE}?kargo_kodu=${DELIVERED}`);
    expect(url).toBe(evdemoLookupUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'evdemo-lojistik', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the shipment’s scans as wall clocks, newest first, staged by their wording, and nothing about the people or the packages', () => {
    const result = parseEvdemo(text('delivered.html'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Kargonuzu Teslim Ettik', last_update: null, last_update_local: '2026-03-14T16:27:00', expected_delivery: null });
    // The row the page lists twice is kept once.
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-03-14T16:27:00', 'Kargonuzu Teslim Ettik', 'delivered'],
      ['2026-03-14T10:09:00', 'Kargonuz Teslim Edilmek Üzere Dağıtımda', 'out_for_delivery'],
      ['2026-03-13T18:54:00', 'Kargonuzu Teslim Edemedik. Tekrar Dağıtıma Çıkarmak Üzere Şubemizde Bekliyor', 'failed_attempt'],
      ['2026-03-13T09:12:00', 'Kargonuz Teslim Edilmek Üzere Dağıtımda', 'out_for_delivery'],
      ['2026-03-11T18:54:00', 'Kargonuz Teslimatı Yapacak Olan Şubemizdedir', 'in_transit'],
      ['2026-03-09T21:49:00', 'Kargonuz Teslimatı Yapacak Şubemize Doğru Yolda', 'in_transit'],
      ['2026-03-08T11:07:00', 'Kargonuzu Göndericiden Teslim Aldık', 'accepted'],
      ['2026-03-07T10:30:00', 'Gönderi Talebiniz Oluşturuldu', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SA\*|Ör\*|Örnekşehir|Sample Province|SAMPLE WARDROBE|koli/);
  });

  it('reads a parcel on its way back to the sender and then returned', () => {
    const returned = parseEvdemo(text('returned.html'), OTHER);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Göndericiye iade edildi',
      last_update_local: '2026-02-20T18:08:00' });
    expect(returned.events!.slice(0, 3).map((event) => event.stage)).toEqual(['returned', 'returned', 'out_for_delivery']);
    const returning = parseEvdemo(text('returned.html').replace(/<tr>\s*<td class="tracking-time-box">20\.02\.2026[\s\S]*?<\/tr>/, ''), OTHER);
    expect(returning).toMatchObject({ current_stage: 'returned', last_status_text: 'İade edilmek üzere yolda', last_update_local: '2026-02-09T14:28:00' });
  });

  it('reads the older layout, with the rail’s labels and without a headline', () => {
    const result = parseEvdemo(text('in-transit.html'), OTHER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Taşıma Durumunda', last_update_local: '2026-01-15T11:38:00' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-01-15T11:38:00', 'Taşıma Durumunda', 'in_transit'],
      ['2026-01-14T14:24:00', 'Çıkış Dağıtım Merkezinde', 'in_transit'],
      ['2026-01-14T09:26:00', 'Yeni Gönderi', 'accepted'],
      ['2026-01-13T23:02:00', 'Gönderi Bildirimi', 'registered'],
    ]);
    // The rail's labels are not scans.
    expect(JSON.stringify(result)).not.toMatch(/Kargonuz Alındı|Transfer Sürecinde/);
    // A wording neither the map nor the shared rules know has no stage.
    const unknown = parseEvdemo(text('in-transit.html').replace('<strong>Taşıma Durumunda</strong>', '<strong>Örnek açıklama</strong>'), OTHER);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Örnek açıklama' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('puts the scans in clock order when the page does not', () => {
    const body = text('in-transit.html').replace('15.01.2026', '12.01.2026');
    const result = parseEvdemo(body, OTHER);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-01-14T14:24:00', '2026-01-14T09:26:00', '2026-01-13T23:02:00', '2026-01-12T11:38:00']);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Çıkış Dağıtım Merkezinde' });
  });

  it('reads the tracker’s notice under its own form as not found', async () => {
    expect(() => parseEvdemo(text('not-found.html'), OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    // Another notice, or the notice without the tracker's form, is not the tracker's answer.
    expect(() => parseEvdemo(text('not-found.html').replace('hatalı olabilir', 'şu an sorgulanamıyor'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEvdemo(text('not-found.html').replace('name="kargo_kodu"', 'name="kod"'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a page that names the whole number asked', () => {
    expect(() => parseEvdemo(text('delivered.html'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Evdemo Lojistik answered for another shipment' }));
    expect(() => parseEvdemo(text('delivered.html').replace('>123406789013</span>', '>12340678901</span>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Evdemo Lojistik answered for another shipment' }));
    expect(() => parseEvdemo(text('delivered.html').replace('>123406789013</span>', '></span>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Evdemo Lojistik did not name the shipment' }));
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('Gönderi Takip Numarası:', 'Takip No:'),
      delivered.replace(/class="row kargo-header"/, 'class="row"').replace(/<div class="row kargo-sonuc">[\s\S]*$/, ''),
      delivered.replace('<div class="row kargo-header">', '<div class="row kargo-header"></div><div class="row kargo-header">'),
      delivered.replace('<th scope="col">DURUM</th>\n                            </tr>\n                            </thead>\n                            <tbody>\n                                                            <tr>\n                                    <td class="tracking-time-box">14.03.2026', '<th scope="col">YER</th>\n                            </tr>\n                            </thead>\n                            <tbody>\n                                                            <tr>\n                                    <td class="tracking-time-box">14.03.2026'),
      delivered.replace('<div class="tracking-info-detail">', '<div class="tracking-detail">'),
      delivered.replace('14.03.2026                                        - 16:27', '2026-03-14 16:27'),
      delivered.replace('14.03.2026                                        - 16:27', '14.03.2026 - 24:00'),
      delivered.replace('14.03.2026                                        - 16:27', '30.02.2026 - 16:27'),
      delivered.replace('<strong>Kargonuzu Teslim Ettik</strong></td>\n                                </tr>', '<strong> </strong></td>\n                                </tr>'),
      delivered.replace('<td class="tracking-location ">\n                                        <strong>Kargonuzu Teslim Ettik</strong></td>', ''),
      delivered.replace(/(<tbody>)([\s\S]*?<\/tr>)/, (_all, head: string, row: string) => head + row.repeat(501)),
    ].entries()) {
      expect(() => parseEvdemo(body, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a page that names the shipment without scans', () => {
    const empty = text('in-transit.html').replace(/(<tbody>)[\s\S]*?(<\/tbody>)/, '$1$2');
    expect(() => parseEvdemo(empty, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a browser check, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: DELIVERED });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 301, headers: { Location: 'https://www.evdemolojistik.com/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 301 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
  });

  it('refuses what the carrier does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345678901', '1234567890123', 'ZZ1234567890', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEvdemoNumber(' 123-406-789-013 ')).toBe(DELIVERED);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => html(text('delivered.html')))).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(text('not-found.html')))).recognize!(OTHER)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('12345678901')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under Evdemo Lojistik to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'evdemo-lojistik' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'evdemo-lojistik', source: 'evdemo-lojistik', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === evdemoLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Evdemo Lojistik status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'evdemo-lojistik', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(evdemoStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'örnek açıklama')).toBeUndefined();
    expect(evdemoMappedStage('Kargonuzu Teslim Ettik')).toBeUndefined();
    expect(evdemoMappedStage('kargonuzu teslim ettik')).toBe('delivered');
    expect(evdemoStage('Gönderi iptal edildi')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(evdemoStage('Örnek açıklama')).toBeNull();
    expect(statusMapAnswer({ carrier: 'evdemo-lojistik', providerCode: null, description: 'Örnek açıklama' })).toEqual({ kind: 'unknown' });
  });
});

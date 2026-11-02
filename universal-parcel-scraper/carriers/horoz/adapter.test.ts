import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HOROZ_PAGE, HorozTracker, horozLookupUrl } from './adapter.js';
import { normalizeHorozNumber, parseHoroz } from './parser.js';
import { horozMappedStage, horozStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '12340678901234';
const OTHER = '00000000000000';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const F5 = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.</body></html>';
// The parcel before its delivery: no delivery row, and a headline the map does not know.
const inTransit = () => text('delivered.html')
  .replace(/<tr style="color:#2A254B;">\s*<td style="color:#2A254B;font-weight:bold;">Teslim[\s\S]*?<\/tr>/, '')
  .replace('GÖNDERİNİZ TESLİM EDİLMİŞTİR', '');

describe('Horoz Lojistik HTTP adapter', () => {
  it('opens the delivery note with the number in its address, as Horoz’s links do', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HorozTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234-0678-9012-34 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HOROZ_PAGE}?Ptn=${DELIVERED}`);
    expect(url).toBe(horozLookupUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'horoz', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the movements as wall clocks with their centres, newest first, and nothing about the people, the vehicles or the products', () => {
    const result = parseHoroz(text('delivered.html'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'GÖNDERİNİZ TESLİM EDİLMİŞTİR', last_update: null, last_update_local: '2026-03-12T14:36:51', expected_delivery: null });
    // The row the page lists twice is kept once.
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-12T14:36:51', 'Teslim', undefined, 'delivered'],
      ['2026-03-12T09:12:00', 'Çıkış', 'ÖRNEKKENT', 'in_transit'],
      ['2026-03-11T07:58:20', 'Giriş', 'ÖRNEKKENT', 'in_transit'],
      ['2026-03-10T21:03:48', 'Çıkış', 'MERKEZ AKTARMA', 'in_transit'],
      ['2026-03-10T06:15:33', 'Giriş', 'MERKEZ AKTARMA', 'in_transit'],
      ['2026-03-09T17:42:10', 'Çıkış', 'ÖRNEK MOBİLYA ŞUBE', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events![0]).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/ÖRN\*|SAM\*|ÖRNEKİL|SAMPLEİL|ÖRNEK SOKAK|00ZZ|Z000017|0000000000000017|ÖRNEK DOLAP|TÜKETİCİ/);
  });

  it('reads a parcel on its way, with the delivery date the note expects', () => {
    const result = parseHoroz(inTransit(), DELIVERED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Çıkış', last_update_local: '2026-03-12T09:12:00', expected_delivery: '2026-03-13' });
    // A headline the shared rules read gives the stage; one they do not leaves it to the movements.
    expect(parseHoroz(inTransit().replace('<span id="LblBaslik" style="color:#2A254B;font-family:Calibri;font-size:16pt;font-weight:bold;">',
      '$&Gönderi iptal edildi'), DELIVERED)).toMatchObject({ current_stage: 'exception', current_stage_source: 'wording:language', last_status_text: 'Gönderi iptal edildi' });
    expect(parseHoroz(inTransit().replace('<span id="LblBaslik" style="color:#2A254B;font-family:Calibri;font-size:16pt;font-weight:bold;">',
      '$&ÖRNEK BAŞLIK'), DELIVERED)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'ÖRNEK BAŞLIK' });
    // A date that is not one is no expectation.
    expect(parseHoroz(inTransit().replace('>13.03.2026<', '>31.02.2026<'), DELIVERED).expected_delivery).toBeNull();
    expect(parseHoroz(inTransit().replace('>13.03.2026<', '><'), DELIVERED).expected_delivery).toBeNull();
  });

  it('puts the movements in clock order when the page does not', () => {
    const result = parseHoroz(text('delivered.html').replace('09.03.2026 17:42:10', '13.03.2026 08:00:00'), DELIVERED);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-03-13T08:00:00', '2026-03-12T14:36:51', '2026-03-12T09:12:00',
      '2026-03-11T07:58:20', '2026-03-10T21:03:48', '2026-03-10T06:15:33']);
    // The headline keeps the stage; the newest movement gives the clock.
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-03-13T08:00:00' });
  });

  it('reads the empty note under its own form as not found', async () => {
    expect(() => parseHoroz(text('not-found.html'), OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    // The empty note without the page's form, or with movements, is not the tracker's answer.
    expect(() => parseHoroz(text('not-found.html').replace('id="form1"', 'id="form2"'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHoroz(text('not-found.html').replace('</form>', '<table id="grdAtfHareket"><tr><td>İşlem</td></tr></table></form>'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a page opened with the whole number asked', () => {
    expect(() => parseHoroz(text('delivered.html'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Horoz Lojistik answered for another shipment' }));
    expect(() => parseHoroz(text('not-found.html'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Horoz Lojistik answered for another shipment' }));
    expect(() => parseHoroz(text('delivered.html').replace(`Ptn=${DELIVERED}`, 'Ptn='), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHoroz(text('delivered.html').replace(`Ptn=${DELIVERED}`, 'Ptn=%E0%A4%A'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('action="./frmAtfDetay.aspx', 'action="./frmAtfListe.aspx'),
      delivered.replace('id="lblatfno"', 'id="lblAtfNo"'),
      delivered.replace('id="LblBaslik"', 'id="lblBaslik"'),
      delivered.replace('<td>Plaka</td>', '<td>Araç</td>'),
      delivered.replace('id="grdAtfHareket"', 'id="grdAtfHareket" ').replace('</table>\n            </td>\n        </tr>\n    </table>',
        '</table><table id="grdAtfHareket"></table>\n            </td>\n        </tr>\n    </table>'),
      delivered.replace('09.03.2026 17:42:10', '2026-03-09 17:42:10'),
      delivered.replace('09.03.2026 17:42:10', '09.03.2026 24:00:00'),
      delivered.replace('09.03.2026 17:42:10', '30.02.2026 17:42:10'),
      delivered.replace('<td>Çıkış</td><td>ÖRNEK MOBİLYA ŞUBE</td>', '<td> </td><td>ÖRNEK MOBİLYA ŞUBE</td>'),
      delivered.replace('<td>00ZZ000</td><td>MERKEZ AKTARMA</td>', '<td>MERKEZ AKTARMA</td>'),
      delivered.replace(/(<\/tr>)(\s*<tr style="color:#2A254B;">[\s\S]*?<\/tr>)/, (_all, end: string, row: string) => end + row.repeat(501)),
    ].entries()) {
      expect(() => parseHoroz(body, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a note without movements', () => {
    const empty = text('delivered.html').replace(/<table[^>]*id="grdAtfHareket"[\s\S]*?<\/table>/, '');
    expect(() => parseHoroz(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const headed = text('delivered.html').replace(/(<\/tr>)\s*<tr style="color:#2A254B;">[\s\S]*<\/tr>(\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>)/, '$1$2');
    expect(() => parseHoroz(headed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a firewall page, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: DELIVERED });
    await expect(lookup(() => html(F5))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(F5, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://app3.horoz.com.tr/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
  });

  it('refuses what the carrier does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234067890123', '123406789012345', 'ZZ123406789012', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHorozNumber(' 1234 0678 9012 34 ')).toBe(DELIVERED);
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
    await expect(carrier(fetcher).recognize!('1234067890123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under Horoz Lojistik to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'horoz' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'horoz', source: 'horoz', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === horozLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Horoz Lojistik status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'horoz', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(horozStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'örnek açıklama')).toBeUndefined();
    expect(horozMappedStage('Çıkış')).toBeUndefined();
    expect(horozMappedStage('çıkış')).toBe('in_transit');
    expect(horozStage('Gönderi iptal edildi')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(horozStage('Örnek açıklama')).toBeNull();
    expect(statusMapAnswer({ carrier: 'horoz', providerCode: null, description: 'Örnek açıklama' })).toEqual({ kind: 'unknown' });
  });
});

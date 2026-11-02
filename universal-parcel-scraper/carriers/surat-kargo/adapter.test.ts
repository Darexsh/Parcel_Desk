import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseSuratHistory, SURAT_HISTORY, SURAT_ORIGIN, suratHistoryTokens, suratKargoResult } from './parser.js';

const NUMBER = '82460739162048';
const PAGE = `${SURAT_ORIGIN}/KargoTakip/?kargotakipno=${NUMBER}`;
const TOKEN = 'a'.repeat(32);
const fixture = () => `<input name="kargotakipno"><table><thead><tr><th>Kayıt Tarihi</th><th>Planlanan Teslim Tarihi</th><th>Web Sipariş Kodu</th><th>Kargo Takip No</th></tr></thead>
<tbody><tr><td>PRIVATE date</td><td>PRIVATE estimate</td><td>PRIVATE order</td><td>824***********</td></tr></tbody></table>
<div data-hareket-url="${SURAT_HISTORY}"><button class="js-hareket-getir" data-token="${TOKEN}"></button><button class="js-hareket-getir" data-token="${TOKEN}"></button></div><p>PRIVATE recipient</p>`;
const history = () => [{ HareketTipi: 'Teslim Edildi', HareketTarihi: '12.03.2026 13:40:48', HareketYeri: 'Sample Acente', recipient: 'PRIVATE recipient' },
  { HareketTipi: 'Kurye Dağıtıma Çıktı', HareketTarihi: '12.03.2026 09:00:00', HareketYeri: 'Sample Acente' }];
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'SyntheticHost/1.0' });

describe('Sürat Kargo merchant tracking flow', () => {
  it('gets the whole-number page then opens its deduplicated guest capability in the same session', async () => {
    const page = new Response(fixture(), { headers: { 'Set-Cookie': 'session=synthetic; Path=/; Secure' } });
    Object.defineProperty(page, 'url', { value: PAGE });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page)
      .mockResolvedValueOnce(new Response(JSON.stringify(history())));
    const result = await carrier(fetcher).track({ number: NUMBER }, { budgetMs: 2000.5 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![0]).toBe(PAGE);
    expect(fetcher.mock.calls[1]![0]).toBe(SURAT_ORIGIN + SURAT_HISTORY);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ kargotakipno: TOKEN }), signal: expect.any(AbortSignal) });
    const headers = new Headers(fetcher.mock.calls[1]![1]!.headers);
    expect(headers.get('cookie')).toContain('session=synthetic');
    expect(headers.get('User-Agent')).toBe('SyntheticHost/1.0');
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-03-12T13:40:48+03:00', last_update_local: '2026-03-12T13:40:48' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|aaaaaaaaaaaaaaaa/);
  });

  it('binds capabilities to the whole request and matching masked identifier', () => {
    expect(suratHistoryTokens(fixture(), NUMBER, PAGE)).toEqual([TOKEN]);
    for (const [html, url] of [[fixture().replace('824***********', '923***********'), PAGE], [fixture(), PAGE + '9'],
      [fixture(), PAGE.replace('www.suratkargo.com.tr', 'evil.example')]]) {
      expect(() => suratHistoryTokens(html!, NUMBER, url!)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => suratHistoryTokens(fixture().replace(SURAT_HISTORY, 'https://evil.example/history'), NUMBER, PAGE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => suratHistoryTokens(fixture().replaceAll(TOKEN, 'not-a-token'), NUMBER, PAGE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an empty search form inconclusive and verification distinct from absence', () => {
    expect(() => suratHistoryTokens('<input name="kargotakipno">', NUMBER, PAGE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<title>Attention Required</title>', '<input name="UserCaptchaInput">']) {
      expect(() => suratHistoryTokens(html, NUMBER, PAGE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
    for (const data of [null, {}, [{ ...history()[0], HareketTarihi: '30.02.2026 12:00:00' }], [{ ...history()[0], HareketTipi: {} }]]) {
      expect(() => parseSuratHistory(data)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('does not declare a multi-piece shipment delivered while one piece remains active', () => {
    const delivered = parseSuratHistory(history());
    const active = parseSuratHistory(history().slice(1));
    expect(suratKargoResult([delivered, active])).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(suratKargoResult([delivered, active]).delivered_at).toBeUndefined();
    expect(suratKargoResult([delivered, delivered]).events).toHaveLength(2);
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains a history endpoint block and cancels before opening another piece', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture())).mockResolvedValueOnce(new Response('<title>Request Rejected</title>'));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    const control = new AbortController();
    const stopped = vi.fn<typeof fetch>().mockImplementation(async () => { control.abort(); return new Response(fixture()); });
    await expect(carrier(stopped).track({ number: NUMBER }, { signal: control.signal })).rejects.toThrow();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('retains a history rate limit without exposing its capability in transport details', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture()))
      .mockResolvedValueOnce(new Response(TOKEN, { status: 429, headers: { 'Retry-After': '7' } }));
    try { await carrier(fetcher).track({ number: NUMBER }); expect.fail('expected rate limit'); }
    catch (error) {
      expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  });

  it('omits guest capabilities and recipient details from malformed-history errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture()))
      .mockResolvedValueOnce(new Response(`<html>${TOKEN} PRIVATE recipient</html>`));
    try { await carrier(fetcher).track({ number: NUMBER }); expect.fail('expected malformed history'); }
    catch (error) {
      expect(error).toMatchObject({ kind: 'schema' });
      expect(JSON.stringify(error)).not.toMatch(/aaaaaaaaaaaaaaaa|PRIVATE/);
    }
  });
});

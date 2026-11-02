import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, validTrackingNumber } from '../../core/detection/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, LoggiTracker, loggiTrackingUrl, normalizeLoggiNumber, parseLoggi } from './adapter.js';

const NUMBER = 'TEST1234';
const shipment = () => ({ trackingCode: { loggi: NUMBER, correios: '$undefined' }, status: 'Entregue', isPackageDelivered: true,
  details: { receiverName: 'PRIVATE', receiverDocument: 'PRIVATE', deliveryNotes: 'PRIVATE' },
  history: [
    { date: '12 mar, 2026', title: 'Entregue', description: 'PRIVATE' },
    { date: '12 mar, 2026', title: 'Em rota', description: null },
    { date: '12 mar, 2026', title: 'Chegou em uma base', description: ' Cidade Exemplo - SP' },
    { date: '11 mar, 2026', title: 'Coletado', description: ' Outra Cidade - SP' },
    { date: '10 mar, 2026', title: 'Adicionado no sistema', description: null },
  ] });

/** Synthetic component stream split inside a JSON value, as Next's script chunks can be. */
function html(data: unknown = shipment(), options: { number?: string; failed?: boolean; missing?: boolean; generic404?: boolean } = {}) {
  const stream = `0:${JSON.stringify({ c: ['', 'rastreador', options.number ?? NUMBER] })}\n`
    + 'a:I[101,["101","static/chunks/app/(public)/rastreador/%5Btracking-code%5D/page-example.js"],"MainContent"]\n'
    + `f:${JSON.stringify([['$', '$La', null, data]])}\n`
    + (options.failed ? 'b:E{"digest":"upstream-failed"}\n' : '');
  const chunks = [stream.slice(0, 75), stream.slice(75)].map(chunk => `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`).join('');
  return `<html><title>Loggi Rastreio</title><h1>${options.missing ? 'Página não encontrada' : 'Entregue'}</h1>`
    + (options.generic404 ? '<template><h2>Página não encontrada</h2></template>' : '') + chunks + '</html>';
}

describe('Loggi tracking data', () => {
  it('keeps calendar days, same-day scan order and facility towns, dropping recipient details', () => {
    const result = parseLoggi(html(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-03-12' });
    expect(result.events?.map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-03-12', 'Entregue', 'delivered'], ['2026-03-12', 'Em rota', 'out_for_delivery'],
      ['2026-03-12', 'Chegou em uma base', 'in_transit'], ['2026-03-11', 'Coletado', 'accepted'],
      ['2026-03-10', 'Adicionado no sistema', 'registered'],
    ]);
    expect(result.events?.[2]?.location).toBe('Cidade Exemplo - SP');
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(parseLoggi(html(shipment(), { generic404: true }), NUMBER).status).toBe('delivered');
  });

  it('requires a matching route and a matching whole tracking code', () => {
    for (const document of [html(shipment(), { number: 'OTHER123' }), html({ ...shipment(), trackingCode: { loggi: NUMBER + 'X' } }),
      html({ ...shipment(), trackingCode: { code: NUMBER } })]) {
      expect(() => parseLoggi(document, NUMBER)).toThrow(expect.objectContaining({ kind: expect.stringMatching(/indeterminate|schema/) }));
    }
  });

  it('distinguishes an active missing view from a challenge, incomplete render and empty history', () => {
    expect(() => parseLoggi(html({}, { missing: true }), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLoggi(html({}, { missing: true, failed: true }), NUMBER)).not.toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLoggi('<title>Just a moment...</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseLoggi('<html>Loading...</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLoggi(html({ ...shipment(), history: [] }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLoggi(html({ ...shipment(), history: {} }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects malformed scan fields and impossible calendar days', () => {
    for (const scan of [{ date: '31 fev, 2026', title: 'Entregue' }, { date: '12 mar, 2026', title: {} },
      { date: '12 mar, 2026', title: 'Chegou em uma base', description: [] }]) {
      expect(() => parseLoggi(html({ ...shipment(), history: [scan] }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('does not stage unfamiliar wording and exposes its known map to consumers', () => {
    const result = parseLoggi(html({ ...shipment(), status: 'Nova situação', history: [{ date: '12 mar, 2026', title: 'Nova situação' }] }), NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.events?.[0]?.stage).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'loggi', description: 'Em rota' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});

describe('Loggi routing and transport', () => {
  it('accepts whole eight-character codes, including letters, as ambiguous candidates', () => {
    expect(normalizeLoggiNumber(' test 1234 ')).toBe(NUMBER);
    expect(validTrackingNumber('TESTCODE')).toBe(true);
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['loggi']) });
    expect(loggiTrackingUrl(NUMBER)).toBe(`https://app.loggi.com/rastreador/${NUMBER}`);
    for (const number of ['TEST123', 'TEST12345', 'TEST/123', 'TEST1234'.repeat(20)]) {
      expect(() => normalizeLoggiNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('uses the supplied browser transport, cancellation signal and remaining budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ url: loggiTrackingUrl(NUMBER), html: html(), tier: 3, statusCode: 200 })));
    const made = adapter({ trawl: new TrawlClient('https://trawl.invalid'), browserExecutablePath: null, fetcher, recorder: NOOP_RECORDER, env: {} });
    await expect(made.track({ number: NUMBER }, { budgetMs: 12_000 })).resolves.toMatchObject({ status: 'delivered' });
    const [address, init] = fetcher.mock.calls[0]!;
    expect(String(address)).toBe('https://trawl.invalid/scrape');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toMatchObject({ url: loggiTrackingUrl(NUMBER), skipHttp: true, maxTier: 3, maxTimeout: expect.any(Number) });
    expect(JSON.parse(String(init?.body)).maxTimeout).toBeLessThanOrEqual(10_000);
    await expect(new LoggiTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('preserves upstream refusals and rejects redirects to a different page', async () => {
    const response = (statusCode: number, url = loggiTrackingUrl(NUMBER)) => new Response(JSON.stringify({ url, html: html(), tier: 3, statusCode }));
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new LoggiTracker({ trawl: new TrawlClient('https://trawl.invalid', fetcher) });
    fetcher.mockResolvedValueOnce(response(429));
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    fetcher.mockResolvedValueOnce(response(200, loggiTrackingUrl('OTHER123')));
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

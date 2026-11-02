import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TrendyolTracker } from './adapter.js';
import { normalizeTrendyolNumber, parseTrendyol, trendyolTrackingUrl } from './parser.js';
import { trendyolStage } from './status.js';

const NUMBER = '7330123456789012';
const OTHER = '7330123456789013';
const page = readFileSync(new URL('./fixtures/in-transit.html', import.meta.url), 'utf8');
const missing = (number = NUMBER) => `<section class="not-found-wrapper"><h1>Sonuç Bulunamadı</h1><p><b>${number}</b> numaralı bir gönderi bulamadık!</p></section>`;
const environment = (html: string, change: Record<string, unknown> = {}) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: trendyolTrackingUrl(NUMBER), html, tier: 3, statusCode: 200, ...change }));
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, env: {}, trawl: new TrawlClient('https://browser.test'), browserExecutablePath: null };
};

describe('Trendyol Express public browser adapter', () => {
  it('reads all collapsed history and ignores the duplicate summary and future rail', () => {
    const result = parseTrendyol(page, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-04-12T09:30:00', timezone: 'Europe/Istanbul', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2026-04-12T09:30:00', description: 'Gönderi Yolda', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-04-11T22:10:00', description: 'Transfer Merkezinde', location: 'İstanbul', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-04-11T15:45:00', description: 'Gönderi Alındı', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|987654321|receiver|signature|address/i);
  });

  it('uses the existing Turkish stage map for delivery and returns', () => {
    expect(trendyolStage('Teslim Edildi')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(trendyolStage('İade Süreci Başladı')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(trendyolStage('Depoya İade Edildi')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(parseTrendyol(page.replaceAll('Gönderi Yolda', 'Teslim Edildi'), NUMBER)).toMatchObject({ current_stage: 'delivered' });
  });

  it('retains unknown scan wordings without inventing a stage', () => {
    const result = parseTrendyol(page.replaceAll('Gönderi Yolda', 'Yeni hareket'), NUMBER);
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events![0]!.description).toBe('Yeni hareket');
  });

  it('rejects a different whole shipment number or an ambiguous identity', () => {
    expect(() => parseTrendyol(page, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTrendyol(page.replace(NUMBER, `${NUMBER}0`), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTrendyol(page + `<div id="delivery-number-list-item-value">${NUMBER}</div>`, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTrendyol(page.replace('987654321', NUMBER).replace(`id="delivery-number-list-item-value">${NUMBER}`, `id="delivery-number-list-item-value">${OTHER}`), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts not-found only when the notice quotes the exact shipment and has no history', () => {
    expect(() => parseTrendyol(missing(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTrendyol(missing(OTHER), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTrendyol(missing(''), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTrendyol(page + missing(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTrendyol('<div id="root"></div>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTrendyol('<div id="root"><div class="preloader"></div></div>', NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each(['31.02.2026 09:30', '12.04.2026 24:30', '12.04.2026', 'unknown'])('rejects a malformed scan clock: %s', stamp => {
    expect(() => parseTrendyol(page.replaceAll('12.04.2026 09:30', stamp), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an HTTP 200 firewall page challenged', () => {
    expect(() => parseTrendyol('<title>Just a moment...</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects an empty or oversized history', () => {
    expect(() => parseTrendyol(`<div id="delivery-number-list-item-value">${NUMBER}</div>`, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseTrendyol(page + '<div id="history-list-item"></div>'.repeat(501), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('validates shipment numbers before requesting a browser', () => {
    expect(normalizeTrendyolNumber('7330 1234 5678 9012')).toBe(NUMBER);
    for (const wrong of ['SP123456789', '1234567890', NUMBER + '1', '']) {
      expect(() => normalizeTrendyolNumber(wrong)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('uses the supplied service, transport and cancellation signal', async () => {
    const env = environment(page);
    const result = await adapter(env).track({ number: NUMBER });
    expect(result.events).toHaveLength(3);
    expect(env.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = env.fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://browser.test/scrape');
    expect(JSON.parse(String(init!.body))).toMatchObject({ url: trendyolTrackingUrl(NUMBER), skipHttp: true, maxTier: 3,
      contentWaitForSelector: '#delivery-state, section.not-found-wrapper' });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(env.recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'trendyol-express', finalStep: 'trawl', outcome: 'ok' }));
    expect(adapter(env).recognize).toBeUndefined();
  });

  it('routes explicit carrier selection to native history with universal providers disabled', async () => {
    const env = environment(page);
    await expect(createTracker({ providers: [], trawlUrl: 'https://browser.test', fetcher: env.fetcher })
      .track({ number: NUMBER, carrier: 'trendyol-express' })).resolves.toMatchObject({ source: 'trendyol-express', result: { current_stage: 'in_transit' } });
  });

  it('requires the service and preserves deadlines and redirects', async () => {
    await expect(new TrendyolTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const env = environment(page);
    await expect(adapter(env).track({ number: NUMBER }, { budgetMs: 100 })).rejects.toMatchObject({ kind: 'budget' });
    expect(env.fetcher).not.toHaveBeenCalled();
    await expect(adapter(environment(page, { url: 'https://other.test/' })).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
  });
});

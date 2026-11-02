import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { recognitionAskedCarriers, recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { adapter, EmiratesPostTracker } from './adapter.js';
import { EMIRATES_POST_MAX_BYTES, emiratesPostUrl, normalizeEmiratesPostNumber, parseEmiratesPost } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'ZZ000000028AE';
const OTHER = 'ZZ000000014AE';
const DOMESTIC = '1000000000001';
const status = (code = 'P-53', descriptionEn = 'Delivered') => ({ code, descriptionEn });
const scan = (timeStamp: string, code: string, descriptionEn: string, locationEn: string) => ({ timeStamp,
  status: status(code, descriptionEn), locationEn, url: 'https://example.invalid/PRIVATE_PROOF' });
const item = (number = NUMBER) => ({ trackingNumber: number, trackingReferenceNo: 'PRIVATE_REFERENCE',
  sender: { name: 'PRIVATE_SENDER', contactNumber: 'PRIVATE_CONTACT' }, receiver: { name: 'PRIVATE_RECIPIENT' },
  lastStatus: status(), events: [
    scan('05/04/2026 12:05:00 PM', 'P-53', 'Delivered ', 'BIRMINGHAM'),
    scan('03/04/2026 12:01:00 AM', 'P-9', 'Shipped to destination', 'DUBAI SORTING CENTRE'),
    scan('02/04/2026 01:02:03 PM', 'P-58', 'Received at counter', 'Synthetic origin office'),
  ] });
function document(result: unknown = item(), number = NUMBER, state = 'success') {
  return { query: { q: number, slug: ['all-services', 'track-a-package', 'step-two'] },
    props: { pageProps: { pageContext: { extraData: { status: state, result: [result] } } } } };
}
const page = (next: unknown = document()) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`;
const missing = () => page(document({ trackingNumber: NUMBER, events: null }, NUMBER, 'not-found'));
function browser(html = page()) {
  const scrape = vi.fn().mockResolvedValue({ html });
  return { trawl: { scrape } as unknown as TrawlClient, scrape };
}
const environment = (trawl: TrawlClient) => ({ recorder: NOOP_RECORDER, trawl, browserExecutablePath: null, env: {} });

describe('Emirates Post page projection', () => {
  it('keeps whole S10 and domestic identifiers separate from format ownership', () => {
    expect(normalizeEmiratesPostNumber('zz 000 000 028 ae')).toBe(NUMBER);
    expect(normalizeEmiratesPostNumber('ZZ000000005CN')).toBe('ZZ000000005CN');
    expect(normalizeEmiratesPostNumber(DOMESTIC)).toBe(DOMESTIC);
    expect(emiratesPostUrl(NUMBER)).toBe(`https://www.emiratespost.ae/all-services/track-a-package/step-two?q=${NUMBER}`);
    for (const raw of ['ZZ000000006AE', '000000000001', NUMBER + OTHER, NUMBER + ',']) {
      expect(() => normalizeEmiratesPostNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('reads one identity-bound item, keeps page order and drops parties and event URLs', () => {
    const result = parseEmiratesPost(page(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      provider_code: 'P-53', last_status_text: 'Delivered', last_update: null, last_update_local: '2026-04-05T12:05:00',
      events: [{ local_time: '2026-04-05T12:05:00', provider_code: 'P-53', stage: 'delivered' },
        { local_time: '2026-04-03T00:01:00', time: '2026-04-03T00:01:00+04:00', time_zone: 'Asia/Dubai', time_zone_basis: 'place' },
        { local_time: '2026-04-02T13:02:03', stage: 'accepted' }] });
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![2]).not.toHaveProperty('time');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|sender|receiver|contact|reference|proof|https:/i);
  });

  it('takes the destination country from the wording that names where the item is sent', () => {
    expect(parseEmiratesPost(page(), NUMBER)).not.toHaveProperty('destination_country');
    const data = item(); data.events = [
      scan('22/10/2026 09:37:00 AM', 'P-10', 'Arrived at MALDIVES', 'MVMLEA'),
      scan('15/10/2026 12:42:04 PM', 'P-9', 'Shipped to MALDIVES', 'DUBAI SORTING CENTRE'),
    ];
    expect(parseEmiratesPost(page(document(data)), NUMBER)).toMatchObject({ destination_country: 'MV' });
    // A city names no country.
    data.events = [scan('15/10/2026 12:42:04 PM', 'P-9', 'Shipped to SAMPLE CITY', 'DUBAI SORTING CENTRE')];
    expect(parseEmiratesPost(page(document(data)), NUMBER)).not.toHaveProperty('destination_country');
  });

  it('preserves a stated offset even when the office names a UAE city', () => {
    const data = item(); data.events = [scan('2026-04-05T12:05:00+05:00', 'P-53', 'Delivered', 'Dubai')];
    expect(parseEmiratesPost(page(document(data)), NUMBER).events![0]).toMatchObject({ time: '2026-04-05T12:05:00+05:00' });
    expect(parseEmiratesPost(page(document(data)), NUMBER).events![0]).not.toHaveProperty('time_zone');
  });

  it('reads domestic history and midnight/noon without inventing an instant for an unidentified office', () => {
    const data = item(DOMESTIC); data.lastStatus = status('CLC12');
    data.events = [scan('05/04/2026 12:00:00 PM', 'CLC12', 'Delivered', 'Ajman'),
      scan('05/04/2026 12:00:00 AM', 'P-8', 'Arrived at office', 'Synthetic office')];
    const result = parseEmiratesPost(page(document(data, DOMESTIC)), DOMESTIC);
    expect(result.events![0]).toMatchObject({ local_time: '2026-04-05T12:00:00', time: '2026-04-05T12:00:00+04:00' });
    expect(result.events![1]).toMatchObject({ local_time: '2026-04-05T00:00:00' });
    expect(result.events![1]).not.toHaveProperty('time');
  });

  it('leaves a history no office places on UAE time, not UTC', () => {
    const data = item(DOMESTIC); data.lastStatus = status('CLC12');
    data.events = [scan('05/04/2026 09:00:00 AM', 'CLC12', 'Delivered', 'Synthetic office')];
    const result = dateLocalClocks('emirates-post', parseEmiratesPost(page(document(data, DOMESTIC)), DOMESTIC));
    expect(result).toMatchObject({ last_update: '2026-04-05T09:00:00+04:00' });
    expect(result.events![0]).toMatchObject({ time: '2026-04-05T09:00:00+04:00', time_zone: 'Asia/Dubai', time_zone_basis: 'carrier' });
  });

  it('deduplicates identical scans and retains Arabic wording when English is absent', () => {
    const data = item(); data.events.push(data.events[0]!);
    Object.assign(data.events[0]!.status, { descriptionEn: '', descriptionAr: 'تم التسليم' });
    const result = parseEmiratesPost(page(document(data)), NUMBER);
    expect(result.events).toHaveLength(3);
    expect(result.events![0]).toMatchObject({ description: 'تم التسليم', stage: 'delivered' });
  });

  it('accepts only the bound explicit missing envelope as not-found', () => {
    expect(() => parseEmiratesPost(missing(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const next of [document({ trackingNumber: OTHER, events: null }, NUMBER, 'not-found'),
      document(item(), NUMBER, 'not-found'), document(item(), OTHER), document({ ...item(), trackingNumber: OTHER })]) {
      expect(() => parseEmiratesPost(page(next), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseEmiratesPost(page(document({ ...item(), events: [] })), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEmiratesPost(page(document(item(), NUMBER, 'error')), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects another page, multiple items, malformed clocks, excess history and browser shells', () => {
    const malformed: unknown[] = [null, {}, { ...document(), query: { q: [NUMBER], slug: ['all-services', 'track-a-package', 'step-two'] } },
      { ...document(), props: { pageProps: { pageContext: { extraData: { status: 'success', result: [item(), item(OTHER)] } } } } },
      document({ ...item(), events: [scan('31/02/2026 01:00:00 PM', 'P-53', 'Delivered', 'Dubai')] }),
      document({ ...item(), events: Array.from({ length: 2001 }, () => item().events[0]) })];
    for (const next of malformed) expect(() => parseEmiratesPost(page(next), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html>Tracker loading</html>', '<script id="__NEXT_DATA__">{</script>', page() + page(), 'x'.repeat(EMIRATES_POST_MAX_BYTES + 1)]) {
      expect(() => parseEmiratesPost(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseEmiratesPost('<html><title>Access Challenge</title></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses the observed status map without making every new code in-transit', () => {
    for (const row of statuses.entries.filter(row => 'code' in row)) {
      const answer = statusMapAnswer({ carrier: 'emirates-post', providerCode: row.code!, description: row.wording });
      expect(answer).toMatchObject({ kind: 'mapped', stage: row.stage });
    }
    const data = item(); data.lastStatus = status('NEW_CODE', 'Synthetic unclassified state');
    expect(parseEmiratesPost(page(document(data)), NUMBER)).toMatchObject({ status: 'unknown' });
    expect(parseEmiratesPost(page(document(data)), NUMBER)).not.toHaveProperty('current_stage');
  });
});

describe('Emirates Post browser adapter', () => {
  it('routes an explicit carrier through the registered adapter with providers disabled', async () => {
    const { trawl } = browser();
    const registry = new AdapterRegistry(REGISTRY, environment(trawl));
    const response = await createTracker({ registry, providers: [] }).track({ carrier: 'emirates-post', number: NUMBER });
    expect(response).toMatchObject({ carrier: 'emirates-post', source: 'emirates-post', result: { current_stage: 'delivered' },
      attempts: [{ source: 'emirates-post', kind: 'ok' }] });
    expect(response.result.events).toHaveLength(3);
  });

  it('uses the supplied transport and records one bounded browser step', async () => {
    const { trawl, scrape } = browser(); const fetcher = vi.fn<typeof fetch>();
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    await new EmiratesPostTracker({ trawl, fetcher, recorder }).fetch(NUMBER, { budgetMs: 24_000 });
    const [request, options] = scrape.mock.calls[0]!;
    expect(request).toMatchObject({ url: emiratesPostUrl(NUMBER), skipHttp: true, maxTier: 3 });
    expect(request.maxTimeout).toBeGreaterThan(0); expect(request.maxTimeout).toBeLessThanOrEqual(22_000);
    expect(options).toMatchObject({ fetcher, signal: expect.any(AbortSignal), timeoutMs: request.maxTimeout });
    expect(recorder.step).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ carrier: 'emirates-post', step: 'trawl', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('recognizes through the separate opt-in browser phase and reuses the projected result', async () => {
    const { trawl } = browser(); const carrier = adapter(environment(trawl));
    expect(carrier.recognize).toBeUndefined();
    await expect(carrier.recognizeWithBrowser!(NUMBER)).resolves.toMatchObject({ known: true, result: { events: expect.any(Array) } });
    await expect(carrier.recognizeWithBrowser!('bad')).resolves.toMatchObject({ known: false });
    const missingBrowser = browser(missing());
    await expect(adapter(environment(missingBrowser.trawl)).recognizeWithBrowser!(NUMBER)).resolves.toMatchObject({ known: false });
    expect(recognitionAskedCarriers(NUMBER)).not.toContain('emirates-post');
    expect(recognitionCandidates(NUMBER, { phase: 'browser' })).toContainEqual(expect.objectContaining({ carrier: 'emirates-post', preferred: true }));
    expect(recognitionCandidates('ZZ000000006AE', { phase: 'browser' }).map(row => row.carrier)).not.toContain('emirates-post');
    expect(detectCarrierMatch(DOMESTIC).candidates).not.toContain('emirates-post');
  });

  it('starts no request for cancellation or an exhausted budget and requires the optional service', async () => {
    const { trawl, scrape } = browser(); const stopped = new AbortController(); stopped.abort(new Error('cancelled'));
    await expect(new EmiratesPostTracker({ trawl }).fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow('cancelled');
    await expect(new EmiratesPostTracker({ trawl }).fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(scrape).not.toHaveBeenCalled();
    await expect(new EmiratesPostTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('preserves challenge, rate-limit and service failure kinds without retaining browser diagnostics', async () => {
    for (const [last, kind] of [[{ tier: 3, status: 'blocked', statusCode: 403 }, 'challenge'],
      [{ tier: 3, status: 'blocked', statusCode: 429, responseHeaders: { 'retry-after': '60' } }, 'rate_limited'],
      [{ tier: 3, status: 'error' }, 'indeterminate']] as const) {
      const { trawl, scrape } = browser();
      scrape.mockRejectedValue(new UpstreamHttpError('TRAWL', 500, undefined, {
        content_type: 'application/json', headers: { 'set-cookie': 'PRIVATE_COOKIE' }, response_url: 'https://example.invalid/PRIVATE_URL',
        status_text: 'Internal Server Error', request_ids: {}, body_read: 'complete', bytes_inspected: 100, body_signals: [],
        body_excerpt: JSON.stringify({ error: 'Max tier reached without success', timings: [last], private: 'PRIVATE_COOKIE' }),
      }));
      const error = await new EmiratesPostTracker({ trawl }).fetch(NUMBER).catch((error: unknown) => error);
      expect(error).toMatchObject({ kind });
      if (kind === 'rate_limited') expect(error).toMatchObject({ retryAfterMs: 60_000 });
      expect(JSON.stringify(error)).not.toContain('PRIVATE_COOKIE');
      expect(error).not.toHaveProperty('diagnostics', expect.anything());
    }
    const { trawl, scrape } = browser();
    scrape.mockRejectedValue(new UpstreamNetworkError('TRAWL', new Error('connection closed'), {
      url: 'https://example.invalid/PRIVATE_URL', method: 'POST', headers: {}, timeout_ms: 100,
    }));
    const error = await new EmiratesPostTracker({ trawl }).fetch(NUMBER).catch((error: unknown) => error);
    expect(error).toMatchObject({ kind: 'transport' });
    expect(JSON.stringify(error)).not.toContain('PRIVATE_URL');
    scrape.mockRejectedValue(new UpstreamHttpError('TRAWL', 404));
    await expect(new EmiratesPostTracker({ trawl }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 404 });
  });
});

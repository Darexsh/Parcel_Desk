import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EUROPOCHTA_API, EuropochtaTracker } from './adapter.js';
import { europochtaJson, normalizeEuropochtaNumber, parseEuropochta } from './parser.js';
import { europochtaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'BY080731593842';
const OTHER = 'BY080648295173';
const URL = `${EUROPOCHTA_API}?number=${NUMBER}`;
const SERVICE = 'https://trawl.invalid';
const fixture = (): Record<string, unknown>[] => JSON.parse(readFileSync(new globalThis.URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const reply = (body: unknown = fixture(), status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8' },
});
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, trawl: new TrawlClient(SERVICE), env: {}, browserExecutablePath: null });
const browserReply = (body: unknown = fixture(), extra: Record<string, unknown> = {}) => reply({
  url: URL, statusCode: 200, tier: 2, html: '<html><body>DOM is not the JSON response</body></html>',
  body: { type: 'Buffer', data: [...new TextEncoder().encode(JSON.stringify(body))] }, ...extra,
});
const CHALLENGE = '<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>';

describe('Europochta native adapter', () => {
  it('keeps complete milestones and wall clocks without internal fields or collection addresses', () => {
    const result = parseEuropochta(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-10-30T18:20:12', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2026-10-30T18:20:12', description: 'Почтовое отправление выдано', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-10-29T15:20:00', description: 'Почтовое отправление прибыло на ОПС выдачи', stage: 'ready_for_pickup', stage_source: 'carrier_map' },
      { local_time: '2026-10-29T10:00:00', description: 'В пути на ОПС назначения', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-10-28T14:00:00', description: 'Почтовое отправление принято на ОПС', stage: 'accepted', stage_source: 'carrier_map' },
      { local_time: '2026-10-27T09:00:00', description: 'Заявка на почтовое отправление зарегистрирована', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    const output = JSON.stringify(result);
    for (const privateText of [NUMBER, 'employee', 'operator', 'Internal', 'Private', 'Выдуманная', 'Пример', 'example.invalid', 'collection']) expect(output).not.toContain(privateText);
    expect(result.events!.every(event => !event.time && !event.location && !event.provider_code)).toBe(true);
  });

  it.each([OTHER, NUMBER + '7'])('rejects a different whole identifier %s before simplifying a notification', identity => {
    const rows = fixture();
    rows[2]!.client_info = String(rows[2]!.client_info).replace(NUMBER, identity);
    expect(() => parseEuropochta(rows, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('drops an arrival message sent after collection and keeps a notification-only arrival', () => {
    const rows = fixture();
    rows.unshift({ ...rows[2], timeX: '2026-10-30 18:20:18' });
    const result = parseEuropochta(rows, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Почтовое отправление выдано', last_update_local: '2026-10-30T18:20:12' });
    expect(result.events).toHaveLength(5);
    expect(parseEuropochta([rows[3]], NUMBER)).toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('sorts clocks stably, preserves unseen wording and does not advance bookkeeping notices', () => {
    const rows = fixture().slice(3, 6).reverse();
    rows.push({ timeX: '2026-10-30 10:00:00', client_info: `Добрый день. Срок бесплатного хранения почтового отправления ${NUMBER} истекает 31.10.2026.`, employee_info: 'Internal' });
    const result = parseEuropochta(rows, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Срок бесплатного хранения почтового отправления истекает' });
    expect(result.events![0]!.stage).toBeUndefined();
    rows[3]!.client_info = 'Новая формулировка';
    expect(parseEuropochta(rows, NUMBER).events![0]).toEqual({ local_time: '2026-10-30T10:00:00', description: 'Новая формулировка' });
    expect(europochtaStage('Почтовое отправление перемаркировано')).toBeNull();
  });

  it.each(statuses.entries)('agrees with the recorded wording: $wording', entry => {
    expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe('stage' in entry ? entry.stage : undefined);
    if (!('stage' in entry)) expect(statusMap.gaps.some(gap => gap.wording === entry.wording.toLowerCase()) || statusMap.gapNote?.(null, entry.wording.toLowerCase())).toBeTruthy();
  });

  it.each(['2026-02-30 10:00:00', '2026-10-29 24:00:00', '2026-10-29T10:00:00Z', '', null])('rejects an invalid clock %s', value => {
    expect(() => parseEuropochta([{ timeX: value, client_info: 'Почтовое отправление выдано' }], NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([{}, { Error: 500 }, [{ timeX: '2026-10-29 12:00:00', client_info: {} }], [null], Array(501).fill({})])('rejects malformed data', payload => {
    expect(() => parseEuropochta(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[], { Error: 404, ErrorDescription: 'Failed to fetch data' }, [{ client_info: null }]])('leaves missing history and generic failures inconclusive', payload => {
    expect(() => parseEuropochta(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('normalizes the existing own-label format and rejects foreign postal labels', () => {
    expect(normalizeEuropochtaNumber(' by08 0731-593842 ')).toBe(NUMBER);
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'europochta', confidence: 'high' });
    for (const number of ['AB073159384BY', NUMBER + '7', OTHER + NUMBER, 'BY090731593842']) {
      expect(() => normalizeEuropochtaNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('uses the whole request, supplied transport and user agent, without cookies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply());
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await new EuropochtaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER, { budgetMs: 1000.5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(URL, expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0',
    } }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('retries a failed connection once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply());
    await expect(new EuropochtaTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([403, 200])('recovers a challenge with HTTP %s through the exact browser lookup and retains provenance', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(CHALLENGE, status)).mockResolvedValueOnce(browserReply());
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new EuropochtaTracker({ fetcher, trawl: new TrawlClient(SERVICE), recorder }).fetch(NUMBER);
    expect(result).toEqual(parseEuropochta(fixture(), NUMBER));
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(`${SERVICE}/scrape`);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init!.body))).toMatchObject({ url: URL, skipHttp: true, maxTier: 3 });
    expect(recorder.step.mock.calls.map(([step]) => [step.step, step.outcome, step.fallbackFrom])).toEqual([
      ['direct', 'challenge', null], ['trawl', 'ok', 'direct'],
    ]);
  });

  it.each([
    { body: { Error: 404, ErrorDescription: 'Failed to fetch data' }, kind: 'indeterminate' },
    { body: [], kind: 'indeterminate' },
    { body: '<html>Maintenance</html>', kind: 'schema' },
  ])('does not launch a browser for $kind data', async ({ body, kind }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
    await expect(new EuropochtaTracker({ fetcher, trawl: new TrawlClient(SERVICE) }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 404, 405, 410, 429])('preserves route or rate failures with HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('Unavailable', status));
    await expect(new EuropochtaTracker({ fetcher, trawl: new TrawlClient(SERVICE) }).fetch(NUMBER)).rejects.toMatchObject({ kind: status === 429 ? 'rate_limited' : 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects redirected browser results and never parses the rendered DOM in place of missing bytes', async () => {
    for (const extra of [{ url: `${EUROPOCHTA_API}?number=${OTHER}` }, { body: undefined }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(CHALLENGE, 403)).mockResolvedValueOnce(browserReply(fixture(), extra));
      await expect(new EuropochtaTracker({ fetcher, trawl: new TrawlClient(SERVICE) }).fetch(NUMBER)).rejects.toMatchObject({ kind: extra.url ? 'transport' : 'indeterminate' });
    }
  });

  it('keeps HTTP recognition browserless even with TRAWL configured', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(CHALLENGE, 403));
    await expect(adapter(environment(fetcher)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not turn a generic upstream failure into negative recognition', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ Error: 404, ErrorDescription: 'Failed to fetch data' }));
    await expect(adapter(environment(fetcher)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('routes the unchanged carrier id to native history with universal providers disabled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply());
    await expect(createTracker({ fetcher, providers: [] }).track({ number: NUMBER })).resolves.toMatchObject({ carrier: 'europochta', source: 'europochta', result: { status: 'delivered' } });
  });

  it('does not begin browser work without time for its response and honors cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(CHALLENGE, 403));
    await expect(new EuropochtaTracker({ fetcher, trawl: new TrawlClient(SERVICE) }).fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    fetcher.mockClear();
    await expect(new EuropochtaTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies an HTTP 200 block and an empty or malformed body independently of JSON schema', () => {
    expect(() => europochtaJson(CHALLENGE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => europochtaJson('')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => europochtaJson('<html>Other page</html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KYRGYZ_POST_LOOKUP, KYRGYZ_POST_PAGE, KyrgyzPostTracker } from './adapter.js';
import { normalizeKyrgyzPostNumber, parseKyrgyzPost, parseKyrgyzPostReply } from './parser.js';
import { kyrgyzPostStage, kyrgyzPostWordingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014RU';
const IN_TRANSIT = 'ZZ000000028CN';
const OUTBOUND = 'ZZ000000031KG';
const UNKNOWN = 'ZZ000000045KG';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Row = { EventName: unknown; date: unknown };
const fixture = (name: string): Row[] => JSON.parse(text(name)) as Row[];
const edited = (name: string, change: (rows: Row[]) => void): Row[] => {
  const rows = fixture(name);
  change(rows);
  return rows;
};
const reply = (body: string, status = 200, type = 'text/html; charset=UTF-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Kyrgyz Post tracking adapter', () => {
  it('posts the whole code once, as the tracking page’s script does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KyrgyzPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 ru ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(KYRGYZ_POST_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://post.kg', Referer: KYRGYZ_POST_PAGE, 'User-Agent': 'SyntheticHost/1.0' } });
    // The reply does not name the item: the request holds the whole code, and no token.
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ action: 'get_track_number', barcode: DELIVERED });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kyrgyz-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads mail from abroad newest first, with the sending post’s office as its place and every clock as a wall clock', () => {
    const result = parseKyrgyzPost(fixture('delivered'), DELIVERED);
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Вручено получателю', last_update: null, last_update_local: '2026-03-16T15:27:09', expected_delivery: null }));
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.local_time, event.location ?? null, event.description, event.stage])).toEqual([
      ['2026-03-16T15:27:09', null, 'Вручено получателю', 'delivered'],
      ['2026-03-12T10:02:58', null, 'Поступило в отделение связи Образец 7', 'in_transit'],
      ['2026-03-12T00:31:27', null, 'Отправлено из РФ в отделение связи Образец 7', 'in_transit'],
      ['2026-03-11T17:48:03', null, 'Поступило в Бишкек почтамт РФ', 'in_transit'],
      ['2026-03-11T12:20:45', null, 'Отправлено из ЦМПОЛ в Бишкек почтамт РФ', 'in_transit'],
      ['2026-03-11T11:05:12', null, 'Поступило в ЦМПОЛ', 'in_transit'],
      ['2026-03-02T10:40:00', 'SAMPLE PCI1', 'Вложить отправление в мешок (исх.)', 'in_transit'],
      ['2026-03-02T09:14:00', 'SAMPLE PCI1', 'Получить отправление в сортировочном узле (исход.)', 'in_transit'],
    ]);
    expect(result.events!.every((event) => !event.time && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads an item at the post office that delivers it as in transit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Поступило в отделение связи Примерное 3', last_update_local: '2026-01-22T08:49:10',
      events: [{}, {}, { description: 'Поступило в ЦМПОЛ' }, { location: 'SAMPLE' }, { location: 'SAMPLE' }] });
  });

  it('reads an item posted in Kyrgyzstan up to its despatch abroad, without the office’s postcode', () => {
    const result = parseKyrgyzPost(fixture('outbound'), OUTBOUND);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Отправлено из ЦМПОЛ в заграницу' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-05-08T10:28:35', 'Отправлено из ЦМПОЛ в заграницу', 'in_transit'],
      ['2026-05-04T15:41:21', 'Принято в ПУ Образцового', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/9{6}/);
    const scan = (EventName: string) => parseKyrgyzPost([{ EventName, date: '2026-05-04T15:41:21' }], OUTBOUND).events![0]!;
    expect(scan('Получить отправление в сортировочном узле (исход.). Офис: SAMPLE 999999')).toMatchObject({ location: 'SAMPLE' });
    expect(scan('Вложить отправление в мешок (исх.). Офис: 999999')).not.toHaveProperty('location');
    expect(scan('Принято в ПУ 999999, Образцового')).toMatchObject({ description: 'Принято в ПУ Образцового' });
  });

  it('keeps the delivery scan’s own words and nothing the reply could put after them', () => {
    const scan = (EventName: string) => parseKyrgyzPost([{ EventName, date: '2026-03-16T15:27:09' }], DELIVERED).events![0]!;
    expect(scan('Вручено получателю Sample Person')).toMatchObject({ description: 'Вручено получателю', stage: 'delivered' });
    expect(scan('Вручено получателю: Sample Person')).toMatchObject({ description: 'Вручено получателю', stage: 'delivered' });
    expect(scan('Вручено отправителю')).toEqual({ local_time: '2026-03-16T15:27:09', description: 'Вручено отправителю' });
  });

  it('keeps a newest-first reply as it is, a repeated scan once and an unknown wording without a stage', () => {
    const reversed = parseKyrgyzPost(edited('delivered', (rows) => { rows.reverse(); }), DELIVERED);
    expect(reversed.events).toEqual(parseKyrgyzPost(fixture('delivered'), DELIVERED).events);
    expect(reversed.events).toHaveLength(8);
    const unknown = parseKyrgyzPost(edited('outbound', (rows) => { rows.push({ EventName: 'Образец события', date: '2026-05-09T09:00:00' }); }), OUTBOUND);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Образец события',
      last_update_local: '2026-05-09T09:00:00' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-09T09:00:00', description: 'Образец события' });
    const alone = parseKyrgyzPost([{ EventName: 'Образец события', date: '2026-05-09T09:00:00' }], OUTBOUND);
    expect(alone).toMatchObject({ status: 'unknown', last_status_text: 'Образец события' });
    expect(alone.current_stage).toBeUndefined();
  });

  it('reads the empty list as missing and a block page as a challenge, even with HTTP 200', async () => {
    expect(() => parseKyrgyzPost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const lookup = (body: string, status = 200) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 400)).rejects.toMatchObject({ kind: 'challenge' });
    // WordPress's answer to an action it does not have.
    await expect(lookup('0', 400)).rejects.toMatchObject({ kind: 'transport', status: 400 });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('outbound')}`)).resolves.toMatchObject({ status: 'in_transit' });
  });

  it('rejects changed replies', () => {
    for (const payload of [null, 0, {}, 'Sample', { data: [] },
      edited('delivered', (rows) => { (rows as unknown[])[1] = 'scan'; }),
      edited('delivered', (rows) => { rows[1]!.EventName = ' '; }),
      edited('delivered', (rows) => { rows[1]!.EventName = null; }),
      edited('delivered', (rows) => { rows[1]!.EventName = ['Поступило в ЦМПОЛ']; }),
      edited('delivered', (rows) => { rows[1]!.EventName = 'Офис: SAMPLE'; }),
      edited('delivered', (rows) => { rows[1]!.date = '11.03.2026 12:20'; }),
      edited('delivered', (rows) => { rows[1]!.date = '2026-02-30T12:20:45'; }),
      edited('delivered', (rows) => { rows[1]!.date = '2026-03-11T24:00:00'; }),
      edited('delivered', (rows) => { rows[1]!.date = '2026-03-11T12:20:45+06:00'; }),
      edited('delivered', (rows) => { rows[1]!.date = '0001-01-01T00:00:00'; }),
      edited('delivered', (rows) => { rows[1]!.date = null; }),
      edited('delivered', (rows) => { rows.splice(0, rows.length, ...Array.from({ length: 501 }, () => rows[0]!)); })]) {
      expect(() => parseKyrgyzPost(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseKyrgyzPostReply('[{"EventName":', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015KG', 'ZZ00000001KG', 'ZZ000000014KGX', '1234567890123', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeKyrgyzPostNumber(' zz-000-000-031 kg ')).toBe(OUTBOUND);
    expect(() => parseKyrgyzPost(fixture('delivered'), 'ZZ000000015RU')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-16T15:27:09' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too Many Requests',
      { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Kyrgyz Post to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'kyrgyz-post' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'kyrgyz-post', source: 'kyrgyz-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === KYRGYZ_POST_LOOKUP)).toBe(true);
  });

  it('leaves S10 codes with the postal fallback, which asks Kyrgyz Post first about the ones it issues', () => {
    expect(detectCarrierMatch(OUTBOUND)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(OUTBOUND)[0]).toBe('kyrgyz-post');
  });
});

describe('Kyrgyz Post status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, whatever office follows', () => {
    for (const entry of statuses.entries) {
      for (const wording of [entry.wording, `${entry.wording} Образец 7`]) {
        expect(kyrgyzPostWordingStage(wording), wording).toBe(entry.stage);
        expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'kyrgyz-post', providerCode: null, description: wording }), wording)
          .toEqual({ kind: 'mapped', stage: entry.stage });
      }
    }
    expect(kyrgyzPostStage('  вручено   получателю ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const wording of ['constructor', 'Вручено', 'Вручено отправителю', 'Поступило на таможню', 'Поступило в таможню', 'Образец события']) {
      expect(kyrgyzPostWordingStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('X', 'поступило в цмпол')).toBeUndefined();
    expect(kyrgyzPostStage('')).toBeNull();
  });
});

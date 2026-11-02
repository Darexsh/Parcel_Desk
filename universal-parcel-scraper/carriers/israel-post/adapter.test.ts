import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, IsraelPostTracker, ISRAEL_POST_ENDPOINT } from './adapter.js';
import { parseIsraelPost } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'ZZ000000014IL';
const fixture = readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const payload = () => JSON.parse(fixture) as { ItemCode: unknown; Maslul: Record<string, unknown>[] };
const reply = (body = fixture, status = 200) => new Response(body, { status });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0', env: {}, trawl: null, browserExecutablePath: null });

describe('Israel Post guest tracking', () => {
  it('reads the whole identifier through the guest route using the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply());
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await new IsraelPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER, { budgetMs: 2000.5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(ISRAEL_POST_ENDPOINT + NUMBER);
    const init = fetcher.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Ocp-Apim-Subscription-Key': expect.any(String),
    } });
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(new Headers(init.headers).has('Cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'israel-post', step: 'direct', outcome: 'ok' }));
  });

  it('preserves days and same-day order, deduplicates scans and leaves foreign history open', () => {
    const result = parseIsraelPost(payload(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-03-12', history_truncated: true });
    expect(result.events!.map(e => [e.local_time, e.provider_code, e.stage])).toEqual([
      ['2026-03-12', '5', 'delivered'], ['2026-03-12', '3', 'in_transit'], ['2026-03-10', '23', 'accepted'],
    ]);
    expect(result.events!.every(e => e.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|payment|SenderName|DeliveryAddress/);
    expect(result.delivered_at).toBeUndefined();
  });

  it('requires whole identity and valid dated scans, including when the history is empty', () => {
    for (const item of [null, [], {}, { ...payload(), ItemCode: NUMBER + 'EXTRA' }, { ...payload(), ItemCode: 123 },
      { ...payload(), Maslul: null }, { ...payload(), Maslul: Array(501).fill(payload().Maslul[0]) }]) {
      expect(() => parseIsraelPost(item, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const Maslul of [[], payload().Maslul]) {
      expect(() => parseIsraelPost({ ItemCode: 'ZZ000000028IL', Maslul }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const patch of [{ StatusDate: '31/02/2026' }, { StatusDate: '12/03/2026 10:00' }, { CategoryCode: {} }, { Status: {} }, { Status: '' }]) {
      const data = payload(); Object.assign(data.Maslul[0]!, patch);
      expect(() => parseIsraelPost(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps the echoed empty shell inconclusive in tracking and recognition', async () => {
    const empty = JSON.stringify({ ...payload(), Maslul: [], CategoryCode: 9, CategoryName: 'מיועד להישלח אליך' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(empty));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes only actual history and keeps unknown categories unmapped', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply());
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T00:00:00' });
    const data = payload(); data.Maslul[0]!.CategoryCode = 999;
    const result = parseIsraelPost(data, NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]!.stage).toBeUndefined();
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
  });

  it('keeps an intended return nonterminal', () => {
    const data = payload();
    data.Maslul[0] = { CategoryCode: 6, StatusDate: '14/03/2026', Status: 'לא נדרש בידי הנמען ויוחזר לשולח' };
    expect(parseIsraelPost(data, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception' });
  });

  it('accepts imported S10 items and domestic courier identifiers without widening detection', async () => {
    const imported = 'ZZ000000014DE';
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture.replaceAll(NUMBER, imported)))).track({ number: imported }))
      .resolves.toMatchObject({ status: 'delivered' });
    const domestic = '00000000001IL';
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture.replaceAll(NUMBER, domestic)))).track({ number: domestic }))
      .resolves.toMatchObject({ status: 'delivered' });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015IL', '12345678', '00000000001RG', 'ABC']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(recognitionCandidates(NUMBER).some(c => c.carrier === 'israel-post')).toBe(true);
  });

  it.each([[302, 'transport'], [401, 'challenge'], [403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [500, 'indeterminate']] as const)(
    'keeps HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('{}', status));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('distinguishes block pages from broken JSON and retries only network failures', async () => {
    for (const [body, kind] of [['<title>Access Denied</title>', 'challenge'], ['broken', 'schema'], ['{}', 'schema']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply());
    await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, NIPPON_EXPRESS_ENDPOINT, NipponExpressTracker } from './adapter.js';
import { normalizeNipponExpressNumber, parseNipponExpress } from './parser.js';
import { nipponExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const TRANSIT = '00912345678904';
const OTHER = '312345678901';
const ABSENT = '51234567895';
// 10:00 on 16 October 2026 in Tokyo.
const NOW = Date.UTC(2026, 9, 16, 1);
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const parse = (html: string, number = TRANSIT, now = NOW) => parseNipponExpress(html, number, now);
const withClock = (clock: string) => page('transit').replace(/10\/14&nbsp;\s*19:45/, clock);

// Node decodes Shift_JIS but has no encoder: the decoder's own table gives each character its bytes.
const decoder = new TextDecoder('shift_jis');
const SHIFT_JIS = new Map<string, number[]>();
for (let lead = 0x81; lead <= 0xfc; lead++) {
  if (lead >= 0xa0 && lead < 0xe0) continue;
  for (let trail = 0x40; trail <= 0xfc; trail++) {
    const char = decoder.decode(Uint8Array.of(lead, trail));
    if (trail !== 0x7f && char.length === 1 && char !== '�' && !SHIFT_JIS.has(char)) SHIFT_JIS.set(char, [lead, trail]);
  }
}
const shiftJis = (text: string) => Uint8Array.from([...text].flatMap((char) => {
  if (char.charCodeAt(0) < 0x80) return [char.charCodeAt(0)];
  const bytes = SHIFT_JIS.get(char);
  if (!bytes) throw new Error(`No Shift_JIS bytes for ${char}`);
  return bytes;
}));
const reply = (body: string, status = 200) => new Response(status === 200 ? shiftJis(body) : body,
  { status, headers: { 'Content-Type': 'text/html; charset=Windows-31J' } });
const utf8 = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const CHALLENGE = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><h1>Request blocked</h1></body></html>';

describe('Nippon Express tracking adapter', () => {
  it('asks the air tracker’s list once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new NipponExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => NOW });
    await expect(tracker.fetch(' 0091-2345-678904 ', { budgetMs: 1000.5 })).resolves.toMatchObject({
      status: 'in_transit', last_status_text: '配達店へ輸送中です。', last_update: '2026-10-14T10:45:00Z', service_name: '国内航空貨物',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${NIPPON_EXPRESS_ENDPOINT}?LANG=JP&denpyoNo1=${TRANSIT}`);
    expect(String(url)).toBe('https://lp-trace.nittsu.co.jp/web/webarpaa702.srv?LANG=JP&denpyoNo1=00912345678904');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'nippon-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the list’s row as a summary dated in Tokyo, without the session, the token or the days without a year', () => {
    const result = parse(page('transit'));
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '配達店へ輸送中です。', last_update: '2026-10-14T10:45:00Z', expected_delivery: null,
      service_name: '国内航空貨物', timezone: 'Asia/Tokyo', summary_only: true, events: [],
    });
    for (const kept of ['SYNTHETIC', 'A01', '10/13', '10/15', '2026-10-13', '2026-10-15']) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('keeps a status the map does not know, unstaged, and a status without its clock undated', () => {
    const unknown = parse(page('transit').replace('配達店へ輸送中です。', '新しい状況です。'));
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: '新しい状況です。', last_update: '2026-10-14T10:45:00Z', summary_only: true, events: [] });
    expect(unknown.current_stage).toBeUndefined();
    expect(parse(page('transit').replace(/<br \/>\s*10\/14&nbsp;\s*19:45/, ''))).toMatchObject({ status: 'in_transit', last_update: null });
    const plain = parse(page('transit').replace('国内航空貨物&nbsp;', '&nbsp;'));
    expect(plain.service_name).toBeUndefined();
  });

  it('gives the status clock the latest year that puts it no later than the day after the lookup in Japan', () => {
    expect(parse(withClock('12/28&nbsp;19:45'), TRANSIT, Date.UTC(2027, 0, 3, 1)).last_update).toBe('2026-12-28T10:45:00Z');
    expect(parse(withClock('1/2&nbsp;08:05'), TRANSIT, Date.UTC(2027, 0, 3, 1)).last_update).toBe('2027-01-01T23:05:00Z');
    expect(parse(withClock('10/17&nbsp;09:00')).last_update).toBe('2026-10-17T00:00:00Z');
    expect(parse(withClock('10/18&nbsp;09:00')).last_update).toBe('2025-10-18T00:00:00Z');
    expect(parse(withClock('2/29&nbsp;12:00')).last_update).toBe('2024-02-29T03:00:00Z');
    // The day starts at midnight in Tokyo, nine hours before UTC.
    expect(parse(withClock('10/16&nbsp;00:30'), TRANSIT, Date.UTC(2026, 9, 15, 15, 1)).last_update).toBe('2026-10-15T15:30:00Z');
    for (const clock of ['2/30&nbsp;12:00', '13/01&nbsp;12:00', '10/14&nbsp;24:00', '10/14&nbsp;19:60', '2026/10/14&nbsp;19:45', '10/14', '19:45']) {
      expect(() => parse(withClock(clock)), clock).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the row to the requested number and rejects lists it cannot read', () => {
    expect(() => parse(page('transit'), OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const row = /<tr>\s*<td bgcolor[\s\S]*?<\/tr>/.exec(page('transit'))![0];
    for (const html of [
      page('transit').replace(`>${TRANSIT}<`, `>${OTHER}<`),
      page('transit').replace(`okurijoNum=${TRANSIT}`, `okurijoNum=${OTHER}`),
      page('transit').replace(`>${TRANSIT}</a>`, `>${TRANSIT}</a><a href="#">${TRANSIT}</a>`),
      page('transit').replace(row, `${row}${row.replace(new RegExp(TRANSIT, 'g'), OTHER)}`),
      page('transit').replace('<th>最新状況</th>', '<th>状況</th>'),
      page('transit').replace('<th>扱区分</th>', ''),
      page('transit').replace('class="listtabale"', 'class="listtabale"></table><table class="listtabale"'),
      page('transit').replace(row, row.replace('</tr>', '<td></td></tr>')),
      page('transit').replace('配達店へ輸送中です。', ''),
      page('transit').replace('配達店へ輸送中です。', '配達店へ輸送中です。<br />一部<br />'),
      page('transit').replace(row, row.repeat(21)),
      '<html><body>メンテナンス中です。</body></html>']) {
      expect(() => parse(html), html.slice(-200, -100)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of [page('not-found').replace(ABSENT, OTHER), page('not-found').replace('は存在しません。', 'を確認しています。')]) {
      expect(() => parse(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A number the tracker lists twice belongs to more than one shipment.
    expect(() => parse(page('transit').replace(row, row.repeat(2)))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(page('transit').replace(row, ''))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads only the row saying the number has no data as a missing shipment', () => {
    expect(() => parse(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(page('not-found').replace('該当データ無し', '送り状番号違い'), ABSENT)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parse(page('not-found').replace('該当データ無し', 'システムエラー'), ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page after a lost session, the search form and block pages are no answer about the shipment.
    expect(() => parse(page('error'), ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(page('search'), ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of [CHALLENGE, '<html><head><title>Access Denied</title></head><body></body></html>',
      '<html><head><script>window.awsWafCookieDomainList = [];</script></head><body></body></html>']) {
      expect(() => parse(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes the tracker’s slip numbers only, without a request', async () => {
    expect(normalizeNipponExpressNumber('５１２３４５６７８９５')).toBe(ABSENT);
    expect(normalizeNipponExpressNumber('312-345-678-901')).toBe(OTHER);
    // The tracker also takes a last digit that is the rest divided by nine, and eight digits.
    for (const number of ['312345678903', '10000001', '100000000001']) expect(normalizeNipponExpressNumber(number)).toBe(number);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['312345678902', '1234567', '100000000000000', 'NX312345678901', '00912345678905']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('decodes the Windows-31J page, reads the no-data row as not found and recognizes any listed shipment, from plain HTTP', async () => {
    const unstaged = page('transit').replace('配達店へ輸送中です。', '新しい状況です。');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('transit'))).mockResolvedValueOnce(reply(unstaged))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(utf8(page('transit')));
    const tracker = new NipponExpressTracker({ fetcher, now: () => NOW });
    await expect(tracker.recognize(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-14T10:45:00Z' });
    // The list names the number whatever the status says.
    await expect(tracker.recognize(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-14T10:45:00Z' });
    await expect(tracker.recognize(ABSENT)).resolves.toEqual({ known: false });
    await expect(tracker.fetch(ABSENT)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(tracker.fetch(TRANSIT)).resolves.toMatchObject({ last_status_text: '配達店へ輸送中です。' });
    expect(fetcher).toHaveBeenCalledTimes(5);
    const latin = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html></html>', { headers: { 'Content-Type': 'text/html; charset=ISO-8859-1' } }));
    await expect(carrier(latin).track({ number: TRANSIT })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => utf8(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a block page served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    const challenged = vi.fn<typeof fetch>().mockImplementation(async () => utf8(CHALLENGE));
    await expect(carrier(challenged).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(challenged).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'challenge' });
    for (const response of [() => new Response(null, { status: 302, headers: { Location: 'https://lp-trace.nittsu.co.jp/web/webarpaa701.srv' } }),
      () => new Response(null, { status: 301, headers: { Location: 'https://www.nipponexpress.com/' } }), () => reply(''), () => reply('  ')]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(250_000)));
    await expect(carrier(large).track({ number: TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('not-found')));
    await expect(carrier(flaky).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('transit')));
    await expect(carrier(immediate).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(down).track({ number: TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('stages the statuses the corpus records and declares its map', () => {
    for (const entry of statuses.entries) {
      expect(nipponExpressStage(entry.wording), entry.wording).toBe('stage' in entry ? entry.stage : undefined);
      expect(statusMapAnswer({ carrier: 'nippon-express', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual('stage' in entry ? { kind: 'mapped', stage: entry.stage } : { kind: 'unknown' });
    }
    expect(statusMap.stage('CODE', '配達店へ輸送中です。')).toBeUndefined();
    expect(nipponExpressStage(' 配達店へ輸送中です。 ')).toBe('in_transit');
  });
});

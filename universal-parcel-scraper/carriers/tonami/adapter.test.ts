import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, tonamiTrackingUrl } from './adapter.js';
import { normalizeTonamiNumber, parseTonami } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '0000000011';
const UNKNOWN = '0000000022';
// The fixtures' days are in September; the lookup is a month later.
const NOW = Date.parse('2026-10-20T03:00:00Z');

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const delivered = () => text('delivered.html');
/** The delivered page with one milestone row's day, place and remark replaced. */
const milestone = (page: string, name: string, day: string, branch = '試験支店') => page.replace(
  new RegExp(`(<th>${name}</th>\\s*<td>)[^<]*(</td>\\s*<td>)[^<]*(</td>)`), `$1${day}$2${branch}$3`);

describe('Tonami numbers', () => {
  it('takes ten digits with their check digit, printed with hyphens or in full width', () => {
    expect(normalizeTonamiNumber(' 0000-0000-11 ')).toBe(NUMBER);
    expect(normalizeTonamiNumber('００００００００１１')).toBe(NUMBER);
    expect(() => normalizeTonamiNumber('0000000012')).toThrow('check digit');
    for (const other of ['000000011', '00000000011', 'A000000011']) expect(() => normalizeTonamiNumber(other), other).toThrow('ten digits');
  });

  it('reads a link to the tracker', () => {
    expect(parseTrackingInput(`https://trc1.tonami.co.jp/trc/search3/excSearch3?id%5B0%5D=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'tonami' });
  });
});

describe('Tonami tracking', () => {
  it('asks the tracker’s page for the number', async () => {
    const fetcher = replying(() => html(delivered()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://trc1.tonami.co.jp/trc/search3/excSearch3?id%5B0%5D=${NUMBER}`);
    expect(tonamiTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the milestones reached, newest first, on days and the delivery’s minute in Japan', () => {
    const result = parseTonami(delivered(), NUMBER, NOW);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: '配達済み',
      last_update: '2026-09-16T12:04:00+09:00', last_update_local: null, delivered_at: '2026-09-16T12:04:00+09:00',
      weight_kg: 1020, timezone: 'Asia/Tokyo',
    });
    const partner = '試験運送（株）試験支店';
    expect(result.events).toEqual([
      { time: '2026-09-16T12:04:00+09:00', location: partner, description: '配完', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-09-16', location: partner, description: '持出', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-09-14', location: partner, description: '中継', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-09-14', location: '試験支店', description: '発送', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-09-14', location: '試験支店', description: '荷受', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    // The phone numbers, the towns and the partner's number stay out.
    expect(JSON.stringify(result)).not.toMatch(/000-000-0000|試験県|0000000000000/);
  });

  it('dates each day in the latest year that does not put it after tomorrow in Japan', () => {
    const page = milestone(milestone(delivered(), '荷受', '12月30日'), '発送', '01月11日');
    const days = (now: string) => parseTonami(page, NUMBER, Date.parse(now)).events!
      .filter((event) => ['荷受', '発送'].includes(event.description!)).map((event) => event.local_time);
    // 10 January in Japan: the eleventh is tomorrow, the thirtieth of December last year.
    expect(days('2027-01-10T03:00:00Z')).toEqual(['2027-01-11', '2026-12-30']);
    expect(days('2027-01-09T03:00:00Z')).toEqual(['2026-12-30', '2026-01-11']);
    expect(parseTonami(milestone(delivered(), '荷受', '02月29日'), NUMBER, NOW).events!.at(-1)!.local_time).toBe('2024-02-29');
  });

  it('puts a later day first when a milestone came back out of the tracker’s order, and reads a step from its rows', () => {
    const redelivered = milestone(milestone(delivered(), '持帰', '09月16日', '試験運送（株）試験支店'), '持出', '09月17日', '試験運送（株）試験支店')
      .replace(/<td>09月16日 12:04<\/td>/, '<td></td>').replace(/<td colspan='3'>配達済み<\/td>/, "<td colspan='3'>持出中</td>");
    const result = parseTonami(redelivered, NUMBER, NOW);
    expect(result.events!.slice(0, 2).map((event) => [event.description, event.local_time])).toEqual([['持出', '2026-09-17'], ['持帰', '2026-09-16']]);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: '持出中', last_update: null, last_update_local: '2026-09-17' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the tracker’s list row for a number it does not hold as not found', async () => {
    const fetcher = replying(() => html(text('not-found.html')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a moved route, a refusal, a firewall page, a rate limit and an outage apart from a missing parcel', async () => {
    const cases: [Response, string][] = [
      [html('', { status: 301, headers: { Location: 'https://www.tonami.co.jp/' } }), 'transport'],
      [html('', { status: 404 }), 'transport'],
      [html('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [html('', { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [html('', { status: 500 }), 'indeterminate'],
      [html('', { status: 503 }), 'maintenance'],
      [html('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [html('<html><body>メンテナンス中</body></html>'), 'schema'],
      // The not-found page names another number than the one asked.
      [html(text('not-found.html')), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves another shipment, a changed page and an unreadable day open or failed, never found', () => {
    expect(() => parseTonami(delivered().replace(`<td colspan='3'>${NUMBER}`, "<td colspan='3'>0000000033"), NUMBER, NOW)).toThrow('another shipment');
    expect(() => parseTonami(delivered().replace('<th >日時</th>', '<th >日付</th>'), NUMBER, NOW)).toThrow('changed its history table');
    expect(() => parseTonami(delivered().replace("<td colspan='3'>配達済み</td>", "<td colspan='3'></td>"), NUMBER, NOW)).toThrow('without its state');
    expect(() => parseTonami(text('not-found.html').replace('該当伝票番号なし', ''), UNKNOWN, NOW)).toThrow('without a shipment');
    for (const day of ['13月01日', '02月30日', '09月16日 24:00', '9/16']) {
      expect(() => parseTonami(milestone(delivered(), '荷受', day), NUMBER, NOW), day).toThrow('invalid scan time');
    }
  });

  it('recognizes a number its tracker holds, and not one it does not', async () => {
    await expect(carrier(replying(() => html(delivered()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(text('not-found.html')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).recognize!('0000000012')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Tonami status map', () => {
  it('stages every milestone and state it lists, and the app reads it', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'tonami', providerCode: null, description: '配完' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'tonami', providerCode: null, description: '持出中' })).toEqual({ kind: 'unknown' });
  });
});

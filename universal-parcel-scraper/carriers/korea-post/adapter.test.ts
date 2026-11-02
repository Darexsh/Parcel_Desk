import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, KoreaPostTracker, parse } from './adapter.js';

const NUMBER = 'EE000000005KR';
const DOMESTIC = '6000000000000';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('Korea Post international history', () => {
  it('binds the requested table, reverses portal order and retains unresolved wall clocks', () => {
    const result = normalizeCarrierResult(parse(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null });
    expect(result.events).toHaveLength(5);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-03-05T11:30:00', description: 'Delivery complete' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'failed_attempt', 'customs', 'in_transit', 'accepted']);
    expect(result.events?.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.delivered_at).toBeUndefined();
    expect(result.timezone).toBeUndefined();
  });

  it('requires an exact unique identity in the result table rather than the form', () => {
    const html = fixture().replace(NUMBER, 'EE000000014KR');
    expect(() => parse(`<input value="${NUMBER}">${html}`, NUMBER)).toThrow('different or ambiguous');
    const $ = load(fixture());
    $('body').append($('table[summary="Basic Information"]').clone());
    expect(() => parse($.html(), NUMBER)).toThrow('different or ambiguous');
  });

  it('only accepts the exact identity-bound missing-item row', () => {
    expect(() => parse(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('not-found').replace('is not found.', 'is temporarily unavailable.'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(fixture('not-found').replace('Your item number <strong>EE000000005KR</strong>', 'Your item number <strong>EE000000014KR</strong>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['date', 'header', 'empty', 'cell'])('rejects an invalid %s rather than promoting an older scan', (mode) => {
    const $ = load(fixture());
    const history = $('table').last();
    if (mode === 'date') history.find('tbody tr').last().find('td').first().text('12:20 30-Feb-2026');
    if (mode === 'header') history.find('th').first().text('Changed Date');
    if (mode === 'empty') history.find('tbody').empty();
    if (mode === 'cell') history.find('tbody tr').last().find('td').last().remove();
    expect(() => parse($.html(), NUMBER)).toThrow();
  });

  it('does not confuse delivery to a destination operator with final delivery', () => {
    const $ = load(fixture());
    $('table').last().find('tbody tr').slice(2).remove();
    expect(parse($.html(), NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Delivered to Destination Post' });
  });

  it('deduplicates repeated scans and leaves new wording unmapped', () => {
    const $ = load(fixture());
    const history = $('table').last();
    history.find('tbody tr').last().find('td').eq(1).text('New carrier wording');
    history.find('tbody').append(history.find('tbody tr').last().clone());
    const result = parse($.html(), NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.events?.[0]!.stage).toBeUndefined();
    expect(result.events).toHaveLength(5);
  });

  it('proves declared capabilities with synthetic history', () => {
    const result = parse(fixture(), NUMBER);
    const domestic = parse(fixture('domestic'), DOMESTIC);
    const checks: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.some((event) => event.location)),
      delivered_at: domestic.delivered_at === '2026-09-30T01:08:00Z' };
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    for (const capability of metadata.capabilities) expect(checks[capability], capability).toBe(true);
  });
});

describe('Korea Post domestic history', () => {
  it('reads the status label and office of each scan in Korean time', () => {
    const result = normalizeCarrierResult(parse(fixture('domestic'), DOMESTIC));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '배달완료',
      last_update: '2026-09-30T01:08:00Z', delivered_at: '2026-09-30T01:08:00Z' });
    expect(result.events?.[0]).toMatchObject({ time: '2026-09-30T01:08:00Z', local_time: '2026-09-30T10:08:00', description: '배달완료', location: 'EXAMPLE DELIVERY' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.at(-1)).toMatchObject({ time: '2026-09-28T09:05:00Z', description: '운송장출력', location: 'EXAMPLE ORIGIN' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('keeps the latest scan in transit until delivery', () => {
    const $ = load(fixture('domestic'));
    $('table').last().find('tbody > tr').slice(-2).remove();
    const result = parse($.html(), DOMESTIC);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '도착' });
    expect(result.delivered_at).toBeUndefined();
  });

  it('only accepts the exact identity-bound missing-item notice', () => {
    expect(() => parse(fixture('domestic-not-found'), DOMESTIC)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('domestic-not-found').replace('찾지 못했습니다', '조회할 수 없습니다'), DOMESTIC))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(fixture('domestic-not-found').replace(`>${DOMESTIC}<`, '>6000000000001<'), DOMESTIC))
      .toThrow('different or ambiguous');
    const $ = load(fixture('domestic-not-found'));
    $('table').first().find('tbody > tr').last().remove();
    expect(() => parse($.html(), DOMESTIC)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires one basic-information table for the requested number', () => {
    expect(() => parse(fixture('domestic').replace(`>${DOMESTIC}<`, '>6000000000001<'), DOMESTIC)).toThrow('different or ambiguous');
    const $ = load(fixture('domestic'));
    $('body').append($('table').first().clone());
    expect(() => parse($.html(), DOMESTIC)).toThrow('different or ambiguous');
  });

  it.each(['date', 'header', 'label', 'cell'])('rejects an invalid %s rather than promoting an older scan', (mode) => {
    const $ = load(fixture('domestic'));
    const history = $('table').last();
    if (mode === 'date') history.find('tbody > tr').last().find('td').first().text('2026.02.30');
    if (mode === 'header') history.find('th').first().text('일자');
    if (mode === 'label') history.find('tbody > tr').last().find('span.evtnm').remove();
    if (mode === 'cell') history.find('tbody > tr').last().find('td').last().remove();
    expect(() => parse($.html(), DOMESTIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([['인수완료', 'accepted'], ['집하완료', 'accepted'], ['운송장출력', 'registered'], ['배달준비', 'out_for_delivery']])('maps the domestic label %s', (wording, stage) => {
    const result = parse(fixture('domestic').replace('<span class="evtnm">배달완료</span>', `<span class="evtnm">${wording}</span>`), DOMESTIC);
    expect(result).toMatchObject({ current_stage: stage, last_status_text: wording });
    expect(result.delivered_at).toBeUndefined();
  });

  it('leaves new wording unmapped', () => {
    const result = parse(fixture('domestic').replace('<span class="evtnm">배달완료</span>', '<span class="evtnm">새 처리현황</span>'), DOMESTIC);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '새 처리현황' });
    expect(result.events?.[0]!.stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
  });
});

describe('Korea Post retrieval', () => {
  it('submits one fresh anonymous form with an HTML accept header', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.track({ number: 'ee 000.000-005 kr' })).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://trace.epost.go.kr/xtts/servlet/kpl.tts.common.svl.SttSVL');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ target_command: 'kpl.tts.tt.epost.cmd.RetrieveEmsTraceEngCmd',
      JspURI: '/xtts/tt/epost/ems/EmsSearchResultEng.jsp', POST_CODE: NUMBER });
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    expect(new Headers(init?.headers).get('Accept')).toContain('text/html');
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited']])('does not turn HTTP %s into shipment absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status: Number(status) }));
    await expect(new KoreaPostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic number from the domestic page with one anonymous GET', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture('domestic')));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.track({ number: '6000-0000-00000' })).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=6000000000000&displayHeader=N');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('Accept')).toContain('text/html');
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
  });

  it('rejects other inputs before I/O, preserves cancellation and caps response size', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new KoreaPostTracker({ fetcher: unused }).fetch('600000000000')).rejects.toMatchObject({ kind: 'invalid_input' });
    // The adapter refuses it before its lookup starts, so an ended signal does not hide it.
    await expect(adapter({ fetcher: unused, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER })
      .track({ number: '600000000000' }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new KoreaPostTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new KoreaPostTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});

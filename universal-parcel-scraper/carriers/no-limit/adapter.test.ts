import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NO_LIMIT_TRACKER, NoLimitTracker } from './adapter.js';
import { noLimitFormFields, normalizeNoLimitNumber, parseNoLimit } from './parser.js';
import { noLimitMappedStage, noLimitStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'P/40017/LSMP/2026';
const UNKNOWN = 'P/40099/LSMP/2026';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: { status?: number; headers?: [string, string][] } = {}) => new Response(body, { status: init.status,
  headers: [['Content-Type', 'text/html; charset=utf-8'], ...init.headers ?? []] });
// The site's load balancer's and firewall's cookies, as the form's page sets them.
const COOKIES: [string, string][] = [['Set-Cookie', 'NSC_SAMPLE_443=0123abcd;expires=Tue, 03-Mar-2026 10:00:00 GMT;path=/;secure;httponly'],
  ['Set-Cookie', 'nl-cname=SampleCookie==; Domain=.nolimit.pl; Path=/'], ['Set-Cookie', 'broken cookie=1; Path=/']];
/** The form's page for a GET, and the answer for the POST that posts it back. */
const site = (answer: () => Response, form: () => Response = () => html(text('form.html'), { headers: COOKIES })) =>
  vi.fn<typeof fetch>().mockImplementation(async (_url, init) => (init?.method === 'POST' ? answer() : form()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const delivered = () => text('delivered.html');
/** The status row at a clock, as the page writes it. */
const rowOf = (clock: string) => new RegExp(`<tr[^>]*>\\s*<td>${clock.replace('|', '\\|')}</td>[\\s\\S]*?</tr>`);
// The shipment before its delivery.
const withCourier = () => delivered().replace(rowOf('2026-03-03 | 12:50'), '');

describe('No Limit HTTP adapter', () => {
  it('opens the English tracking page and posts its form back with the slashed number, the page’s state and its cookies', async () => {
    const fetcher = site(() => html(delivered()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NoLimitTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' p 40017 lsmp 2026 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[formUrl, formInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(formUrl).toBe(NO_LIMIT_TRACKER);
    expect(formInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(NO_LIMIT_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0', Origin: 'https://follow.nolimit.pl', Referer: NO_LIMIT_TRACKER,
      Cookie: 'NSC_SAMPLE_443=0123abcd; nl-cname=SampleCookie==',
    } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      __VIEWSTATE: '/wESampleViewState+form/AQ==',
      __VIEWSTATEGENERATOR: '0A1B2C3D',
      __EVENTVALIDATION: '/wESampleEventValidation+form/AQ==',
      as_sfid: 'AAAAAASampleFirewallSession_form-AQ==',
      as_fid: '00000000000000000000000000000000form0000',
      __EVENTTARGET: '',
      ctl00$ContentPlaceHolder2$szukaj1RadioButtonList1: '1',
      ctl00$ContentPlaceHolder2$szukajTextBox1: NUMBER,
      ctl00$ContentPlaceHolder2$szukajButton1: 'SEARCH',
    });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'no-limit', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('posts without a cookie when the page sets none', async () => {
    const fetcher = site(() => html(delivered()), () => html(text('form.html')));
    await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect((fetcher.mock.calls[1]![1]!.headers as Record<string, string>).Cookie).toBeUndefined();
  });

  it('keeps the statuses as wall clocks with their places, newest first', () => {
    const result = parseNoLimit(delivered(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-03T12:50:00', expected_delivery: null });
    // A status at two branches at the same minute is two, the lower row the newer.
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-03T12:50:00', 'Delivered', 'EXAMPLE VILLAGE', 'delivered'],
      ['2026-03-03T07:25:00', 'Issued to courier', 'PRZYKŁADOWO', 'out_for_delivery'],
      ['2026-03-03T05:10:00', 'Warehouse', 'PRZYKŁADOWO', 'in_transit'],
      ['2026-03-02T21:05:00', 'In realization', 'PRZYKŁADOWO', 'in_transit'],
      ['2026-03-02T21:05:00', 'In realization', 'SAMPLEVILLE', 'in_transit'],
      ['2026-03-02T15:40:00', 'Warehouse', 'SAMPLEVILLE', 'in_transit'],
      ['2026-03-02T09:15:00', 'Order accepted', undefined, 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The sender's references and the loading and unloading places are not kept.
    expect(JSON.stringify(result)).not.toMatch(/NL000000017|1000017|Sampleville|Example Village/);
    // A row the page lists twice is kept once.
    const twice = delivered().replace(rowOf('2026-03-03 | 07:25'), (row) => row + row);
    expect(parseNoLimit(twice, NUMBER).events).toHaveLength(7);
  });

  it('reads a shipment on its way, and a status the map does not know', () => {
    expect(parseNoLimit(withCourier(), NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Issued to courier', last_update_local: '2026-03-03T07:25:00' });
    // A status the map does not know goes to the shared wording rules, and one they do not know has no stage.
    const returned = parseNoLimit(withCourier().replace('>Issued to courier<', '>Returned to sender<'), NUMBER);
    expect(returned).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language' });
    const odd = parseNoLimit(withCourier().replace('>Issued to courier<', '>Sample state<'), NUMBER);
    expect(odd).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample state' });
    expect(odd.events![0]).not.toHaveProperty('stage');
  });

  it('reads the page’s not-found label as not found, for the number in its field', async () => {
    expect(() => parseNoLimit(text('not-found.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(site(() => html(text('not-found.html')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A page for another number, or without the form's field, says nothing about this one.
    expect(() => parseNoLimit(text('not-found.html'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseNoLimit(text('not-found.html').replace(/<input name="ctl00\$ContentPlaceHolder2\$szukajTextBox1"[^>]*>/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps only a shipment the label says was searched with the whole number asked', () => {
    expect(() => parseNoLimit(delivered(), 'P/40017/LSMP/2025'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'No Limit answered for another shipment' }));
    expect(() => parseNoLimit(delivered().replace('</strong> P/40017/LSMP/2026', '</strong> P/4001/LSMP/2026'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The label names the number with its slashes; the number asked can come without them.
    expect(parseNoLimit(delivered(), 'P40017LSMP2026')).toMatchObject({ status: 'delivered' });
    expect(() => parseNoLimit(delivered().replace('<strong>Shipment number:</strong>', '<strong>Parcel number:</strong>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed page', () => {
    const page = delivered();
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      page.replace('id="ctl00_ContentPlaceHolder3_szukaj1Label1"', 'id="ctl00_ContentPlaceHolder3_label"'),
      page.replace('<th scope="col">Location</th>', '<th scope="col">Place</th>'),
      page.replace('<td>2026-03-02 | 09:15</td><td>&nbsp;</td>', '<td>2026-03-02 | 09:15</td>'),
      page.replace('>2026-03-02 | 09:15<', '>02.03.2026 09:15<'),
      page.replace('>2026-03-02 | 09:15<', '>2026-03-02 | 24:00<'),
      page.replace('>2026-03-02 | 09:15<', '>2026-02-30 | 09:15<'),
      page.replace('>Order accepted<', '> <'),
      text('not-found.html').replace('Shipment not found</span>', 'Shipment not found</span><table id="ctl00_ContentPlaceHolder3_stat1GridView"></table>'),
      page.replace(rowOf('2026-03-02 | 09:15'), (row) => row.repeat(501)),
    ].entries()) {
      expect(() => parseNoLimit(body, NUMBER), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a shipment without statuses', () => {
    const header = delivered().replace(/(<\/th>\s*<\/tr>)[\s\S]*?(\s*<\/table>)/, '$1$2');
    expect(() => parseNoLimit(header, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const none = delivered().replace(/<table class="stat1GridViewnl"[\s\S]*?<\/table>/, '');
    expect(() => parseNoLimit(none, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a firewall page, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (answer: () => Response, form?: () => Response) => carrier(site(answer, form)).track({ number: NUMBER });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(delivered()), () => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html(delivered()), () => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: [['Location', 'https://follow.nolimit.pl/error.aspx']] })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => html(delivered()), () => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    const stateless = text('form.html').replace(/<input type="hidden" name="__EVENTVALIDATION"[^>]*>/, '');
    await expect(lookup(() => html(delivered()), () => html(stateless))).rejects.toMatchObject({ kind: 'schema' });
    expect(() => noLimitFormFields(text('form.html').replace('value="1" checked="checked"', 'value="9"'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(site(() => new Response('', { status }))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    await expect(carrier(site(() => html(delivered()), () => new Response('', { status }))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });

  it('refuses what is no No Limit shipment number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1000000017', 'P/40017/SMP/2026', 'P/1234567/LSMP/2026', 'P/40017/LSMP/1999', 'P//LSMP/2026', 'X/40017/LSMP/2026', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const typed of [NUMBER, 'P40017LSMP2026', ' p/40017/lsmp/2026 ', 'P40017/LSMP/2026', 'P 40017 LSMP 2026']) {
      expect(normalizeNoLimitNumber(typed), typed).toBe('P40017LSMP2026');
    }
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(site(() => html(delivered()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(site(() => html(text('not-found.html')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('1000000017')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a slashed number to the adapter, filed under No Limit or not', async () => {
    for (const input of [{ number: NUMBER, carrier: 'no-limit' }, { number: NUMBER }]) {
      const fetcher = site(() => html(delivered()));
      const tracker = createTracker({ fetcher, providers: [], env: {} });
      await expect(tracker.track(input, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'no-limit', source: 'no-limit', result: { current_stage: 'delivered' } });
      expect(fetcher.mock.calls.some(([url]) => String(url) === NO_LIMIT_TRACKER)).toBe(true);
    }
  });
});

describe('No Limit status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'no-limit', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(noLimitStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'sample state')).toBeUndefined();
    expect(noLimitMappedStage('Issued to courier')).toBeUndefined();
    expect(noLimitMappedStage('issued to courier')).toBe('out_for_delivery');
    expect(noLimitStage('Returned to sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(noLimitStage('Sample state')).toBeNull();
    expect(statusMapAnswer({ carrier: 'no-limit', providerCode: null, description: 'Sample state' })).toEqual({ kind: 'unknown' });
  });
});

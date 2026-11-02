import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, APC_OVERNIGHT_ENDPOINT, ApcOvernightTracker } from './adapter.js';
import { parseApcOvernight } from './parser.js';
import { apcOvernightScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const JOURNEY = '2026030599000010001234';
const RETURNED = '2026020299000010005678';
const DELIVERED = '2026010599000010009012';
const ABSENT = '2026030599999999999991';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseApcOvernight>) =>
  result.events!.map(event => [event.local_time, event.description, event.stage, event.stage_source]);
// The search page for an absent waybill, echoing the one a request asked for.
const absent = (url: unknown) => reply(page('not-found').replace(ABSENT, new URL(String(url)).searchParams.get('id')!));

describe('APC Overnight tracking adapter', () => {
  it('asks the tracking page once for the whole waybill through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('journey')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ApcOvernightTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${JOURNEY.slice(0, 8)} ${JOURNEY.slice(8)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://apcchoice.apc-overnight.com/track-parcel?id=${JOURNEY}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'apc-overnight', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('merges the items’ journeys and the delivery records newest first, as wall clocks, once each', () => {
    const result = parseApcOvernight(page('journey'), JOURNEY);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Rearranged By Customer', last_update: null, last_update_local: '2026-03-08T09:30:00',
      expected_delivery: null, weight_kg: 12.5, service_name: 'Next Business Day Standard Parcel' });
    // Shared scans and the delivery records every item repeats appear once.
    expect(rows(result)).toEqual([
      ['2026-03-08T09:30:00', 'Delivery Rearranged By Customer', 'in_transit', 'none'],
      ['2026-03-06T06:58:00', 'At delivery depot', 'in_transit', 'carrier_map'],
      ['2026-03-06T00:19:00', 'At Hub', 'in_transit', 'carrier_map'],
      ['2026-03-06T00:12:00', 'At Hub', 'in_transit', 'carrier_map'],
      ['2026-03-05T18:05:00', 'Delivery Rearranged By Customer', 'accepted', 'none'],
      ['2026-03-05T17:40:00', 'At sending depot', 'accepted', 'carrier_map'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.location === undefined)).toBe(true);
    for (const name of ['journey', 'returned', 'delivered']) {
      const number = { journey: JOURNEY, returned: RETURNED, delivered: DELIVERED }[name]!;
      // Neither the depot, its postcode or email, nor the sender's reference is read.
      expect(JSON.stringify(parseApcOvernight(page(name), number)), name).not.toMatch(/EXAMPLE|ZZ99|depot999|REF-SAMPLE/);
    }
  });

  it('keeps a failed delivery as the stage behind a rearrangement and reads a return as such', () => {
    const result = parseApcOvernight(page('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned To Sender', weight_kg: 3,
      service_name: 'Next Business Day Non-Conveyable Parcel' });
    expect(rows(result)).toEqual([
      ['2026-02-13T16:10:00', 'Returned To Sender', 'returned', 'carrier_map'],
      ['2026-02-09T14:37:00', 'Carded', 'failed_attempt', 'carrier_map'],
      ['2026-02-09T08:20:00', 'Out for delivery', 'out_for_delivery', 'carrier_map'],
      ['2026-02-05T11:45:00', 'Delivery Rearranged By Customer', 'failed_attempt', 'none'],
      ['2026-02-03T15:02:00', 'Carded', 'failed_attempt', 'carrier_map'],
      ['2026-02-03T05:44:00', 'At delivery depot', 'in_transit', 'carrier_map'],
      ['2026-02-03T01:07:00', 'At Hub', 'in_transit', 'carrier_map'],
      ['2026-02-02T15:51:00', 'At sending depot', 'accepted', 'carrier_map'],
    ]);
    const rearranged = parseApcOvernight(page('returned').replace('Carded (09-Feb-2026 14:37)', 'Delivery Rearranged By Customer (09-Feb-2026 14:37)')
      .replace(/\s*<div class="pod-details">\s*<p>Returned To Sender[^<]*<\/p>\s*<\/div>/, ''), RETURNED);
    expect(rearranged).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Delivery Rearranged By Customer' });
    // A delivery once the consignment was sent back reaches its sender.
    const back = parseApcOvernight(page('returned').replace('<p>Returned To Sender (13-Feb-2026 16:10)</p>',
      '<p>Returned To Sender (13-Feb-2026 16:10)</p></div><div class="pod-details"><p>Delivered (16-Feb-2026 10:00)</p>'), RETURNED);
    expect(back).toMatchObject({ current_stage: 'returned', last_status_text: 'Delivered' });
  });

  it('reads an older consignment from its delivery records alone, and only the first line of each', () => {
    const result = parseApcOvernight(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-01-08T10:23:00', weight_kg: 20 });
    expect(rows(result)).toEqual([
      ['2026-01-08T10:23:00', 'Delivered', 'delivered', 'carrier_map'],
      ['2026-01-06T09:37:00', 'Carded', 'failed_attempt', 'carrier_map'],
    ]);
    const signed = parseApcOvernight(page('delivered').replaceAll('<p>Delivered (08-Jan-2026 10:23)</p>',
      '<p>Delivered (08-Jan-2026 10:23)</p><p>Signed by A. Example</p>'), DELIVERED);
    expect(JSON.stringify(signed)).not.toContain('Example');
    expect(signed.events).toEqual(result.events);
    // A known consignment without a row is no history, not a missing one.
    const empty = page('delivered').replace(/\s*<div class="pod-details">\s*<p>[^<]*<\/p>\s*<\/div>/g, '');
    expect(() => parseApcOvernight(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const shared = parseApcOvernight(page('delivered').replaceAll('Delivered (08-Jan-2026 10:23)', 'Delivered to neighbour (08-Jan-2026 10:23)'), DELIVERED);
    expect(shared).toMatchObject({ current_stage: 'delivered' });
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
    const unknown = parseApcOvernight(page('delivered').replaceAll('Delivered (08-Jan-2026 10:23)', 'Weighed (08-Jan-2026 10:23)'), DELIVERED);
    expect(unknown).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Weighed' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-01-08T10:23:00', description: 'Weighed' });
    // A summary without a weight or a service in APC's form leaves them out.
    const bare = parseApcOvernight(page('delivered').replace('>20 kg<', '>0 kg<').replace(/>NC16 \(([^)]*)\)</, '>$1<'), DELIVERED);
    expect(bare.weight_kg).toBeUndefined();
    expect(bare.service_name).toBeUndefined();
  });

  it('binds the page to the consignment that ends the requested waybill and rejects pages it cannot read', () => {
    expect(() => parseApcOvernight(page('journey'), RETURNED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['', '<html><body>Maintenance</body></html>',
      page('journey').replace('>0001234<', '>0001234 0005678<'),
      page('journey').replace('<div class="con-summary">', '<div class="con-summary"></div><div class="con-summary">'),
      page('journey').replace('(06-Mar-2026 00:12)', '(06-Mar-2026 25:12)'),
      page('journey').replace('(06-Mar-2026 00:12)', '(31-Feb-2026 00:12)'),
      page('journey').replace('(06-Mar-2026 00:12)', '(2026-03-06 00:12)'),
      page('journey').replace('At Hub (06-Mar-2026 00:12)', 'At Hub'),
      page('journey').replace('<div class="detailed-delivery-container">', '<div class="delivery-container">'),
      page('journey').replace(/<div id="item-\d" class="item-details">/g, '<div class="item">')]) {
      expect(() => parseApcOvernight(html, JOURNEY), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('journey').replace('<li>At Hub (06-Mar-2026 00:12)</li>',
      Array.from({ length: 2001 }, (_, minute) => `<li>At Hub (${String(1 + Math.floor(minute / 1440)).padStart(2, '0')}-Mar-2026 `
        + `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')})</li>`).join(''));
    expect(() => parseApcOvernight(many, JOURNEY)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the search page’s notice for the echoed waybill as a missing consignment', () => {
    expect(() => parseApcOvernight(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseApcOvernight(page('not-found'), JOURNEY)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseApcOvernight(page('invalid').replace('0001234', ABSENT), ABSENT)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    for (const html of [page('not-found').replace('Your consignment could not be found', 'Something went wrong, please try again'),
      page('not-found').replace('<p class="login-error">', '<p class="login-error">Please enter a valid postcode</p><p class="login-error">')]) {
      expect(() => parseApcOvernight(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseApcOvernight(page('not-found').replace(/<div class="login-error-container">[\s\S]*?<\/div>/, ''), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>']) {
      expect(() => parseApcOvernight(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes twenty-two-digit waybills that open with a calendar date, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0001234', '2026033199000010001234X', '202603059900001000123', '20260305990000100012345', '2026023099000010001234',
      '1926030599000010001234', '9200190000000000000001', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async (url) => absent(url));
    for (const number of [ABSENT, '2018041900000000000001', '2099123100000000000001']) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('recognizes a known consignment and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('journey'))).mockImplementationOnce(async (url) => absent(url));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(JOURNEY)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-08T09:30:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[302, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/?error=The+page+you+requested+does+not+exist' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps empty pages and oversized replies apart from missing consignments', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(ABSENT), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: JOURNEY })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('journey')));
    await expect(carrier(flaky).track({ number: JOURNEY })).resolves.toMatchObject({ status: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('journey')));
    await expect(carrier(immediate).track({ number: JOURNEY }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: JOURNEY }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: JOURNEY }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a waybill filed under APC Overnight to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'apc-overnight' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'apc-overnight', source: 'apc-overnight', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${APC_OVERNIGHT_ENDPOINT}?`))).toBe(true);
  });

  it('is asked first about the dated twenty-two-digit waybills detection suggests it for', () => {
    expect(detectCarrierMatch(JOURNEY)).toMatchObject({ confidence: 'low', preferred: ['apc-overnight'] });
    expect(recognitionAskedCarriers(JOURNEY)[0]).toBe('apc-overnight');
    expect(recognitionAskedCarriers('9200190000000000000001')).not.toContain('apc-overnight');
  });
});

describe('APC Overnight status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, and the notice it leaves without one', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(apcOvernightScanStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(stage);
    }
    expect(apcOvernightScanStage('  At   HUB ')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'At', 'Delivered to', 'Delivery Rearranged']) {
      expect(apcOvernightScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'apc-overnight', description: 'Carded' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'apc-overnight', description: 'Delivery Rearranged By Customer' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});

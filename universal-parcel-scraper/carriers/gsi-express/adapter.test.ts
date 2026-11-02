import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GSI_EXPRESS_TRACKING, GsiExpressTracker } from './adapter.js';
import { normalizeGsiExpressNumber, parseGsiExpress } from './parser.js';
import { gsiExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const CLEARED = '0000001';
const DEPARTED = '0000002';
const UNKNOWN = '0000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The cell after a field's label, as the page writes the waybill's.
const withWaybill = (html: string, shown: string) => html.replace(/(운송장번호&nbsp;<\/b>[\s\S]*?<td colspan=4 align=left>&nbsp; )\d+ /, `$1${shown} `);
// The page without its customs clearance row.
const withoutClearance = (html: string) => html.replace(/<tr>\s*<td style='padding:2 0 2 0;'>\s*<table[^>]*>\s*<tr>\s*<td[^>]*><b[^>]*>&nbsp;통관완료일[\s\S]*?<\/tr>(\s*<tr>\s*<td style='padding:2 0 2 0;'\s+colspan=5>)/, '$1');

describe('GSI Express HTTP adapter', () => {
  it('opens the tracker’s page for the whole receipt number, once, through the supplied transport', async () => {
    const fetcher = answering(() => page(fixture('cleared')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GsiExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GSI_EXPRESS_TRACKING}?textfield=${CLEARED}&track_type=invoice_no`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gsi-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a cleared parcel newest first as wall clocks, and hands it to Korea Post under its waybill', () => {
    const result = parseGsiExpress(fixture('cleared'), CLEARED);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '통관완료', last_update: null, last_update_local: '2026-03-05', expected_delivery: null,
      delivery_carrier: 'korea-post', delivery_tracking_number: '6000000000001',
      events: [
        { local_time: '2026-03-05', description: '통관완료', stage: 'in_transit', stage_source: 'carrier_map' },
        // The Korean clock, not the US Eastern one the page derives from it.
        { local_time: '2026-03-03T04:20:15', description: '출고', stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
    // The master air waybill, the order number and the recipient are not kept.
    expect(JSON.stringify(result)).not.toMatch(/000-00000001|20260301|홍|가상시|예시로/);
    expect(deliveryHandoff('gsi-express', CLEARED, result)).toEqual({ carrier: 'korea-post', number: '6000000000001', basis: 'partner' });
  });

  it('reads a parcel that left the warehouse, past the server’s warnings', async () => {
    const result = await carrier(answering(() => page(fixture('departed')))).track({ number: DEPARTED });
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: '출고', last_update: null,
      last_update_local: '2026-03-10T06:45:02', delivery_carrier: 'korea-post', delivery_tracking_number: '6000000000002',
    });
    expect(result.events).toEqual([{ local_time: '2026-03-10T06:45:02', description: '출고', stage: 'in_transit', stage_source: 'carrier_map' }]);
    expect(result).not.toHaveProperty('history_truncated');
  });

  it('names Korea Post only for its domestic parcel numbers on a page with Korean customs, and keeps another waybill alone', () => {
    const twelve = parseGsiExpress(withWaybill(fixture('cleared'), '600000000001'), CLEARED);
    expect(twelve).toMatchObject({ delivery_tracking_number: '600000000001' });
    expect(twelve).not.toHaveProperty('delivery_carrier');
    const letters = parseGsiExpress(withWaybill(fixture('cleared'), '1000000000001'), CLEARED);
    expect(letters).toMatchObject({ delivery_tracking_number: '1000000000001' });
    expect(letters).not.toHaveProperty('delivery_carrier');
    for (const shown of ['', '6000000000001 6000000000003', '6000000000001,6000000000003']) {
      const result = parseGsiExpress(withWaybill(fixture('cleared'), shown), CLEARED);
      expect(result, shown).not.toHaveProperty('delivery_carrier');
      expect(result, shown).not.toHaveProperty('delivery_tracking_number');
    }
    const elsewhere = parseGsiExpress(withoutClearance(fixture('cleared')), CLEARED);
    expect(elsewhere).toMatchObject({ last_status_text: '출고', delivery_tracking_number: '6000000000001' });
    expect(elsewhere).not.toHaveProperty('delivery_carrier');
  });

  it('marks the history partial when the page lists flights or domestic scans it does not read', () => {
    const flights = fixture('cleared').replace("Flight Status</td></tr>",
      "Flight Status</td></tr><tr><td>2026-03-03 10:00</td><td>XX000</td><td>AAA</td><td>BBB</td><td>Departed</td></tr>");
    const scans = fixture('cleared').replace('처리지점</td></tr></table>',
      '처리지점</td></tr><tr><td>2026-03-06 09:00</td><td>배달완료</td><td>가상우체국</td></tr></table>');
    const framed = fixture('cleared').replace(/(<td colspan=5 align=left>\s*)(<\/td>\s*<\/tr>\s*<\/table>)/, '$1<table><tr><td>배달준비</td></tr></table>$2');
    for (const html of [flights, scans, framed]) {
      expect(html).not.toBe(fixture('cleared'));
      const result = parseGsiExpress(html, CLEARED);
      expect(result).toMatchObject({ history_truncated: true, last_status_text: '통관완료', delivery_carrier: 'korea-post' });
      expect(result.events).toHaveLength(2);
    }
  });

  it('reads the tracker’s notice as not found', async () => {
    expect(() => parseGsiExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => page(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a page for another receipt', () => {
    expect(() => parseGsiExpress(fixture('cleared'), DEPARTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGsiExpress(fixture('cleared').replace(`&nbsp; ${CLEARED}</td>`, '&nbsp; 10000001</td>'), CLEARED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a page without the receipt or with invalid milestones, reads one without milestones as no history and a bot check as a challenge', () => {
    for (const changed of [
      fixture('cleared').replace(`&nbsp; ${CLEARED}</td>`, '&nbsp; </td>'),
      fixture('cleared').replace('GSI 접수번호', 'GSI 번호'),
      fixture('cleared').replace('2026-03-03 04:20:15(한국시간)', '2026-02-30 04:20:15(한국시간)'),
      fixture('cleared').replace('2026-03-03 04:20:15(한국시간)', '2026-03-03 24:00:00(한국시간)'),
      fixture('cleared').replace('2026-03-03 04:20:15(한국시간)', '03/03/2026 04:20:15(한국시간)'),
      fixture('cleared').replace('(한국시간) 2026-03-02', '(현지시간) 2026-03-02'),
      fixture('cleared').replace('2026년03월05일', '2026년02월30일'),
      fixture('cleared').replace('2026년03월05일 (한국시간)', '2026-03-05'),
      fixture('cleared').replace(/<td bgcolor='#AFCBE1'[^>]*><b[^>]*>&nbsp;출고시간&nbsp;<\/b>/, '<td><b>출고</b>')
        .replace(/<td bgcolor='#AFCBE1'[^>]*><b[^>]*>&nbsp;통관완료일&nbsp;<\/b>/, '<td><b>통관</b>'),
      fixture('cleared').replace('<table width=100% border=0>', "<table width=100% border=0><tr><td><table><tr><td bgcolor='#AFCBE1'><b>GSI 접수번호</b></td></tr></table></td><td>0000001</td></tr>"),
      '<html><body><h1>Internal Server Error</h1></body></html>',
      '',
    ]) expect(() => parseGsiExpress(changed, CLEARED), changed.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture('departed').replace('2026-03-10 06:45:02(한국시간) 2026-03-09 17:45:02(미국동부시간)', '');
    expect(() => parseGsiExpress(empty, DEPARTED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseGsiExpress(CHALLENGE, CLEARED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: CLEARED });
    await expect(lookup(() => page(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    // The tracker reads a missing parcel from a 200 page: a 404 or a redirect is a moved route.
    await expect(lookup(() => page('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('', { status: 301, headers: { Location: '/index.php' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('<html><body>Internal Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => page('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when GSI Express cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('cleared')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new GsiExpressTracker({ fetcher: flaky, recorder }).fetch(CLEARED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: CLEARED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: CLEARED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects what is not a receipt number, including the Korea Post waybill, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '000000', '00000001', 'A000001', '6000000000001', '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: CLEARED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGsiExpressNumber('000-0001')).toBe(CLEARED);
  });

  it('answers a receipt filed under GSI Express or opened from its tracker’s address, and asks Korea Post about the waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(GSI_EXPRESS_TRACKING)
      ? page(fixture('cleared')) : page('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: CLEARED, carrier: 'gsi-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'gsi-express', source: 'gsi-express', result: { current_stage: 'in_transit' },
      handoff: { carrier: 'korea-post', number: '6000000000001', confirmed: false } });
    // Seven digits name no carrier, so no rule claims them and recognition does not ask.
    expect(recognitionCandidates(CLEARED).map((candidate) => candidate.carrier)).not.toContain('gsi-express');
    expect(parseTrackingInput(`https://www.gsiexpress.com/track_pop.php?textfield=${CLEARED}&track_type=invoice_no`))
      .toMatchObject({ trackingNumber: CLEARED, carrier: 'gsi-express' });
  });
});

describe('GSI Express status vocabulary', () => {
  it('records every milestone the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(gsiExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'gsi-express', description: '통관완료' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'gsi-express', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});

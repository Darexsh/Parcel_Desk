import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { classifyWording } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EXMATE_TRACKING, ExmateTracker } from './adapter.js';
import { normalizeExmateNumber, parseExmate } from './parser.js';
import { exmateStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'EXK00000001J';
const IN_TRANSIT = 'EXK00000002J';
const UNKNOWN = 'EXK00000003J';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// One scan row as the page writes it.
const row = (clock: string, country: string, code: string, line: string) => `<li class="over">
              <div class="g1">
                ${clock}
                <span class="g-cricle"><span></span></span>
              </div>
              <div class="g4">
                ${country}
              </div>
              <div class="g2">
                ${code}
              </div>
              <div class="g3">
                ${line}
              </div>
            </li>`;
const appended = (html: string, ...rows: string[]) => html.replace(/(\s*<\/ul>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\?)/, `${rows.join('')}$1`);
const withoutDelivery = () => fixture('delivered').replace(/<li class="over">(?:(?!<\/li>)[\s\S])*배송완료[\s\S]*?<\/li>/, '');
const withService = (html: string, shown: string, href: string) => html.replace(
  /Local Delivery Service : \S+ <a href='[^']*'/, `Local Delivery Service : ${shown} <a href='${href}'`);

describe('Exmate HTTP adapter', () => {
  it('opens the tracker’s page for the whole number in English, once, through the supplied transport', async () => {
    const fetcher = answering(() => page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ExmateTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' exk 0000-0002 j ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${EXMATE_TRACKING}?exmno=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0', Cookie: 'UseLang=EN' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'exmate', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first in Korean and Japanese time, with the local carrier’s scans', () => {
    const result = parseExmate(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'サンプル 配達完了', last_update: '2026-03-07T18:25:00+09:00', expected_delivery: null,
      delivered_at: '2026-03-07T18:25:00+09:00',
    });
    expect(result.events!.map((event) => [event.time, event.location, event.provider_code, event.description, event.stage ?? null])).toEqual([
      ['2026-03-07T18:25:00+09:00', 'Japan', '배송완료', 'サンプル 配達完了', 'delivered'],
      // The local carrier's scan without a line of its own keeps Exmate's status.
      ['2026-03-07T11:00:00+09:00', 'Japan', '부재중', '부재중', 'failed_attempt'],
      ['2026-03-05T17:50:00+09:00', 'Japan', '배송사접수', 'Received by Carrier', 'in_transit'],
      ['2026-03-05T13:15:00+09:00', 'Japan', '통관완료', 'Customs Cleared', 'in_transit'],
      ['2026-03-04T10:30:00+09:00', 'Japan', '현지도착', 'Arrived at Destination Country', 'in_transit'],
      ['2026-03-04T08:10:00+09:00', 'Korea', '출발', 'Departed', 'in_transit'],
      ['2026-03-03T16:40:00+09:00', 'Korea', '출고완료', 'Shipped Out', 'in_transit'],
      ['2026-03-03T11:20:00+09:00', 'Korea', '입고완료', 'DPC In-housing', 'accepted'],
      ['2026-03-02T09:05:00+09:00', 'Korea', '등록', 'Registered', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    // The port of loading and the progress rail are not kept, nor is a hand-off for a delivered parcel.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|acceptance of goods|000000000001/);
    expect(deliveryHandoff('exmate', DELIVERED, result)).toBeNull();
  });

  it('reads a parcel on its way, once per repeated scan, and hands it to Japan Post under the number the page links', async () => {
    const result = await carrier(answering(() => page(fixture('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived at Destination Country',
      last_update: '2026-05-13T09:55:00+09:00', delivery_carrier: 'japan-post', delivery_tracking_number: '00000000002',
    });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.provider_code)).toEqual(['현지도착', '출발', '입고완료', '등록']);
    expect(deliveryHandoff('exmate', IN_TRANSIT, result)).toEqual({ carrier: 'japan-post', number: '00000000002', basis: 'partner' });
  });

  it('hands a parcel still on its way to Sagawa, and only for the number the page links on a tracker it knows', () => {
    const sagawa = parseExmate(withoutDelivery(), DELIVERED);
    expect(sagawa).toMatchObject({ current_stage: 'failed_attempt', status: 'exception', delivery_carrier: 'sagawa', delivery_tracking_number: '000000000001' });
    expect(deliveryHandoff('exmate', DELIVERED, sagawa)).toEqual({ carrier: 'sagawa', number: '000000000001', basis: 'partner' });
    for (const [shown, href] of [
      ['000000000001', 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=000000000002'],
      ['000000000001', 'http://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=000000000001'],
      ['000000000001', 'https://tracker.example/p?no=000000000001'],
      ['00000000001', 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=00000000001'],
      ['', 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo='],
      ['000000000001', 'not a link'],
    ] as const) {
      const result = parseExmate(withService(withoutDelivery(), shown, href), DELIVERED);
      expect(result, `${shown} ${href}`).not.toHaveProperty('delivery_carrier');
      expect(result.events).toHaveLength(8);
    }
    // Before customs clearance the line names no carrier yet.
    const pending = withoutDelivery().replace(/Local Delivery Service : [\s\S]*?<\/a>/, 'Local Delivery Service : ');
    expect(parseExmate(pending, DELIVERED)).not.toHaveProperty('delivery_carrier');
  });

  it('leaves out the scans a later parcel brings to the local carrier’s reissued number after the delivery', () => {
    const result = parseExmate(appended(fixture('delivered'), row('2027-08-20 10:15', 'Japan', '부재중', ''),
      row('2027-08-20 19:40', 'Japan', '배송완료', 'サンプル 配達完了')), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-03-07T18:25:00+09:00', delivered_at: '2026-03-07T18:25:00+09:00' });
    expect(result.events).toHaveLength(9);
  });

  it('keeps the wall clock of a scan in a country it cannot place, and takes phone numbers out of a local line', () => {
    const result = parseExmate(appended(fixture('in-transit'), row('2026-05-14 06:00', 'Sampleland', '', 'Sample hub 000-0000-0000')), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-05-14T06:00:00', last_status_text: 'Sample hub', current_stage: 'in_transit' });
    expect(result.events![0]).toEqual({ local_time: '2026-05-14T06:00:00', location: 'Sampleland', description: 'Sample hub' });
    expect(result.events![1]).toMatchObject({ time: '2026-05-13T09:55:00+09:00' });
  });

  it('leaves a status the map lacks to the English line, then to the shared rules', () => {
    const relabelled = parseExmate(fixture('in-transit').replace('현지도착', '가상상태'), IN_TRANSIT);
    expect(relabelled.events![0]).toMatchObject({ provider_code: '가상상태', stage: 'in_transit', stage_source: 'carrier_map' });
    const unread = parseExmate(fixture('in-transit').replace('현지도착', '가상상태').replace('Arrived at Destination Country', 'Xyzzy'), IN_TRANSIT);
    expect(unread).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Xyzzy' });
    expect(unread.events![0]).not.toHaveProperty('stage');
    expect(exmateStage('', 'Paket zugestellt')).toMatchObject({ stage: 'delivered', source: expect.stringMatching(/^wording:/) });
  });

  it('reads the tracker’s bare notice as not found', async () => {
    expect(() => parseExmate(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseExmate(' No Data!!\n', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => page(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a page for another parcel, or one without the number', () => {
    expect(() => parseExmate(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseExmate(fixture('delivered').replace(`value='${DELIVERED}'`, `value='${IN_TRANSIT}'`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseExmate(fixture('delivered').replace(/(<span>\s*)EXK00000001J/, `$1${IN_TRANSIT}`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseExmate(fixture('delivered').replace(`value='${DELIVERED}'`, "value=''"), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseExmate(fixture('delivered').replace("id='exmno'", "id='other'"), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses a page without a history or with invalid scans, reads an empty history as none and a bot check as a challenge', () => {
    for (const changed of [
      fixture('delivered').replace('class="grap"', 'class="other"'),
      fixture('delivered').replace('2026-03-03 11:20', '03/03/2026 11:20'),
      fixture('delivered').replace('2026-03-03 11:20', '2026-02-30 11:20'),
      fixture('delivered').replace('2026-03-03 11:20', '2026-03-03 24:00'),
      fixture('delivered').replace('<div class="g4">', '<div class="g5">'),
      fixture('delivered').replace(/(<div class="g2">\s*)등록/, '$1').replace(/(<div class="g3">\s*)Registered/, '$1'),
      '<html><body><h1>Internal Server Error</h1></body></html>',
      '',
    ]) expect(() => parseExmate(changed, DELIVERED), changed.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture('delivered').replace(/(<div class="grap">\s*<ul>)[\s\S]*?(<\/ul>)/, '$1$2');
    expect(() => parseExmate(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseExmate(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => page(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    // The tracker reads a missing parcel from a 200 page: a 404 or a redirect is a moved route.
    await expect(lookup(() => page('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page(fixture('delivered'), { status: 302, headers: { Location: `/pod/langchange?exmno=${DELIVERED}&lang=KR` } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('<html><body>Internal Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => page('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when Exmate cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new ExmateTracker({ fetcher: flaky, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
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
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects what is not an Exmate number this page reads, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'EXK0000001J', 'EXK000000001J', 'EXJ00000001J', 'EXK00000001K', '000000000001', `EXK${'0'.repeat(70)}J`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeExmateNumber('exk 0000 0001 j')).toBe(DELIVERED);
  });

  it('answers a number filed under Exmate, detected as one, or opened from its tracker’s address', async () => {
    const fetcher = answering(() => page(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'exmate' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'exmate', source: 'exmate', result: { current_stage: 'in_transit' } });
    await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'exmate', source: 'exmate' });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(EXMATE_TRACKING))).toBe(true);
    // Detection names Exmate at high confidence, so preflight asks no recognition.
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ carrier: 'exmate', confidence: 'high', candidates: ['exmate'] });
    expect(recognitionCandidates(IN_TRANSIT)).toEqual([]);
    expect(parseTrackingInput(`https://pod.exmate.net/pod/?exmno=${IN_TRANSIT}`)).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'exmate' });
  });
});

describe('Exmate status vocabulary', () => {
  it('records every status and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string; language: string }[]) {
      const code = entry.language === 'ko' ? entry.wording : null;
      const wording = entry.language === 'ko' ? '' : entry.wording;
      expect(statusMap.stage(code, wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(exmateStage(code ?? '', wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'exmate', providerCode: '부재중', description: '부재중' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'exmate', providerCode: '배송완료', description: 'サンプル 配達完了' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'exmate', providerCode: '가상상태', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
    // Customs that cleared the parcel puts it back in transit, as the shared rules read it.
    expect(classifyWording('Customs Cleared', 'in_transit')).toMatchObject({ stage: 'in_transit' });
  });
});

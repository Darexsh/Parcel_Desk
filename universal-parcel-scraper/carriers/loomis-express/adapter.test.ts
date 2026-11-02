import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LOOMIS_RESULTS, LoomisExpressTracker, loomisResultsUrl } from './adapter.js';
import { parseLoomis } from './parser.js';
import { loomisEstimate, loomisScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'NET10000001';
const TRANSIT = 'LSHP10000002';
const ABSENT = 'LSHP99999999';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const ROW = '                        <div class="row ">\n                                <div class="col-2 col-md-1">';
const GRID_END = '                </div>\n            </div>\n            <!--col-md-12-->';
/** The page with each history row, the estimate's first, rewritten. */
function withRows(html: string, rewrite: (row: string, index: number) => string): string {
  const start = html.indexOf(ROW);
  const end = html.indexOf(GRID_END);
  const rows = html.slice(start, end).split(ROW).slice(1).map(row => ROW + row);
  return html.slice(0, start) + rows.map(rewrite).join('') + html.slice(end);
}
const rows = (result: ReturnType<typeof parseLoomis>) => result.events!.map(event => [event.local_time, event.description, event.location, event.stage]);

describe('Loomis Express tracking adapter', () => {
  it('asks the results page once for the whole waybill through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LoomisExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' net 1000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://loomisexpress.com/loomship/Track/TrackResults?t=WAYBILL&s=${DELIVERED}`);
    expect(String(url)).toBe(loomisResultsUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Accept-Language': 'en-CA,en;q=0.9' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'loomis-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered waybill newest first, as wall clocks, with the shipment record as a day', () => {
    const result = parseLoomis(page('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your Package was Delivered with no Signa Left at Receiving Dock',
      last_update: null, last_update_local: '2026-02-04T14:21:09', expected_delivery: null,
      events: [
        { local_time: '2026-02-04T14:21:09', description: 'Your Package was Delivered with no Signa Left at Receiving Dock',
          location: 'NORTHTOWN', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-02-04T08:47:52', description: 'Out for Delivery-Almost There!', location: 'NORTHTOWN',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-02-04T03:15:00', description: 'Package Has Arrived at Our Facility', location: 'NORTHTOWN',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-03T23:30:00', description: 'Departing sort facility', location: 'MIDVALE', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-03T22:05:44', description: 'Sorting It Out-Stay Tuned!', location: 'MIDVALE', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-03T11:32:17', description: "Couldn't Pick It Up-Trying Again Soon", location: 'MIDVALE',
          stage: 'registered', stage_source: 'carrier_map' },
        { local_time: '2026-02-02', description: 'Shipment Record Received', location: 'MIDVALE', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // References and the proof-of-delivery form are never read.
    expect(JSON.stringify(result)).not.toMatch(/SYNTHREF|POD/);
  });

  it('keeps the estimated day apart from the scans while the parcel is on its way, and drops a repeated scan', () => {
    const result = parseLoomis(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sorting It Out-Stay Tuned!',
      last_update_local: '2026-03-10T21:14:05', expected_delivery: '2026-03-12' });
    expect(rows(result)).toEqual([
      ['2026-03-10T21:14:05', 'Sorting It Out-Stay Tuned!', 'EASTPORT', 'in_transit'],
      ['2026-03-10T21:11:42', 'Package Has Arrived at Our Facility', 'EASTPORT', 'in_transit'],
      ['2026-03-09T16:02:31', 'Departing sort facility', 'WESTFIELD', 'in_transit'],
      ['2026-03-09T13:40:18', 'Picked Up and On the Move!', 'WESTFIELD', 'accepted'],
      ['2026-03-09', 'Shipment Record Received', 'WESTFIELD', 'registered'],
    ]);
    // A scan on a later day than the estimate, or a delivery, clears it.
    const late = page('in-transit').replace('2026-03-10 21:14:05', '2026-03-13 09:00:00');
    expect(parseLoomis(late, TRANSIT).expected_delivery).toBeNull();
    const delivered = page('in-transit').replace('Sorting It Out-Stay Tuned!', 'Our Package was Delivered');
    expect(parseLoomis(delivered, TRANSIT)).toMatchObject({ current_stage: 'delivered', expected_delivery: null });
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const shared = parseLoomis(page('in-transit').replace('Sorting It Out-Stay Tuned!', 'Returned to Sender'), TRANSIT);
    expect(shared).toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseLoomis(page('in-transit').replace('Sorting It Out-Stay Tuned!', 'Weather&#39;s Slowing Us Down'), TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: "Weather's Slowing Us Down" });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-10T21:14:05', description: "Weather's Slowing Us Down", location: 'EASTPORT' });
  });

  it('reads only the not-available list naming the requested waybill alone as a missing waybill', () => {
    expect(() => parseLoomis(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Another waybill's notice, or one that lists more than the request, is no answer.
    expect(() => parseLoomis(page('not-found'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const crowded = page('not-found').replace(`${ABSENT}\n`, `${ABSENT}\n</div><div class="col-md-3">${TRANSIT}\n`);
    expect(() => parseLoomis(crowded, ABSENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A page that both lists the waybill and misses it is no answer either.
    const mixed = page('in-transit').replace('<!--1-->', page('not-found').match(/ {4}<div class="div_bg_blue_1">[\s\S]*?<!--1-->/)![0]
      .replace(ABSENT, TRANSIT));
    expect(() => parseLoomis(mixed, TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the page to the requested waybill and rejects pages it cannot read', () => {
    for (const number of [DELIVERED, 'LSHP10000003', 'NET10000002']) {
      expect(() => parseLoomis(page('in-transit'), number), number).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of [
      page('in-transit').replace(`PIECE # : ${TRANSIT}`, 'PIECE # : LSHP10000003'),
      page('in-transit').replace(`SHIPMENT # : ${TRANSIT}`, 'SHIPMENT # : LSHP10000003'),
      page('in-transit').replace(`<a name="${TRANSIT}">`, '<a name="LSHP10000003">'),
      page('in-transit').replace(`<a href="#${TRANSIT}" class="link">${TRANSIT}</a>`, '<a href="#LSHP10000003" class="link">LSHP10000003</a>'),
      page('in-transit').replace('Found below waybills:', 'Waybills:'),
      page('in-transit').replace('2026-03-10 21:14:05', '2026-03-10 24:14:05'),
      page('in-transit').replace('2026-03-10 21:14:05', '2026-02-30 21:14:05'),
      page('in-transit').replace('2026-03-10 21:14:05', '10/03/2026 21:14'),
      page('in-transit').replace('Sorting It Out-Stay Tuned!', ''),
      page('in-transit').replace('CITY', 'VILLE'),
      page('in-transit').replace('<h2 class="h2 block-title">Tracking Results</h2>', '<h2 class="h2 block-title">Tracking</h2>'),
      '<html><body>Server Error in \'/loomship\' Application.</body></html>']) {
      expect(() => parseLoomis(html, TRANSIT), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLoomis(withRows(page('in-transit'), (row, index) => (index === 1 ? row.repeat(501) : row)), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // A waybill listed with its estimate alone has no history yet.
    expect(() => parseLoomis(withRows(page('in-transit'), (row, index) => (index === 0 ? row : '')), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body></body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>']) {
      expect(() => parseLoomis(html, TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('ignores the blocks of other waybills the page lists beside the requested one', () => {
    const other = page('delivered').match(/ {4}<div class="div_bg_blue_1">\s*<a name=[\s\S]*?<a class="atop"/)![0].slice(0, -'<a class="atop"'.length);
    const html = page('in-transit')
      .replace(`<a href="#${TRANSIT}" class="link">${TRANSIT}</a>`, `<a href="#${TRANSIT}" class="link">${TRANSIT}</a></div><div class="col-md-3"><a href="#${DELIVERED}" class="link">${DELIVERED}</a>`)
      .replace('<!--1-->', `<!--1-->\n${other}`);
    expect(parseLoomis(html, TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-03-10T21:14:05' });
    expect(parseLoomis(html, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('takes Loomis Express waybills only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DNK000000001', 'NET1000000', 'NET100000001', 'LSHP1000000A', 'LSP10000001', 'D576000000000000000001', 'X'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads an unknown waybill as not found and recognizes a known one, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-10T21:14:05' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps redirects, missing pages, empty pages and HTTP errors apart from a missing waybill', async () => {
    const cases: [Response, string][] = [
      [new Response(null, { status: 302, headers: { Location: '/loomship/Track' } }), 'indeterminate'],
      [reply('Not Found', 404), 'transport'],
      [reply('   '), 'indeterminate'],
      [reply('Busy', 429), 'rate_limited'],
      [reply('Unavailable', 503), 'maintenance'],
      [reply('<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>'), 'challenge'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(carrier(fetcher).track({ number: TRANSIT }), kind).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('sends the read once more after a network failure, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('in-transit')));
    await expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a Loomis Express waybill to the adapter, which detection claims outright', async () => {
    for (const number of [DELIVERED, TRANSIT]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'loomis-express', confidence: 'high' });
      expect(recognitionAskedCarriers(number)).toEqual([]);
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'loomis-express', source: 'loomis-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${LOOMIS_RESULTS}?`))).toBe(true);
  });
});

describe('Loomis Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(loomisScanStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('en-US')), entry.wording).toBe(stage);
    }
    expect(loomisScanStage('  PICKED up and on  the move! ')).toBe('accepted');
    expect(loomisScanStage('Couldn’t Pick It Up-Trying Again Soon')).toBe('registered');
    for (const wording of ['Your Package was Delivered', 'Our Package was Delivered', 'Your Package was Delivered with no Signature Required']) {
      expect(loomisScanStage(wording), wording).toBe('delivered');
    }
    for (const wording of ['constructor', 'toString', 'Your Package was', 'Your Package was Delivereded', 'Package was Delivered']) {
      expect(loomisScanStage(wording), wording).toBeUndefined();
    }
    expect(loomisEstimate(' estimated delivery DATE')).toBe(true);
    expect(statusMap.stage('SRT', 'sorting it out-stay tuned!')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'loomis-express', description: 'Out for Delivery-Almost There!' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'loomis-express', description: 'Estimated Delivery Date' })).toMatchObject({ kind: 'intentional_gap' });
  });
});

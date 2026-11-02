import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MRL_TRACKING, MrlTracker, mrlTrackingUrl } from './adapter.js';
import { normalizeMrlNumber, parseMrl } from './parser.js';
import { mrlMappedStage, mrlStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'CAAA000001';
const IN_TRANSIT = 'CAAA123456';
const UNKNOWN = 'CZZZ000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the page.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parseMrl>) => result.events!.map((event) => [event.local_time, event.description,
  event.stage ?? null, event.location ?? null]);
const row = (number: string, event: string, date: string, time: string) => `<tr><td data-title='Connote'>${number}</td>`
  + `<td data-title='Event'>${event}</td><td data-title='QTY'>1</td><td data-title='Date'>${date}</td><td data-title='Time'>${time}</td>`
  + `<td data-title='Signed By'>-</td><td data-title='From'>-</td><td data-title='To'>-</td></tr>`;
/** The page with a row added to its first history table. */
const addRow = (html: string, added: string) => html.replace(/(<\/thead>\s*)/, `$1${added}`);
/** The page without its latest update. */
const withoutLatest = (html: string) => html.replace(/<div class="update-resul-section">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>(?=\s*<\/div>)/, '');
/** The page without its history. */
const withoutHistory = (html: string) => html.replace(/<div class="accordance">[\s\S]*<\/table>\s*<!-- <\/div> -->\s*<\/div>\s*<\/div>/, '');

describe('MRL Global HTTP adapter', () => {
  it('opens the tracking page for the whole number through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MrlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' caaa-123 456 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MRL_TRACKING}?connoteno=${IN_TRANSIT}`);
    expect(mrlTrackingUrl(DELIVERED)).toBe('https://www.mrlglobal.com/tracking/?connoteno=CAAA000001');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mrl-global', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history newest first by its clocks, without who signed or the sender’s reference', () => {
    const result = parseMrl(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Confirmation of Delivery', last_update: null, last_update_local: '2026-03-06T11:42:00', expected_delivery: null,
    });
    for (const field of ['summary_only', 'history_truncated', 'delivered_at', 'receiver_name', 'pickup_point', 'weight_kg']) {
      expect(result).not.toHaveProperty(field);
    }
    // The groups' order is the page's; the rows of one minute keep it.
    expect(events(result)).toEqual([
      ['2026-03-06T11:42:00', 'Confirmation of Delivery', 'delivered', null],
      ['2026-03-06T09:30:00', 'Ready for Collection Scan', 'ready_for_pickup', null],
      ['2026-03-06T09:05:00', 'Other Scan', 'in_transit', null],
      ['2026-03-06T08:20:00', 'Other Scan', 'in_transit', null],
      ['2026-03-05T13:15:00', 'Attempted Delivery', 'failed_attempt', null],
      ['2026-03-05T07:55:00', 'Other Scan', 'in_transit', null],
      ['2026-03-03T18:45:00', 'Scanned in Depot', 'in_transit', null],
      ['2026-03-03T12:10:00', 'Other Scan', 'in_transit', null],
      ['2026-03-03T02:30:00', 'Other Scan', 'in_transit', null],
      ['2026-03-02T17:20:00', 'Scanned in Depot', 'in_transit', null],
      ['2026-03-02T15:00:00', 'Other Scan', 'in_transit', null],
      ['2026-03-02T15:00:00', 'In Transit', 'in_transit', null],
      ['2026-03-02T14:10:00', 'Pickup Scan', 'accepted', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined && !('provider_code' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE SIGNER|SAMPLE-REF|Signed|status-step/);
  });

  it('reads the depot a depot scan names as its place, and a row repeated for another item once', () => {
    const result = parseMrl(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Scanned in Depot', last_update_local: '2026-10-14T06:12:00',
    });
    expect(events(result)).toEqual([
      ['2026-10-14T06:12:00', 'Scanned in Depot', 'in_transit', 'EXAMPLETON'],
      ['2026-10-13T18:40:00', 'Linehaul Scan', 'in_transit', null],
      ['2026-10-13T16:30:00', 'Scanned in Depot', 'in_transit', 'SAMPLETON'],
      ['2026-10-13T15:10:00', 'Other Scan', 'in_transit', null],
      ['2026-10-13T15:10:00', 'In Transit', 'in_transit', null],
      ['2026-10-13T14:05:00', 'Pickup Scan', 'accepted', null],
      ['2026-10-12T10:00:00', 'Manifest Scan', 'registered', null],
    ]);
  });

  it('takes the latest update for the current state, else the newest row, and keeps unknown labels without a stage', () => {
    // An onboard scan newer than the latest update does not replace it: the page says what is latest.
    const onboard = addRow(fixture('in-transit'), row(IN_TRANSIT, 'Onboard Delivery Scan', '14/10/2026', '07:30'));
    expect(parseMrl(onboard, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-10-14T06:12:00' });
    expect(parseMrl(withoutLatest(onboard), IN_TRANSIT)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      current_stage_source: 'carrier_map', last_status_text: 'Onboard Delivery Scan', last_update_local: '2026-10-14T07:30:00' });
    const unknown = addRow(fixture('in-transit'), row(IN_TRANSIT, 'Sample Scan', '15/10/2026', '08:00'));
    expect(parseMrl(unknown, IN_TRANSIT).events![0]).toEqual({ local_time: '2026-10-15T08:00:00', description: 'Sample Scan' });
    const labelled = withoutLatest(unknown);
    expect(parseMrl(labelled, IN_TRANSIT)).toMatchObject({ status: 'unknown', last_status_text: 'Sample Scan' });
    expect(parseMrl(labelled, IN_TRANSIT)).not.toHaveProperty('current_stage');
    const latest = fixture('in-transit').replace('<div class="data-state">Scanned in Depot (EXAMPLETON)</div>', '<div class="data-state">Sample Scan</div>');
    expect(parseMrl(latest, IN_TRANSIT)).toMatchObject({ status: 'unknown', last_status_text: 'Sample Scan', last_update_local: '2026-10-14T06:12:00' });
    // A latest update without rows is a summary; neither is no history.
    const summary = withoutHistory(fixture('in-transit'));
    expect(parseMrl(summary, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', summary_only: true, events: [] });
    expect(() => parseMrl(withoutLatest(summary), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the error line for an unknown number as not found, and a page only when it repeats the number asked', () => {
    expect(() => parseMrl(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Another error from the service behind the page is no answer about the number.
    const failed = fixture('not-found').replace('Error : Invalid Connote number', 'Error : Service unavailable');
    expect(() => parseMrl(failed, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMrl(fixture('not-found').replace(/<div>Error : Invalid Connote number<\/div>/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The empty form means the page was not given the number.
    const form = fixture('not-found').replace('<div> No details Found</div>', '<div>Please enter ConnoteNo for tracking details</div>')
      .replace('<div>Error : Invalid Connote number</div>', '');
    expect(() => parseMrl(form, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A page for another consignment, or a row of one, is no answer.
    expect(() => parseMrl(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'MRL Global answered for another consignment' }));
    const mixed = addRow(fixture('in-transit'), row('CAAA000001', 'Pickup Scan', '13/10/2026', '14:05'));
    expect(() => parseMrl(mixed, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page repeats the number as typed, with its first letter capitalized.
    const echoed = fixture('in-transit').replaceAll(IN_TRANSIT, 'Caaa123456');
    expect(parseMrl(echoed, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed page', () => {
    for (const change of [
      (html: string) => html.replace('<strong>Consignment Number:</strong> CAAA123456', '<strong>Consignment:</strong> CAAA123456'),
      (html: string) => html.replace('<strong>Consignment Number:</strong> CAAA123456', '<strong>Consignment Number:</strong>'),
      (html: string) => html.replace('<div class="consignment_box">', '<div class="consignment_box"></div><div class="consignment_box">'),
      (html: string) => html.replace("<td data-title='Date'>13/10/2026</td>", "<td data-title='Date'>2026-10-13</td>"),
      (html: string) => html.replace("<td data-title='Date'>13/10/2026</td>", "<td data-title='Date'>31/02/2026</td>"),
      (html: string) => html.replace("<td data-title='Time'>18:40</td>", "<td data-title='Time'>24:40</td>"),
      (html: string) => html.replace("<td data-title='Time'>18:40</td>", "<td data-title='Time'>6:40 PM</td>"),
      (html: string) => html.replace("<td data-title='Time'>18:40</td>", ''),
      (html: string) => html.replace("<td data-title='Event'>Linehaul Scan</td>", "<td data-title='Event'></td>"),
      (html: string) => html.replace('<div class="data-date">14/10/2026 - 06:12</div>', '<div class="data-date">14/10/2026</div>'),
      (html: string) => html.replace('<div class="data-state">Scanned in Depot (EXAMPLETON)</div>', '<div class="data-state"></div>'),
      (html: string) => addRow(html, row(IN_TRANSIT, 'Other Scan', '15/10/2026', '08:00').repeat(2_001)),
    ]) {
      expect(() => parseMrl(change(fixture('in-transit')), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['', '<html><body>MRL Global</body></html>', fixture('not-found').replace(/<div class="no-data">[\s\S]*?<\/aside>\s*<\/div>/, '')]) {
      expect(() => parseMrl(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply(null, { status: 301, headers: { Location: 'https://www.mrlglobal.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><title>Page not found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>MRL Global</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = answering(() => reply('<html><body>Error</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers MRL Global does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'CAAA00000', 'CAAA0000000', 'AAAA000000', 'CAA0000000', 'CAAAA00000', 'C1AA000000', 'ICAA000000',
      `${IN_TRANSIT}${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const raw of ['caaa123456', 'CAAA 123 456', ' CAAA-123456 ']) expect(normalizeMrlNumber(raw), raw).toBe(IN_TRANSIT);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('answers a number filed under MRL Global, leaves its layout unclaimed and reads its tracking links', async () => {
    const fetcher = page('delivered');
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'mrl-global' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'mrl-global', source: 'mrl-global', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === mrlTrackingUrl(DELIVERED))).toBe(true);
    // C-chez-vous' rule fits the layout too, so neither detection nor recognition offers MRL Global.
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('mrl-global');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id), number).not.toContain('mrl-global');
    }
    expect(carrier(fetcher).recognize).toBeUndefined();
    expect(parseTrackingInput(`https://www.mrlglobal.com/tracking/?connoteno=${IN_TRANSIT}`))
      .toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'mrl-global', source: 'link' });
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toEqual({ mode: 'automatic', adapter: 'mrl-global', steps: ['direct', 'retry', 'trawl'], localClocks: true, browser: true });
  });
});

describe('MRL Global status vocabulary', () => {
  it('maps every recorded label to the stage it records', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(mrlMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(mrlStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'mrl-global', providerCode: null, description: 'Ready for Collection Scan' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'mrl-global', providerCode: null, description: 'Sample Scan' })).toEqual({ kind: 'unknown' });
    // A label the map does not know falls to the shared rules, else stays without a stage.
    expect(mrlStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(mrlStage('Sample Scan')).toBeNull();
  });
});

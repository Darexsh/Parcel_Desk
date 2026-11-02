import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, QWINTRY_TRACKING, QwintryTracker } from './adapter.js';
import { normalizeQwintryNumber, parseQwintry } from './parser.js';
import { qwintryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'QR00000001';
const IN_TRANSIT = 'QR00000002';
const UNKNOWN = 'QR00000003';
const POSTAL = 'CD000000014RU';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const appended = (html: string, ...rows: string[]) => html.replace('</tbody></table>', `${rows.join('\n')}\n</tbody></table>`);
const row = (clock: string, code: string, message: string) => `<tr data-key="99"><td>${clock}</td><td>${code}</td><td>${message}</td></tr>`;
const withNotice = (html: string, notice: string) => html.replace(/<p class="alert alert-warning">[\s\S]*?<\/p>/, notice);

describe('Qwintry HTTP adapter', () => {
  it('opens the tracker’s page for the whole number, once, through the supplied transport', async () => {
    const fetcher = answering(() => page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new QwintryTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' qr 0000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${QWINTRY_TRACKING}?tracking=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'qwintry', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered Qwintry Air parcel newest first on wall clocks, and hands it to CDEK under the number the page links', async () => {
    const result = await carrier(answering(() => page(fixture('delivered')))).track({ number: DELIVERED });
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Вручен', last_update: null, last_update_local: '2026-03-14T15:25:31', expected_delivery: null,
      delivery_carrier: 'cdek', delivery_tracking_number: '0000000001',
    });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-03-14T15:25:31', 'delivered', 'Вручен', null, 'delivered'],
      ['2026-03-14T09:40:02', 'delivery', 'Выдан на доставку', null, 'out_for_delivery'],
      ['2026-03-14T07:12:50', 'info', 'Принят на склад доставки', null, null],
      ['2026-03-13T02:30:44', 'departure_scan', 'Отправлен в город-получатель', null, 'in_transit'],
      ['2026-03-12T19:01:15', 'info', 'Передано в региональное подразделение перевозчика', null, null],
      ['2026-03-12T18:44:09', 'arrival_scan', 'Принято на склад службы-перевозчика в Москве', null, 'in_transit'],
      // Rows of the same second keep the page's order, newest last.
      ['2026-03-11T06:10:30', 'notification_sent', 'Delivery notification sent to recipient', null, null],
      ['2026-03-11T06:10:30', 'info', 'Передан локальному перевозчику', null, 'in_transit'],
      ['2026-03-10T20:30:00', 'customs', 'The shipment has left customs', null, 'in_transit'],
      ['2026-03-10T10:02:41', 'customs', 'Customs clearance completed', null, 'in_transit'],
      ['2026-03-09T14:20:00', 'customs', 'Arrived at customs', null, 'customs'],
      ['2026-03-09T12:05:00', 'arrival_scan', 'Arrival scan: SVO airport', 'SVO airport', 'in_transit'],
      ['2026-03-08T20:15:00', 'departure_scan', 'Departure scan: JFK airport', 'JFK airport', 'in_transit'],
      ['2026-03-07T11:40:22', 'customs', 'Паспортные данные собраны', null, 'customs'],
      ['2026-03-06T09:12:00', 'arrival_scan', 'Arrival scan: JFK airport', 'JFK airport', 'in_transit'],
      // Qwintry's hub is named, not placed.
      ['2026-03-05T15:30:00', 'departure_scan', 'Departure scan: consolidation hub', null, 'in_transit'],
      ['2026-03-04T01:00:07', 'arrival_scan', 'Shipment arrived to consolidation hub', null, 'accepted'],
      ['2026-03-02T14:05:11', 'info_received', 'Electronic info received', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The destination town, the delivery type and the batch are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Примерск|courier|000_zz|12\.1/);
    expect(result).not.toHaveProperty('history_truncated');
    expect(deliveryHandoff('qwintry', DELIVERED, result)).toEqual({ carrier: 'cdek', number: '0000000001', basis: 'partner' });
  });

  it('reads an older parcel on its way, once per repeated scan, with the courier service’s estimate and places', () => {
    const result = parseQwintry(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-07-26T21:43:36',
      last_status_text: 'Departure scan: Примерск [ZZ1]', expected_delivery: '2026-07-30',
    });
    expect(result.events).toHaveLength(9);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2026-07-26T21:43:36', location: 'Примерск', description: 'Departure scan: Примерск [ZZ1]', provider_code: 'departure_scan', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-07-25T21:29:16', location: 'Примерск', description: 'Arrival scan: Примерск [ZZ1]', provider_code: 'arrival_scan', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.find((event) => event.provider_code === 'departure_scan' && event.location === 'Newark, Delaware, US')).toBeDefined();
    // DPD's Russian network is not in the catalog: the page names it, but nothing is handed off.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    // Once delivered, the estimate goes.
    const delivered = parseQwintry(appended(fixture('in-transit'), row('27.07.2026 14:05:00', 'delivered', 'Planned delivery date - 2026-07-30. Delivered: Примерск [ZZ1]')), IN_TRANSIT);
    expect(delivered).toMatchObject({ current_stage: 'delivered', expected_delivery: null, last_status_text: 'Delivered: Примерск [ZZ1]' });
  });

  it('reads a parcel handed to Russian Post, with the post’s operations and offices, and hands it to the post under its own number', async () => {
    const result = await carrier(answering(() => page(fixture('russian-post')))).track({ number: POSTAL.toLowerCase() });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Вручение адресату', delivery_carrier: 'russian-post', delivery_tracking_number: POSTAL });
    expect(result.events!.slice(0, 9).map((event) => [event.provider_code, event.description, event.location, event.stage ?? null])).toEqual([
      ['delivered', 'Вручение адресату', 'Примерск 1', 'delivered'],
      ['неудачная попытка вручения', 'Временное отсутствие адресата', 'Примерск 1', 'failed_attempt'],
      ['обработка', 'Прибыло в место вручения', 'Примерск 1', 'in_transit'],
      ['таможенное оформление', 'Выпущено таможней', 'Примерск ММПО', 'in_transit'],
      ['прием на таможню', 'прием на таможню', 'Примерск ММПО', 'customs'],
      ['импорт международной почты', 'импорт международной почты', 'Примерск ММПО', 'in_transit'],
      ['экспорт международной почты', 'экспорт международной почты', 'Russian Post Berlin Cp', 'in_transit'],
      ['прием', 'Партионный', 'Russian Post Berlin Cp', 'in_transit'],
      ['arrival_scan', 'Arrival scan: TXL airport, Berlin', 'TXL airport, Berlin', 'in_transit'],
    ]);
    expect(deliveryHandoff('qwintry', POSTAL, result)).toEqual({ carrier: 'russian-post', number: POSTAL, basis: 'partner' });
  });

  it('hands a parcel off only for a tracker it knows that carries the number the page shows', () => {
    const cdek = (shown: string, href: string) => `<p class="alert alert-warning">
            You can track your package on our local carrier website after customs clearance in the destination country, tracking number: ${shown}            <a href="${href}" target="_blank" class="btn btn-sm btn-default">CDEK</a>
        </p>`;
    for (const notice of [
      cdek('0000000001', 'https://www.cdek.ru/ru/tracking?order_id=0000000002'),
      cdek('0000000001', 'https://tracker.example/ru/tracking?order_id=0000000001'),
      cdek('0000000001', 'not a link'),
      cdek('', 'https://www.cdek.ru/ru/tracking?order_id='),
      '<p class="alert alert-warning">Parcel will be delivered by courier service - IML, local track-number will be assigned later.</p>',
      `<p class="alert alert-warning">Boxberry: <a href="http://boxberry.ru/tracking/?id=ZZ0000000001">ZZ0000000001</a> <a href="https://www.cdek.ru/ru/tracking?order_id=ZZ0000000001">CDEK</a></p>`,
    ]) {
      const result = parseQwintry(withNotice(fixture('delivered'), notice), DELIVERED);
      expect(result, notice).not.toHaveProperty('delivery_carrier');
      expect(result, notice).not.toHaveProperty('delivery_tracking_number');
    }
    // A Russian Post link for another number hands nothing off either.
    const other = fixture('russian-post').replace('tracking#CD000000014RU', 'tracking#CD000000028RU');
    expect(parseQwintry(other, POSTAL)).not.toHaveProperty('delivery_carrier');
  });

  it('takes phone numbers out of a line and leaves a code the map lacks to the shared rules', () => {
    const result = parseQwintry(appended(fixture('in-transit'),
      row('27.07.2026 08:00:00', 'info', 'Курьер позвонит заранее +7 (900) 000-00-00'),
      row('27.07.2026 09:00:00', 'sample_code', 'Out for delivery')), IN_TRANSIT);
    expect(result.events![0]).toEqual({ local_time: '2026-07-27T09:00:00', description: 'Out for delivery', provider_code: 'sample_code',
      stage: 'out_for_delivery', stage_source: expect.stringMatching(/^wording:/) });
    expect(result.events![1]).toEqual({ local_time: '2026-07-27T08:00:00', description: 'Курьер позвонит заранее', provider_code: 'info' });
    expect(JSON.stringify(result)).not.toContain('900');
  });

  it('marks a history the page splits into pages as truncated', () => {
    const paged = fixture('in-transit').replace('Showing <b>1-10</b> of <b>10</b> items.', 'Showing <b>1-10</b> of <b>25</b> items.');
    expect(parseQwintry(paged, IN_TRANSIT)).toMatchObject({ history_truncated: true });
  });

  it('reads the tracker’s 404 page for an unknown number as not found, and another 404 or a redirect as a moved route', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: UNKNOWN });
    await expect(lookup(() => page(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => page('<html><body><h1>Not Found (#404)</h1><h2>Page not found.</h2></body></html>', { status: 404 })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('', { status: 302, headers: { Location: '/login' } }))).rejects.toMatchObject({ kind: 'transport' });
    // The 404 page on HTTP 200 is no tracking page.
    expect(() => parseQwintry(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses a page for another parcel, or one without the number', () => {
    expect(() => parseQwintry(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A lookup in lower case can head the page with Qwintry's internal id instead.
    expect(() => parseQwintry(fixture('delivered').replace(/<h1>QR00000001/, '<h1>1234567'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseQwintry(fixture('delivered').replace(/<h1>QR00000001/, '<h1>'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQwintry(fixture('delivered').replace('class="user-area"', 'class="other"'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses a page without a history or with invalid scans, reads an empty history as none and a bot check as a challenge', () => {
    for (const changed of [
      fixture('delivered').replace('class="grid-view"', 'class="list-view"'),
      fixture('delivered').replace('<td>02.03.2026 14:05:11</td>', '<td>2026-03-02 14:05:11</td>'),
      fixture('delivered').replace('<td>02.03.2026 14:05:11</td>', '<td>30.02.2026 14:05:11</td>'),
      fixture('delivered').replace('<td>02.03.2026 14:05:11</td>', '<td>02.03.2026 24:00:00</td>'),
      fixture('delivered').replace('<td>info_received</td>', ''),
      fixture('delivered').replace('<td>info_received</td><td>Electronic info received</td>', '<td></td><td></td>'),
      '<html><body><h1>Internal Server Error</h1></body></html>',
      '',
    ]) expect(() => parseQwintry(changed, DELIVERED), changed.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture('delivered').replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody>\n<tr><td colspan="3"><div class="empty">No results found.</div></td></tr>\n</tbody>');
    expect(() => parseQwintry(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseQwintry(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and server errors apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => page(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => page('<html><body>Internal Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => page('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when Qwintry cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new QwintryTracker({ fetcher: flaky, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
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

  it('rejects what is not a number the tracker reads, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A Russian Post number must pass its check digit and be the post's own.
    for (const number of ['', 'QR0000001', 'QR000000001', 'QX00000001', '00000001', 'CD000000015RU', 'CD000000014DE', `QR${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeQwintryNumber('qr 0000 0001')).toBe(DELIVERED);
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Qwintry does not read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith(UNKNOWN)
      ? page(fixture('not-found'), { status: 404 }) : page(fixture('delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('QR-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier(answering(() => page(CHALLENGE))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers a number filed under Qwintry, detected as one, or opened from its tracker’s address', async () => {
    const fetcher = answering(() => page(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'qwintry' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'qwintry', source: 'qwintry', result: { current_stage: 'in_transit' } });
    await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'qwintry', source: 'qwintry' });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(QWINTRY_TRACKING))).toBe(true);
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ carrier: 'qwintry', confidence: 'high' });
    expect(parseTrackingInput(`https://logistics.qwintry.com/track?tracking=${IN_TRANSIT}`)).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'qwintry' });
  });
});

describe('Qwintry status vocabulary', () => {
  it('records every status and wording seen with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string }[]) {
      expect(qwintryStage(entry.code, entry.wording), `${entry.code} ${entry.wording}`)
        .toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
    }
    expect(statusMapAnswer({ carrier: 'qwintry', providerCode: 'delivery', description: 'Выдан на доставку' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'qwintry', providerCode: 'customs', description: 'Customs clearance completed' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'qwintry', providerCode: 'info', description: 'Создан' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'qwintry', providerCode: 'sample_code', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
    expect(statusMap.gaps.map((gap) => gap.code)).toEqual(['notification_sent', 'info', 'other']);
  });
});

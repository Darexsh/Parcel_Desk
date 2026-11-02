import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GRAND_SLAM_LOOKUP, GrandSlamTracker } from './adapter.js';
import { grandSlamWording, normalizeGrandSlamNumber, parseGrandSlam } from './parser.js';
import { grandSlamMappedStage, grandSlamStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '000000001';
const OTHER = '999999999';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const envelope = (html: string, error = '') => ({ Error: error, Data: '', Result: html });
const found = (name: string) => envelope(fixture(`${name}.html`));
const reply = (body: unknown, status = 200, type = 'application/json; charset=utf-8') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseGrandSlam>) =>
  result.events!.map((event) => [event.local_time, event.location ?? null, event.description, event.stage ?? null]);
const HISTORY = /(<tbody>)<tr><td>[\s\S]*?(<\/tbody>)/;
const ROW = (date: string, place: string, activity: string) => `<tr><td>${date}</td><td>${place}</td><td>${activity}</td></tr>`;
const withRows = (html: string, ...lines: string[]) => html.replace(HISTORY, (_, open: string, close: string) => `${open}${lines.join('')}${close}`);
const withStatus = (html: string, status: string) => html.replace(/(<a href="#" class="boked">)[^<]*(<\/a>)/, `$1${status}$2`);

describe('Grand Slam Express tracking adapter', () => {
  it('posts the whole AWB number once to the tracking page’s lookup through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(found('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GrandSlamTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${NUMBER.slice(0, 4)} ${NUMBER.slice(4)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.grandslamexpress.in/Web/AwbNoTracking');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `AwbNo=${NUMBER}`,
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'grand-slam-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first on wall clocks, keeps a midnight delivery as its day and the destination country', () => {
    const result = parseGrandSlam(found('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'Packet has been DELIVERED', last_update: null, last_update_local: '2026-10-08T14:20:00', expected_delivery: null,
      destination_country: 'IN' });
    expect(rows(result)).toEqual([
      ['2026-10-08T14:20:00', 'Sample City', 'Packet Out For Delivery', 'out_for_delivery'],
      ['2026-10-08T10:05:00', 'Sample City', 'Packet Received', 'in_transit'],
      ['2026-10-08T10:05:00', 'Sample Hub(China)', 'Packet Dispatched to SAMPLE BRANCH In Challan No: C00000001', 'in_transit'],
      ['2026-10-08T10:05:00', 'Sample Hub(China)', 'Packet Manifested to SAMPLE BRANCH In Manifest No: M00000001', 'in_transit'],
      // The delivery was entered without its time, so it sorts below the day's other scans and keeps only its day.
      ['2026-10-08', 'Sample City', 'Packet has been DELIVERED', 'delivered'],
      ['2026-10-06T13:14:00', 'Sample City', 'CUSTOM HOLD', 'customs'],
      ['2026-10-02T12:47:00', 'Sample Hub(China)', 'Shipment Received at HUB', 'accepted'],
    ]);
    expect(result.events!.slice(1, 4).every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    // A delivery dated by its day alone is no instant, and nothing else of the heading is kept.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE ORIGIN|PCS|Booking|Tracking No/);
  });

  it('drops the names and phone numbers a delivery or a delivery round could carry', () => {
    const named = withRows(fixture('delivered.html'),
      ROW('09-Oct-2026 16:45', 'Sample City', 'Packet has been DELIVERED to SAMPLE RECEIVER (SELF)'),
      ROW('09-Oct-2026 09:10', 'Sample City', 'Packet Out For Delivery with SAMPLE STAFF 98765 43210'),
      ROW('09-Oct-2026 08:00', 'Sample City', 'Consignee not reachable on +91 98765-43210, call again'));
    const result = parseGrandSlam(envelope(named), NUMBER);
    expect(result.events!.map((event) => event.description)).toEqual(
      ['Packet has been DELIVERED', 'Packet Out For Delivery', 'Consignee not reachable on , call again']);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECEIVER|SAMPLE STAFF|98765/);
    expect(result).toMatchObject({ last_update_local: '2026-10-09T16:45:00', last_status_text: 'Packet has been DELIVERED' });
    expect(grandSlamWording('UNDELIVERED - DOOR LOCKED')).toBe('UNDELIVERED - DOOR LOCKED');
  });

  it('follows the newest staged scan of a shipment on its way, and the heading when no scan has a stage', () => {
    const result = parseGrandSlam(found('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'CUSTOM HOLD', last_update: null, last_update_local: '2026-10-15T09:30:00' });
    expect(rows(result)).toEqual([
      ['2026-10-15T09:30:00', 'Sample City', 'CUSTOM HOLD', 'customs'],
      ['2026-10-12T18:40:00', 'Sample Hub(China)', 'Shipment Received at HUB', 'accepted'],
    ]);
    // A scan the reply repeats appears once.
    const html = fixture('in-transit.html');
    const repeated = withRows(html, ROW('15-Oct-2026 09:30', 'Sample City', 'CUSTOM HOLD'), ROW('15-Oct-2026 09:30', 'Sample City', 'CUSTOM HOLD'),
      ROW('12-Oct-2026 18:40', 'Sample Hub(China)', 'Shipment Received at HUB'));
    expect(parseGrandSlam(envelope(repeated), NUMBER).events).toEqual(result.events);
    // Wording neither the map nor the shared rules know stays without a stage, and the heading then decides.
    const unknown = withRows(html, ROW('16-Oct-2026 10:00', 'Sample City', 'SAMPLE REMARK'));
    expect(parseGrandSlam(envelope(unknown), NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'IN TRANSIT' });
    const silent = parseGrandSlam(envelope(withStatus(unknown, '')), NUMBER);
    expect(silent).toMatchObject({ status: 'unknown', last_status_text: 'SAMPLE REMARK', events: [{ description: 'SAMPLE REMARK' }] });
    expect(silent).not.toHaveProperty('current_stage');
    expect(silent.events![0]).not.toHaveProperty('stage');
  });

  it('reads a day alone or with seconds, and refuses any other clock', () => {
    const at = (date: string) => rows(parseGrandSlam(envelope(withRows(fixture('in-transit.html'), ROW(date, 'Sample City', 'Packet Received'))), NUMBER))[0]![0];
    expect(at('9-Oct-2026 15:40')).toBe('2026-10-09T15:40:00');
    expect(at('09-oct-2026 15:40:05')).toBe('2026-10-09T15:40:05');
    expect(at('09-Oct-2026')).toBe('2026-10-09');
    expect(at('09-Oct-2026 00:00')).toBe('2026-10-09');
    for (const date of ['31-Sep-2026 10:00', '09-Foo-2026 10:00', '09/10/2026 10:00', '09-Oct-26 10:00', '09-Oct-2026 24:00',
      '09-Oct-2026 10:60', '09-Oct-2026 10', '']) {
      expect(() => at(date), date).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('lets the heading’s delivery settle the shipment, and the heading stand alone without a history', () => {
    const ahead = parseGrandSlam(envelope(withStatus(fixture('in-transit.html'), 'DELIVERED')), NUMBER);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'DELIVERED',
      last_update_local: '2026-10-15T09:30:00' });
    // A heading on its way does not override a delivered scan.
    expect(parseGrandSlam(envelope(withStatus(fixture('delivered.html'), 'IN TRANSIT')), NUMBER)).toMatchObject({ current_stage: 'delivered' });
    for (const html of [withRows(fixture('delivered.html'), ''), fixture('delivered.html').replace(/<div class="packet-history">[\s\S]*<\/table>/, '')]) {
      const alone = parseGrandSlam(envelope(html), NUMBER);
      expect(alone).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'DELIVERED',
        last_update: null, summary_only: true, events: [] });
      expect(alone).not.toHaveProperty('last_update_local');
    }
    expect(() => parseGrandSlam(envelope(withStatus(withRows(fixture('delivered.html'), ''), '')), NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('binds the reply to the requested AWB number and refuses replies it cannot read', () => {
    expect(() => parseGrandSlam(found('delivered'), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const html = fixture('delivered.html');
    const block = /<div class="container my-5 track-border">[\s\S]*<\/div><\/div>\n<\/div>/.exec(html)![0];
    for (const changed of [
      // The heading or the details name another number, or a longer one.
      html.replace(`</span> ${NUMBER} &nbsp;`, `</span> ${OTHER} &nbsp;`),
      html.replace(`</span> ${NUMBER} &nbsp;`, `</span> ${NUMBER}1 &nbsp;`),
      html.replace(`id="track-data${NUMBER}"`, `id="track-data${OTHER}"`),
      // Several shipments for the number.
      html.replace(block, `${block}${block.replaceAll(NUMBER, OTHER)}`),
    ]) {
      expect(() => parseGrandSlam(envelope(changed), NUMBER), changed.length.toString()).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const changed of [
      '<p>Sample</p>',
      html.replace('AWB No. :', 'Docket :'),
      html.replace('<li><span class="bold-text">PCS', `<li>${'X'.repeat(1000)}</li><li><span class="bold-text">PCS`),
      html.replace(`id="track-data${NUMBER}"`, 'id="details"'),
      html.replace('<th  title=\'Activities\'>Activities</th>', '<th>Remarks</th>'),
      html.replace("title='Location'>Location</th>", "title='Date'>Date</th>"),
      html.replace('</table>\n                                </div>', '</table><table><thead><tr><th>Date</th><th>Activities</th></tr></thead></table></div>'),
      html.replace('<td>Sample City</td><td>Packet Received</td>', '<td>Sample City</td>'),
      html.replace('<td>Packet Received</td>', '<td> </td>'),
      withRows(html, ...Array.from({ length: 301 }, (_, minute) =>
        ROW(`08-Oct-2026 ${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`, 'Sample City', 'Packet Received'))),
    ]) {
      expect(() => parseGrandSlam(envelope(changed), NUMBER), changed.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], 'Sample', {}, { Error: null, Result: '' }, { Error: '', Result: 5 }, { Error: 7, Result: '' }]) {
      expect(() => parseGrandSlam(payload, NUMBER), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the lookup’s own message without a shipment as not found, and any other answer as inconclusive', () => {
    expect(() => parseGrandSlam(JSON.parse(fixture('not-found.json')), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGrandSlam({ Error: 'please enter valid AWB number', Result: null }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [
      // Session expiry, another message, or the message beside a shipment.
      envelope('', 'EXPIRED'),
      envelope('', 'Server busy, please try later'),
      envelope(fixture('delivered.html'), 'Please enter valid AWB number!'),
      // Neither a message nor a shipment.
      envelope(''),
      envelope('  \n '),
    ]) {
      expect(() => parseGrandSlam(payload, NUMBER), JSON.stringify(payload).slice(0, 60)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('keeps block pages, other pages and empty replies apart from missing parcels', async () => {
    for (const [body, kind] of [
      ['<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>', 'challenge'],
      ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>', 'challenge'],
      ['<html><body><div class="g-recaptcha" data-sitekey="SYNTHETIC"></div></body></html>', 'challenge'],
      ['<html><head><title>Runtime Error</title></head><body>Server Error in \'/\' Application.</body></html>', 'schema'],
      ['{"Error":', 'schema'],
      ['', 'indeterminate'],
      ['   ', 'indeterminate'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, 200, 'text/html; charset=utf-8'));
      await expect(carrier(fetcher).track({ number: NUMBER }), body.slice(0, 40)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1)));
    await expect(carrier(large).track({ number: NUMBER })).rejects.toThrow('unexpectedly large');
  });

  it('takes nine-digit AWB numbers and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000000', '0000000000', '00000000X', 'ABCDEFGHI', `${NUMBER},${OTHER}`, '5'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGrandSlamNumber('000-000-001')).toBe(NUMBER);
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/Web/Error' } })
        : reply(JSON.parse(fixture('not-found.json')), status));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(found('delivered')));
    await expect(carrier(flaky).track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(found('delivered')));
    await expect(carrier(immediate).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: NUMBER }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: NUMBER }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an AWB number filed under Grand Slam Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(found('in-transit')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: NUMBER, carrier: 'grand-slam-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'grand-slam-express', source: 'grand-slam-express', result: { current_stage: 'customs' },
      attempts: [{ source: 'grand-slam-express', kind: 'ok' }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(GRAND_SLAM_LOOKUP);
  });
});

describe('Grand Slam Express numbers', () => {
  it('leaves nine-digit runs unclaimed', () => {
    for (const number of [NUMBER, OTHER]) expect(detectCarrierMatch(number).carrier, number).not.toBe('grand-slam-express');
  });
});

describe('Grand Slam Express status vocabulary', () => {
  it('records every wording it saw with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      if (!('stage' in entry)) continue;
      expect(grandSlamStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(grandSlamMappedStage('  packet   RECEIVED ')).toBe('in_transit');
    for (const wording of ['constructor', 'Packet', 'Packet Receivedat HUB', 'Packet has been DELIVERED', 'Shipment Received at HUB']) {
      expect(grandSlamMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'custom hold')).toBeUndefined();
    expect(statusMap.stage(null, 'custom hold')).toBe('customs');
    // Other wording goes to the shared rules, and wording they do not know either stays without a stage.
    expect(grandSlamStage('CUSTOM HOLD')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(grandSlamStage('Packet Out For Delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(grandSlamStage('SAMPLE REMARK')).toBeNull();
    expect(statusMapAnswer({ carrier: 'grand-slam-express', description: 'Packet Received' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});

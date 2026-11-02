import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SOUTH_AFRICAN_POST_TRACKER, SouthAfricanPostTracker } from './adapter.js';
import { normalizeSouthAfricanPostNumber, parseSouthAfricanPost, southAfricanPostWording } from './parser.js';
import { southAfricanPostCommentStage, southAfricanPostStage, southAfricanPostTypeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014ZA';
const INBOUND = 'ZZ000000028GB';
const UNKNOWN = 'ZZ000000031ZA';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// One scan row of the history, as the page writes it.
const row = (index: number, type: string, date: string, time: string, branch: string, comment: string) =>
  `<tr><td>${index}</td><td>${type}</td><td>${date}</td><td>${time}</td><td>${branch}</td><td>${comment}</td></tr>`;
// The delivered page with its history rows replaced.
const withRows = (rows: string) => page('delivered').replace(/(<\/thead>)\s*<tr>[\s\S]*?(<\/table>\s*<\/main>)/, `$1${rows}$2`);
const BLOCKED = '<!DOCTYPE html><html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>';

describe('South African Post Office tracking adapter', () => {
  it('asks the tracker for the whole code once, as its form does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SouthAfricanPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 za ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SOUTH_AFRICAN_POST_TRACKER}?ParcelId=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'south-african-post-office', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first with each scan on South Africa’s clock and its branch, without the person who took it', () => {
    const result = parseSouthAfricanPost(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-12T12:05:00+02:00', delivered_at: '2026-05-12T12:05:00+02:00',
      expected_delivery: null, pickup_point: 'SAMPLE TOWN' });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-05-12T12:05:00+02:00', 'SAMPLE TOWN', 'Delivered', 'delivered'],
      ['2026-05-08T09:14:00+02:00', 'SAMPLE TOWN', 'First Notification to recipient', 'ready_for_pickup'],
      ['2026-05-08T09:12:00+02:00', 'SAMPLE TOWN', 'In Delivery Office', 'in_transit'],
      // The dispatch the page lists twice is kept once.
      ['2026-05-06T23:40:00+02:00', 'SAMPLE MAIL CENTRE', 'Dispatched', 'in_transit'],
      ['2026-05-06T07:02:00+02:00', 'SAMPLE MAIL CENTRE', 'Receive item at sorting centre', 'in_transit'],
      ['2026-05-05T00:30:00+02:00', 'SAMPLE CITY HUB', 'Dispatched', 'in_transit'],
      ['2026-05-04T10:21:00+02:00', 'SAMPLE CITY', 'Receive item from customer (Otb)', 'accepted'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('last_update_local');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON/);
  });

  it('names the office that sent the notice as the pickup point, and none for an item that moved on from it', () => {
    const waiting = parseSouthAfricanPost(page('delivered').replace(/<tr>\s*<td>1<\/td>[\s\S]*?<\/tr>/, ''), DELIVERED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'SAMPLE TOWN',
      last_status_text: 'First Notification to recipient' });
    const moved = parseSouthAfricanPost(withRows(row(1, 'Delivered/Collected', '2026/05/12', '12:05 PM', 'OTHER TOWN', 'Delivered to : A SAMPLE PERSON')
      + row(2, 'In Transit', '2026/05/10', '8:00 AM', 'SAMPLE MAIL CENTRE', 'Dispatched')
      + row(3, 'At Office', '2026/05/08', '9:14 AM', 'SAMPLE TOWN', 'First Notification to recipient')), DELIVERED);
    expect(moved).toMatchObject({ status: 'delivered' });
    expect(moved).not.toHaveProperty('pickup_point');
  });

  it('keeps the stage of the newest scan with one under a scanner\'s note', () => {
    const noted = parseSouthAfricanPost(withRows(row(1, 'In Transit', '2026/05/12', '9:30 AM', 'SAMPLE TOWN', 'COMMENT')
      + row(2, 'At Office', '2026/05/12', '9:14 AM', 'SAMPLE TOWN', 'First Notification to recipient')), DELIVERED);
    expect(noted).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      pickup_point: 'SAMPLE TOWN', last_status_text: 'COMMENT', last_update: '2026-05-12T09:30:00+02:00' });
  });

  it('reads mail from abroad held by customs, with scans at the same minute in the page’s order and no branch', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const result = await carrier(fetcher).track({ number: INBOUND });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Awaiting proof of purchase/value from addressee', last_update: '2026-06-03T14:20:00+02:00' });
    expect(result.events).toEqual([
      { time: '2026-06-03T14:20:00+02:00', description: 'Awaiting proof of purchase/value from addressee', stage: 'customs', stage_source: 'carrier_map' },
      { time: '2026-06-03T14:20:00+02:00', description: 'Item sent to Customs', stage: 'customs', stage_source: 'carrier_map' },
      { time: '2026-06-02T16:56:00+02:00', location: 'SAMPLE INTERNATIONAL MAIL CENTRE', description: 'Dispatched', stage: 'in_transit',
        stage_source: 'carrier_map' },
      { time: '2026-06-01T08:36:00+02:00', location: 'SAMPLE INTERNATIONAL MAIL CENTRE', description: 'Incoming International',
        stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result).not.toHaveProperty('pickup_point');
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('ParcelId')).toBe(INBOUND);
  });

  it('reads noon, midnight and a history listed out of order newest first', () => {
    const result = parseSouthAfricanPost(withRows(row(1, 'In Transit', '2026/05/06', '12:10 AM', 'SAMPLE HUB', 'Dispatched')
      + row(2, 'In Transit', '2026/05/06', '12:10 PM', 'SAMPLE HUB', 'Receive item at location')), DELIVERED);
    expect(result.events!.map(event => [event.time, event.description])).toEqual([
      ['2026-05-06T12:10:00+02:00', 'Receive item at location'],
      ['2026-05-06T00:10:00+02:00', 'Dispatched'],
    ]);
  });

  it('takes people and phone numbers out of the wording', () => {
    expect(southAfricanPostWording('Delivered/Collected', 'Delivered to : A SAMPLE PERSON')).toBe('Delivered');
    expect(southAfricanPostWording('Delivered/Collected', 'Collected: A SAMPLE PERSON')).toBe('Collected');
    expect(southAfricanPostWording('In Transit', 'Item delivered to:')).toBe('Item delivered');
    expect(southAfricanPostWording('Other', 'Addressee not home, call 000 000 0000')).toBe('Addressee not home, call');
    // A type stands in for an empty comment; a comment repeating it is kept as written.
    expect(southAfricanPostWording('In Transit', '')).toBe('In Transit');
    expect(southAfricanPostWording('In Transit', 'In Transit')).toBe('In Transit');
    expect(southAfricanPostWording('Held In customs', 'Detention notice: invoice needed')).toBe('Detention notice: invoice needed');
  });

  it('stages new comments through the shared rules, then the scan’s type, and keeps the rest without a stage', () => {
    const stage = (type: string, comment: string) => parseSouthAfricanPost(withRows(row(1, type, '2026/05/12', '9:00 AM', 'SAMPLE TOWN', comment)),
      DELIVERED);
    expect(stage('In Transit', 'Item returned to sender')).toMatchObject({ status: 'exception', current_stage: 'returned',
      current_stage_source: 'wording:language' });
    expect(stage('Held In customs', 'Sample note').events![0]).toMatchObject({ description: 'Sample note', stage: 'customs',
      stage_source: 'carrier_map' });
    expect(stage('At Office', '')).toMatchObject({ last_status_text: 'At Office', current_stage: 'in_transit' });
    // Collected at the counter without a notice first: a delivery without a pickup point.
    expect(stage('Delivered/Collected', 'Delivered to : A SAMPLE PERSON')).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    const unknown = stage('Sample type', 'Sample counter scan');
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample counter scan' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-05-12T09:00:00+02:00', location: 'SAMPLE TOWN', description: 'Sample counter scan' });
    // A scanner's comment is not a parcel event, whatever its type.
    expect(stage('In Transit', 'COMMENT').events![0]!.stage).toBeUndefined();
  });

  it('reads the page’s notice as a missing item, and its form without one, or another notice, as inconclusive', async () => {
    expect(() => parseSouthAfricanPost(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const blank = page('not-found').replace('No tracking record found', '');
    expect(() => parseSouthAfricanPost(blank, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = page('not-found').replace('No tracking record found', 'Sample service notice');
    expect(() => parseSouthAfricanPost(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSouthAfricanPost(withRows(''), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const lookup = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number: UNKNOWN });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(BLOCKED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the page to the whole requested code and rejects a changed page', () => {
    expect(() => parseSouthAfricanPost(page('delivered'), 'ZZ000000045ZA'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'The South African Post Office answered for a different item' }));
    // The page echoes the number as it was typed.
    expect(parseSouthAfricanPost(page('delivered').replace(`>${DELIVERED}<`, `>${DELIVERED.toLowerCase()}<`), DELIVERED).events).toHaveLength(7);
    const delivered = page('delivered');
    for (const changed of [
      delivered.replace('<strong>Item Number</strong>', '<strong>Item</strong>'),
      delivered.replace('PARCEL TRACKING RESULTS', 'TRACKING RESULTS'),
      delivered.replace('<table class="table">', '<table class="table"><tr><th>#</th></tr></table><table class="table">'),
      delivered.replace('<th>Branch</th>', '<th>Office</th>'),
      delivered.replace('<td>2026/05/12</td>', '<td>12/05/2026</td>'),
      delivered.replace('<td>2026/05/12</td>', '<td>2026/02/30</td>'),
      delivered.replace('<td>12:05 PM</td>', '<td>12:05</td>'),
      delivered.replace('<td>12:05 PM</td>', '<td>13:05 PM</td>'),
      delivered.replace('<td>1</td>', '<td>one</td>'),
      delivered.replace('<td>SAMPLE TOWN</td>\n                        <td>Delivered to : A SAMPLE PERSON</td>', '<td>SAMPLE TOWN</td>'),
      withRows(row(1, '', '2026/05/12', '9:00 AM', 'SAMPLE TOWN', '')),
      withRows(Array.from({ length: 501 }, (_, index) => row(index + 1, 'In Transit', '2026/05/06', '9:00 AM', 'SAMPLE HUB', 'Dispatched')).join('')),
    ]) {
      expect(() => parseSouthAfricanPost(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015ZA', 'ZZ00000001ZA', 'ZZ000000014ZAX', 'Z0000000014ZA', '12345678', 'T000002355', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSouthAfricanPostNumber(' zz-000-000-028 gb ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('delivered'))).mockResolvedValueOnce(reply(page('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-12T10:05:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'indeterminate'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_000_001)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under the Post Office to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'south-african-post-office' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'south-african-post-office', source: 'south-african-post-office', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(SOUTH_AFRICAN_POST_TRACKER))).toBe(true);
  });

  it('is asked about South African S10 codes, which detection leaves with the postal fallback', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('south-african-post-office');
    expect(recognitionAskedCarriers('ZZ000000015ZA')).not.toContain('south-african-post-office');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('south-african-post-office');
    for (const link of [`https://trackingnew.postoffice.co.za/?ParcelId=${DELIVERED}`,
      `https://tracking.postoffice.co.za/TrackNTrace/TrackNTrace.aspx?id=${DELIVERED}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'south-african-post-office', source: 'link' });
    }
  });
});

describe('South African Post Office status vocabulary', () => {
  it('maps every comment and type it recorded to the stage recorded for it, and leaves a scanner’s note out', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      if (!('stage' in entry)) {
        expect(statusMap.stage(null, wording), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'south-african-post-office', description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        expect(southAfricanPostStage(entry.wording, 'In Transit'), entry.wording).toBeNull();
        continue;
      }
      expect(southAfricanPostCommentStage(entry.wording) ?? southAfricanPostTypeStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'south-african-post-office', description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // The tracker's comment wins over its type: At Office is the arrival, the notice is ready for pickup.
    expect(southAfricanPostStage('First Notification to recipient', 'At Office')).toEqual({ stage: 'ready_for_pickup', source: 'carrier_map' });
    // Customs handing the item back is a clearance, not a return.
    expect(southAfricanPostStage('Returned from Customs', 'In Transit')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // The release in the tracker's own words, though they read as a hand-over to customs.
    expect(southAfricanPostStage('Handed over to customs authority for final delivery', 'In Transit')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Delivered - Sample Office']) expect(southAfricanPostCommentStage(wording), wording).toBeUndefined();
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(southAfricanPostStage('', '')).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import {
  adapter, BANGLADESH_POST_DOMESTIC_API, BANGLADESH_POST_DOMESTIC_PAGE, BANGLADESH_POST_INTERNATIONAL_API, BangladeshPostTracker,
} from './adapter.js';
import {
  bangladeshPostDomesticToken, normalizeBangladeshPostNumber, parseBangladeshPostDomestic, parseBangladeshPostInternational,
} from './parser.js';
import { bangladeshPostDomesticStage, bangladeshPostInternationalStage, bangladeshPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const INBOUND = 'ZZ000000045CN';
const ON_ITS_WAY = 'ZZ000000059JP';
const DOMESTIC = 'ZZ000000014BD';
const ROLLED_BACK = 'ZZ000000028BD';
const UNKNOWN = 'ZZ000000031BD';
const FOREIGN_UNKNOWN = 'ZZ000000062CN';
const TOKEN = `1700000000TIME_SAMPLE${'0'.repeat(64)}`;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Scan = Record<string, unknown>;
type Domestic = { success: boolean; data: { item_id: unknown; pairs: { events: Scan[] }[] } };
const domestic = (name: string): Domestic => JSON.parse(text(`${name}.json`)) as Domestic;
const edited = (name: string, change: (payload: Domestic) => void): Domestic => {
  const payload = domestic(name);
  change(payload);
  return payload;
};
const scans = (payload: Domestic) => payload.data.pairs.at(-1)!.events;
/** The international reply's HTML, changed, then encoded the way the tracker encodes it. */
const table = (name: string, change: (html: string) => string) => JSON.stringify(change(JSON.parse(text(name)) as string));
const reply = (body: string, status = 200, type = 'text/html; charset=UTF-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

/** A transport that answers each of the two trackers. */
function trackers(answers: { international?: () => Response | Promise<Response>; page?: () => Response | Promise<Response>;
  lookup?: () => Response | Promise<Response> }) {
  return vi.fn<typeof fetch>(async (url) => {
    const answer = String(url) === BANGLADESH_POST_INTERNATIONAL_API ? answers.international
      : String(url) === BANGLADESH_POST_DOMESTIC_PAGE ? answers.page
        : String(url) === BANGLADESH_POST_DOMESTIC_API ? answers.lookup : undefined;
    if (!answer) throw new Error(`unexpected request to ${String(url)}`);
    return answer();
  });
}
const domesticTrackers = (lookup: () => Response | Promise<Response>) => trackers({
  international: () => reply(text('international-not-found.json')), page: () => reply(text('domestic-page.html')), lookup,
});

describe('Bangladesh Post international tracker', () => {
  it('posts the whole code once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('international-delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BangladeshPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 045 cn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BANGLADESH_POST_INTERNATIONAL_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `item_id=${INBOUND}`, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bangladesh-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads mail from abroad newest first, on the offices’ wall clocks, with its destination', () => {
    const result = parseBangladeshPostInternational(text('international-delivered.json'), INBOUND);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-02-09T10:31:17', expected_delivery: null, destination_country: 'BD' });
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-02-09T10:31:17', 'Exampur', 'Delivered', 'delivered'],
      ['2026-02-09T10:02:51', 'Exampur', 'Arrived at post office', 'in_transit'],
      ['2026-02-05T11:48:09', 'Sampleganj HO', 'Arrived at post office', 'in_transit'],
      ['2026-02-03T05:12:40', 'DHAKA SAMPLE SORTING OFFICE', 'Incomming', 'in_transit'],
    ]);
    // The reply does not say where an office is, so no scan gets an instant.
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/China|origin/i);
  });

  it('reads an item on its way, and a destination it cannot map by name', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('international-in-transit.json')));
    await expect(carrier(fetcher).track({ number: ON_ITS_WAY })).resolves.toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Arrived at post office', last_update_local: '2026-03-24T13:05:44', destination_country: 'BD',
      events: [{ location: 'Sampleganj HO' }, { description: 'Incomming' }] });
    const named = parseBangladeshPostInternational(table('international-in-transit.json', html => html.replaceAll('<td>Bangladesh</td>', '<td>Sample Islands</td>')), ON_ITS_WAY);
    expect(named).toMatchObject({ destination_country_name: 'Sample Islands' });
    expect(named).not.toHaveProperty('destination_country');
    const unnamed = parseBangladeshPostInternational(table('international-in-transit.json', html => html.replaceAll('<td>Bangladesh</td>', '<td>Not Found</td>')), ON_ITS_WAY);
    expect(unnamed).not.toHaveProperty('destination_country');
    expect(unnamed).not.toHaveProperty('destination_country_name');
  });

  it('turns the history round, keeps a repeated scan once and keeps the newest stage under an unknown wording', () => {
    const rows = (html: string) => html.split(/(?=\r\n\t\t\t {4}<tr>)/);
    const reversed = table('international-delivered.json', html => { const [head, ...rest] = rows(html); return head + rest.reverse().join(''); });
    expect(parseBangladeshPostInternational(reversed, INBOUND).events).toEqual(parseBangladeshPostInternational(text('international-delivered.json'), INBOUND).events);
    const repeated = table('international-delivered.json', html => html + rows(html).at(-1)!);
    expect(parseBangladeshPostInternational(repeated, INBOUND).events).toHaveLength(4);
    const unknown = parseBangladeshPostInternational(table('international-in-transit.json', html => html.replace(
      '<td>Arrived at post office</td>', '<td>Sample event</td>')), ON_ITS_WAY);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sample event' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-24T13:05:44', location: 'Sampleganj HO', description: 'Sample event' });
    const worded = parseBangladeshPostInternational(table('international-in-transit.json', html => html.replace(
      '<td>Arrived at post office</td>', '<td>Out for delivery</td>')), ON_ITS_WAY);
    expect(worded.events![0]).toMatchObject({ stage: 'out_for_delivery', stage_source: 'wording:language' });
  });

  it('reads the tracker’s “item not found” as missing, and its other answers as inconclusive or changed', async () => {
    expect(() => parseBangladeshPostInternational(text('international-not-found.json'), FOREIGN_UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const lookup = (body: string, status = 200) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status))).track({ number: FOREIGN_UNKNOWN });
    await expect(lookup(`${text('international-not-found.json').trim()}\r\n  `)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('international-database-error.json'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(table('international-delivered.json', html => html.split(/(?=\r\n\t\t\t {4}<tr>)/)[0]!))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(JSON.stringify(CHECK))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403)).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    for (const body of ['<html><body>Sample maintenance page</body></html>', '"Sample notice"', '{"item":"sample"}', 'null', '"<p>Sample</p>"']) {
      await expect(lookup(body), body).rejects.toMatchObject({ kind: 'schema' });
    }
    await expect(lookup(`\uFEFF${text('international-delivered.json')}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('rejects a changed table', () => {
    for (const change of [
      (html: string) => html.replace('<th>Status</th>', '<th>Event</th>'),
      (html: string) => html.replace('<th>Status</th>', ''),
      (html: string) => html.replace('<td>Delivered</td>', ''),
      (html: string) => html.replace('<td>Delivered</td>', '<td> </td>'),
      (html: string) => html.replace('09-02-2026 10:31:17', '2026-02-09 10:31:17'),
      (html: string) => html.replace('09-02-2026 10:31:17', '31-02-2026 10:31:17'),
      (html: string) => html.replace('09-02-2026 10:31:17', '09-02-2026 24:31:17'),
      (html: string) => html.replace('09-02-2026 10:31:17', '09-02-2026'),
      (html: string) => html.replace('id="tbl_result"', 'id="sample"'),
      (html: string) => html + html.split(/(?=\r\n\t\t\t {4}<tr>)/).at(-1)!.replace('10:31:17', '10:31:18').repeat(500),
    ]) {
      const body = table('international-delivered.json', change);
      expect(() => parseBangladeshPostInternational(body, INBOUND), change.toString()).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Bangladesh Post domestic tracker', () => {
  it('asks the domestic tracker, with its page’s token, about a Bangladesh Post code the international tracker does not know', async () => {
    const fetcher = domesticTrackers(() => reply(text('domestic-delivered.json'), 200, 'application/json'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BangladeshPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(DOMESTIC.toLowerCase()))
      .resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [BANGLADESH_POST_INTERNATIONAL_API, 'POST'], [BANGLADESH_POST_DOMESTIC_PAGE, 'GET'], [BANGLADESH_POST_DOMESTIC_API, 'POST'],
    ]);
    expect(fetcher.mock.calls[2]![1]).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      body: JSON.stringify({ item_id: DOMESTIC, csrf_token: TOKEN }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(fetcher.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)['User-Agent'] === 'SyntheticHost/1.0')).toBe(true);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: 'not_found' }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'domestic', outcome: 'ok', fallbackFrom: 'direct' }));
  });

  it('reads the newest booking’s scans newest first, on Dhaka time, with office names and no codes', () => {
    const result = parseBangladeshPostDomestic(domestic('domestic-delivered'), DOMESTIC);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered to Customer', last_update: '2026-03-04T15:56:55+06:00', expected_delivery: null });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-03-04T15:56:55+06:00', 'Exampur', 'Delivered to Customer', 'Delivered_To_Receipent', 'delivered'],
      ['2026-03-04T11:02:56+06:00', 'Exampur', 'Received', 'Receive_Item', 'in_transit'],
      ['2026-03-03T04:41:19+06:00', 'Sample RMS', 'Forwarded to Exampur HO', 'Forwarded', 'in_transit'],
      ['2026-03-03T04:40:00+06:00', 'Sample RMS', 'Bag Movement: Bag dispatched to Exampur HO', 'Bag_Movement', 'in_transit'],
      ['2026-03-03T01:15:08+06:00', 'Sample RMS', 'Received', 'Receive_Item', 'in_transit'],
      ['2026-03-02T21:22:37+06:00', 'Sampleganj', 'Booked', 'Item_Booked', 'accepted'],
    ]);
    // An earlier booking under the same code is not this item's.
    expect(JSON.stringify(result)).not.toMatch(/Oldbazar|99\d{4}|SAMPLEBAG|Parcel|TSO|Return/);
    expect(result).not.toHaveProperty('local_time');
  });

  it('reads a delivery a rollback undid as a failed one, and a rollback as moving nothing', () => {
    const result = parseBangladeshPostDomestic(domestic('domestic-rolled-back'), ROLLED_BACK);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Rollback: Wrong entry' });
    expect(result.events![0]).toEqual({ time: '2026-04-12T17:20:09+06:00', location: 'Demoganj', description: 'Rollback: Wrong entry', provider_code: 'Item_Rollback' });
    expect(result.events![1]).toMatchObject({ description: 'Delivered to customer was successful but due to rollback after set delivery attempt was unsuccessful',
      provider_code: 'Delivered_To_Receipent', stage: 'failed_attempt', stage_source: 'carrier_map' });
    const returned = parseBangladeshPostDomestic(edited('domestic-rolled-back', payload => {
      scans(payload)[2]!.Status = 'Return_To_Sender';
      scans(payload).pop();
    }), ROLLED_BACK);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Return' });
    const moved = parseBangladeshPostDomestic(edited('domestic-delivered', payload => {
      scans(payload).push({ ...scans(payload)[2]!, Event_Date: '05-03-2026' });
    }), DOMESTIC);
    // A move of the item's bag does not undo its delivery.
    expect(moved.events![1]).toMatchObject({ description: 'Delivered to Customer', stage: 'delivered' });
  });

  it('reads remarks without phone numbers, a scan without an office, and an unknown code by its remarks', () => {
    const result = parseBangladeshPostDomestic(edited('domestic-rolled-back', payload => {
      scans(payload)[3]!.Remarks = 'Recipient asked, call 01700-000000';
      scans(payload)[2]!.Branch_Info = 'Demoganj';
      scans(payload)[1]!.Status = 'Sample_Status';
      scans(payload)[1]!.Remarks = 'Out for delivery';
      scans(payload)[0]!.Remarks = null;
    }), ROLLED_BACK);
    expect(result.events!.map(event => [event.description, event.location, event.stage])).toEqual([
      ['Rollback: Recipient asked, call', 'Demoganj', undefined],
      ['Delivered to customer was successful but due to rollback after set delivery attempt was unsuccessful', undefined, 'failed_attempt'],
      ['Out for delivery', 'Demoganj', 'out_for_delivery'],
      ['Booked', 'Testpur', 'accepted'],
    ]);
    const unworded = parseBangladeshPostDomestic(edited('domestic-rolled-back', payload => {
      payload.data.pairs[0]!.events = [{ ...scans(payload)[0]!, Status: 'Sample_Status', Remarks: '' }];
    }), ROLLED_BACK);
    expect(unworded).toMatchObject({ status: 'unknown', last_status_text: 'Sample_Status' });
    expect(unworded.current_stage).toBeUndefined();
  });

  it('reads the tracker’s “no information” as missing, and its other refusals as invalid input or a changed request', async () => {
    const lookup = (body: string, status = 200) => carrier(domesticTrackers(() => reply(body, status, 'application/json'))).track({ number: UNKNOWN });
    await expect(lookup(text('domestic-not-found.json'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('domestic-not-found.json').replace(UNKNOWN, DOMESTIC))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"success":false,"message":"Invalid Item ID format. Please check the ID and try again","data":[]}'))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('{"success":false,"message":"Invalid access","data":[]}')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"success":false,"message":"Sample notice"}')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('CSRF token invalid', 403)).rejects.toMatchObject({ kind: 'schema', status: 403 });
    await expect(lookup(CHECK, 403)).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(' ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(JSON.stringify(edited('domestic-delivered', payload => { payload.data.item_id = UNKNOWN; payload.data.pairs = []; }))))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(JSON.stringify(edited('domestic-delivered', payload => { payload.data.item_id = UNKNOWN.toLowerCase(); }))))
      .resolves.toMatchObject({ status: 'delivered' });
  });

  it('needs its page’s token', async () => {
    expect(bangladeshPostDomesticToken(text('domestic-page.html'))).toBe(TOKEN);
    const lookup = (page: string, status = 200) => carrier(trackers({ international: () => reply(text('international-not-found.json')),
      page: () => reply(page, status), lookup: () => reply(text('domestic-delivered.json')) })).track({ number: DOMESTIC });
    await expect(lookup(text('domestic-page.html').replace(TOKEN, ''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(text('domestic-page.html').replace(TOKEN, 'a"b'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', 200)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(text('domestic-page.html'), 302)).rejects.toMatchObject({ kind: 'transport', status: 302 });
  });

  it('binds the reply to the whole requested code and rejects changed replies', () => {
    expect(() => parseBangladeshPostDomestic(domestic('domestic-delivered'), ROLLED_BACK))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Bangladesh Post answered for a different item' }));
    for (const [index, payload] of [[], null, 'sample', { success: 'true' }, { success: true }, { success: true, data: [] },
      edited('domestic-delivered', reply => { reply.data.item_id = 7; }),
      edited('domestic-delivered', reply => { (reply.data as Record<string, unknown>).pairs = {}; }),
      edited('domestic-delivered', reply => { reply.data.pairs = Array.from({ length: 51 }, () => reply.data.pairs[0]!); }),
      edited('domestic-delivered', reply => { (reply.data.pairs as unknown[])[1] = 'booking'; }),
      edited('domestic-delivered', reply => { (scans(reply) as unknown[])[1] = 'scan'; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Status = ''; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Status = ['Receive_Item']; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Status = 'Receive Item 2'; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Remarks = 7; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Event_Date = '2026-03-03'; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Event_Date = '30-02-2026'; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Event_Time = '13:15:08 AM'; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Event_Time = '01:15 AM'; }),
      edited('domestic-delivered', reply => { scans(reply)[1]!.Event_Time = null; }),
      edited('domestic-delivered', reply => { reply.data.pairs[1]!.events = Array.from({ length: 501 }, () => scans(reply)[0]!); })].entries()) {
      expect(() => parseBangladeshPostDomestic(payload, DOMESTIC), `changed reply ${index}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBangladeshPostDomestic(edited('domestic-delivered', reply => { reply.data.pairs[1]!.events = []; }), DOMESTIC))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('asks only about Bangladesh Post’s own codes, and only after the international tracker says it does not know them', async () => {
    const foreign = domesticTrackers(() => reply(text('domestic-delivered.json')));
    await expect(carrier(foreign).track({ number: FOREIGN_UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(foreign).toHaveBeenCalledTimes(1);
    for (const [international, kind] of [[() => reply(text('international-database-error.json')), 'indeterminate'],
      [() => reply(CHECK, 403), 'challenge'], [() => reply('', 429), 'rate_limited']] as const) {
      const fetcher = trackers({ international, page: () => reply(text('domestic-page.html')), lookup: () => reply(text('domestic-delivered.json')) });
      await expect(carrier(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('tries the domestic tracker once more after a failed connection', async () => {
    let pages = 0;
    const fetcher = trackers({ international: () => reply(text('international-not-found.json')),
      page: () => { pages += 1; if (pages === 1) throw new TypeError('fetch failed'); return reply(text('domestic-page.html')); },
      lookup: () => reply(text('domestic-delivered.json')) });
    await expect(carrier(fetcher).track({ number: DOMESTIC })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const down = trackers({ international: () => reply(text('international-not-found.json')),
      page: () => { throw new TypeError('fetch failed'); } });
    await expect(carrier(down).track({ number: DOMESTIC })).rejects.toMatchObject({ kind: 'transport' });
    expect(down).toHaveBeenCalledTimes(3);
  });
});

describe('Bangladesh Post adapter', () => {
  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015BD', 'ZZ00000001BD', 'ZZ000000014BDX', 'Z0000000014BD', '1234567890123', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBangladeshPostNumber(' zz-000-000-045 cn ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(reply(text('international-delivered.json')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(known).recognize!(INBOUND)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-09T10:31:17' });
    await expect(carrier(domesticTrackers(() => reply(text('domestic-delivered.json')))).recognize!(DOMESTIC))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T09:56:55.000Z' });
    await expect(carrier(domesticTrackers(() => reply(text('domestic-not-found.json')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too Many Requests',
      { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DOMESTIC)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const domesticLimit = domesticTrackers(() => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(domesticLimit).track({ number: DOMESTIC })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('international-not-found.json'), status));
      await expect(carrier(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DOMESTIC)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('international-delivered.json')));
    await expect(carrier(flaky).track({ number: INBOUND })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('international-delivered.json')));
    await expect(carrier(immediate).track({ number: INBOUND }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: INBOUND }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // A hung request ends at its own timeout or at the budget; either is correct.
    await expect(carrier(slow).track({ number: DOMESTIC }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: INBOUND })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Bangladesh Post to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('international-delivered.json')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INBOUND, carrier: 'bangladesh-post' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'bangladesh-post', source: 'bangladesh-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === BANGLADESH_POST_INTERNATIONAL_API)).toBe(true);
  });

  it('leaves Bangladeshi S10 codes with the postal fallback, and reads the domestic tracker’s link', () => {
    expect(detectCarrierMatch(DOMESTIC)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    for (const link of [`https://report.dms.bdpost.gov.bd/?v=${DOMESTIC}`, `https://report.dms.bdpost.gov.bd/?V=${DOMESTIC}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DOMESTIC, carrier: 'bangladesh-post', source: 'link' });
    }
  });
});

describe('Bangladesh Post status vocabulary', () => {
  it('maps every code and wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && typeof entry.code === 'string' ? entry.code : null;
      const stage = code ? bangladeshPostDomesticStage(code, entry.wording) : bangladeshPostInternationalStage(entry.wording);
      expect(stage, entry.wording).toBe(entry.stage);
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'bangladesh-post', providerCode: code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'bangladesh-post', providerCode: 'Item_Rollback', description: 'Rollback: Sample' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(bangladeshPostStage(' delivered ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Delivered_To_Receipent', 'Sample event']) expect(bangladeshPostInternationalStage(wording), wording).toBeUndefined();
    for (const code of ['constructor', 'toString', 'Item_Rollback', 'Delivered']) expect(bangladeshPostDomesticStage(code), code).toBeUndefined();
    expect(bangladeshPostStage('')).toBeNull();
  });
});

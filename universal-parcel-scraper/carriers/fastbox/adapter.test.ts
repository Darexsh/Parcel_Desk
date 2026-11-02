import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, FASTBOX_TRACKER, fastboxTrackerUrl, FastboxTracker } from './adapter.js';
import { normalizeFastboxNumber, parseFastbox } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'FB2601010000000001';
const UNKNOWN = 'FB2601010000000002';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// A row of the history table, as the page writes it.
const row = (stamp: string, tag: string, place: string, shipper: string, detail: string) => {
  const [day, time] = stamp.split(' ');
  return `<tr>\n<td>${day} <span class="txtLight">${time}</span></td>\n<td>${tag}</td>\n<td>${place}</td>\n<td>${shipper}</td>\n<td>${detail}</td>\n</tr>\n`;
};
const withRows = (rows: string) => fixture('in-transit').replace(/(\s*<\/tbody>\s*<\/table>\s*<\/div>\s*<\/div>\s*<p>)/, `${rows}$1`);

describe('Fastbox parser', () => {
  it("reads Fastbox's steps on Korea's clock and its partners' rows on their own, newest last on the page", () => {
    const result = parseFastbox(fixture('in-transit'), NUMBER);
    expect(result.events?.map((event) => [event.time ?? `local ${event.local_time}`, event.description, event.stage, event.location ?? null])).toEqual([
      ['local 2026-01-10T16:10:00', 'Taken out for delivery', 'out_for_delivery', 'EXAMPLE TOWN'],
      ['local 2026-01-08T21:25:00', 'Item presented to import Customs', 'customs', 'EXAMPLE CITY, EMS CENTRE'],
      // A receipt after the parcel moved on is no step back, nor is the destination post's advance data.
      ['local 2026-01-08T21:20:00', 'Item received at office of exchange (Inb)', 'in_transit', 'EXAMPLE CITY, EMS CENTRE'],
      ['local 2026-01-06T04:55:00', 'Item received', 'in_transit', 'SEOUL INTERNATIONAL POST OFFICE'],
      ['2026-01-05T23:30:00+09:00', 'Received by Air carriers', 'in_transit', 'INCHEON'],
      ['local 2026-01-05T21:30:00', 'Item Booked', 'in_transit', 'Office - 00000'],
      ['2026-01-05T16:00:00+09:00', 'Posting/Collection', 'in_transit', 'INCHEON'],
      ['2026-01-05T11:40:00+09:00', 'Hand over to Delivery Company', 'in_transit', null],
      ['2026-01-05T09:40:00+09:00', 'Processed Through Facility for International Shipping', 'accepted', 'Fastbox warehouse'],
      ['2026-01-02T10:15:00+09:00', 'Order Accepted', 'registered', 'Fastbox warehouse'],
    ]);
    expect(result.events?.[4]).toMatchObject({ local_time: '2026-01-05T23:30:00', time_zone: 'Asia/Seoul', time_zone_basis: 'carrier', provider_code: 'InTransit' });
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Taken out for delivery', last_update: null,
      last_update_local: '2026-01-10T16:10:00', origin_country: 'KR', destination_country: 'IN', delivery_carrier: 'korea-post', delivery_tracking_number: 'EE000000005KR',
    });
  });

  it("never reads the recipient's name or address", () => {
    const text = JSON.stringify(parseFastbox(fixture('in-transit'), NUMBER));
    expect(text).not.toMatch(/RECIPIENT|STREET|EXAMPLE STATE/);
  });

  it('names the partner only when its name and its invoice name the same carrier', () => {
    const other = parseFastbox(fixture('in-transit').replace('<td>Korea Post EMS</td>\n', '<td>Example Courier</td>\n'), NUMBER);
    expect(other).not.toHaveProperty('delivery_carrier');
    expect(other).not.toHaveProperty('delivery_tracking_number');
    expect(detectCarrierMatch('EE000000005KR').candidates).toContain('korea-post');
  });

  it('reads the delivery and keeps its order on the page', () => {
    const result = parseFastbox(withRows(row('2026-01-11 09:05', 'Delivered', 'EXAMPLE TOWN', 'Example Post International', 'Item delivered')), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Item delivered' });
  });

  it('reads the form and its alert for the whole invoice as not found', () => {
    expect(() => parseFastbox(fixture('not-found'), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    // The form for another invoice, or a page without the alert, is no answer for this one.
    expect(() => parseFastbox(fixture('not-found'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastbox(fixture('not-found').replace(/<script[^]*?<\/script>/, ''), UNKNOWN))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a challenge, another invoice and a changed table apart from a missing parcel', () => {
    expect(() => parseFastbox(CHALLENGE, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseFastbox(fixture('in-transit'), 'FB2601010000000003')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastbox(fixture('in-transit').replace('<th scope="col">Shipping</th>', '<th scope="col">Carrier</th>'), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastbox(fixture('in-transit').replace('<th scope="col">Domestic Invoice No</th>', '<th scope="col">Reciepient</th>'), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastbox(withRows(row('2026-02-30 10:00', 'InTransit', 'INCHEON', 'Korea Post EMS', 'Dispatched')), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFastbox(fixture('in-transit').replace(/<tbody class="center">\s*<tr>\s*<td>2026[^]*<\/tbody>/, '<tbody class="center"></tbody>'), NUMBER))
      .toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('accepts FB invoices of sixteen digits only', () => {
    expect(normalizeFastboxNumber(' fb2601010000000001 ')).toBe(NUMBER);
    for (const raw of ['FB260101000000001', 'FB26010100000000011', 'FX2601010000000001', `${NUMBER}&x=1`]) {
      expect(() => normalizeFastboxNumber(raw)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('declares the tags it maps', () => {
    for (const entry of statuses.entries.filter((entry) => 'code' in entry)) {
      expect(statusMapAnswer({ carrier: 'fastbox', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});

describe('Fastbox retrieval', () => {
  it('asks the tracking page for the invoice', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const instance = carrier(fetcher);
    expect(instance.steps).toEqual(['direct', 'retry']);
    await expect(instance.track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fastboxTrackerUrl(NUMBER)).toBe(`${FASTBOX_TRACKER}?fb_invoice_no=${NUMBER}`);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://fastbox.co.kr/DHUB/tracking.php?fb_invoice_no=${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET' });
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    await expect(instance.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('reads an unknown invoice as not found, once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')));
    await expect(new FastboxTracker({ fetcher }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[301, 'transport'], [404, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])(
    'keeps HTTP %s apart from a missing parcel', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('Failure', { status: Number(status) }));
      await expect(new FastboxTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a read that does not reach the site', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new FastboxTracker({ fetcher, recorder }).fetch(NUMBER, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('gives a hanging first read half of the budget and the retry the rest', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const lookup = expect(new FastboxTracker({ fetcher }).fetch(NUMBER, { budgetMs: 2000 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(2000);
    await lookup;
    expect(ended).toEqual([1000, 2000]);
  });
});

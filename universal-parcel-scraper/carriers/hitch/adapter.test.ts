import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, hitchTrackingUrl } from './adapter.js';
import { normalizeHitchNumber, parseHitch } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'ZIP0SYNTHETIC01';
const REFERENCE = 'B0000017';
const UNKNOWN = 'ZIP0SYNTHETIC99';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const delivered = () => text('delivered.html');
/** The delivered page with its timeline cut after the step named, and the current status given. */
const until = (step: string, current: string) => {
  const page = delivered();
  const start = page.indexOf(`<div class="item-title">${step}</div>`);
  const end = page.indexOf('</ul>');
  return (page.slice(0, page.indexOf('</li>', start) + 5) + page.slice(end))
    .replace('<td><div>Delivered</div></td>', `<td><div>${current}</div></td>`);
};
/** The delivered page without its timeline. */
const withoutSteps = (current: string) => delivered().replace(/<li class="tl-item">[\s\S]*<\/li>/, '')
  .replace('<td><div>Delivered</div></td>', `<td><div>${current}</div></td>`);

describe('Hitch numbers', () => {
  it('takes ZIP and twelve letters and digits, or a booking reference, in capitals', () => {
    expect(normalizeHitchNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    expect(normalizeHitchNumber(REFERENCE)).toBe(REFERENCE);
    for (const other of ['ZIP0SYNTHETIC0', 'ZIP0SYNTHETIC011', 'ZAP0SYNTHETIC01', 'B000001', 'B00000171', 'BX000017']) {
      expect(() => normalizeHitchNumber(other), other).toThrow('ZIP and twelve letters and digits');
    }
  });

  it('offers Hitch for a ZIP number, and reads a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER).candidates).toContain('hitch');
    expect(parseTrackingInput(`https://hitch.com.ph/tracking?no=${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'hitch' });
  });
});

describe('Hitch tracking', () => {
  it('asks the tracker’s page for the number', async () => {
    const fetcher = replying(() => html(delivered()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://hitch.com.ph/tracking?no=${NUMBER}`);
    expect(hitchTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the timeline newest first, on wall clocks with no zone, without the remarks', () => {
    const result = parseHitch(delivered(), NUMBER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-05T14:18:00', expected_delivery: null, timezone: 'Asia/Manila',
      events: [
        { local_time: '2026-03-05T14:18:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        // Two steps of one minute keep Hitch's order, reversed.
        { local_time: '2026-03-05T08:31:00', description: 'In transit', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T08:31:00', description: 'Assigned for delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-04T12:07:00', description: 'Arrived in delivery branch', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T11:40:00', description: 'Processing to Delivery Destination', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T09:12:00', description: 'Received at Hub', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T15:05:00', description: 'New', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // A remark is free text, and could name the recipient or the rider.
    const remarked = delivered().replace('<div class="item-title">Delivered</div>', '<div class="item-title">Delivered</div><div class="item-detail">Received by Synthetic Person</div>');
    expect(JSON.stringify(parseHitch(remarked, NUMBER))).not.toMatch(/Synthetic Person|New Package Added|Mar\. 2/);
  });

  it('finds a booking by its reference, and names its tracking number', async () => {
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).track({ number: REFERENCE.toLowerCase() })).resolves.toMatchObject({
      status: 'delivered', canonical_tracking_number: NUMBER, last_update_local: '2026-03-05T14:18:00',
    });
    expect(fetcher.mock.calls[0]![0]).toBe(`https://hitch.com.ph/tracking?no=${REFERENCE}`);
  });

  it('stages a booking on its way by its current status, else by its newest staged step', () => {
    expect(parseHitch(until('Arrived in delivery branch', 'Arrived in delivery branch'), NUMBER)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived in delivery branch', last_update_local: '2026-03-04T12:07:00',
    });
    expect(parseHitch(until('New', 'New'), NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered' });
    // A status the map does not list falls to the shared wording rules, and then to the newest staged step.
    expect(parseHitch(until('In transit', 'Failed Delivery'), NUMBER)).toMatchObject({
      status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'wording:failed_attempt', last_status_text: 'Failed Delivery',
    });
    expect(parseHitch(until('In transit', 'Synthetic state'), NUMBER)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map', last_status_text: 'Synthetic state',
    });
    const unlisted = parseHitch(delivered().replace('<div class="item-title">Delivered</div>', '<div class="item-title">Returned to Sender</div>')
      .replace('<td><div>Delivered</div></td>', '<td><div>Synthetic state</div></td>'), NUMBER);
    expect(unlisted.events![0]).toEqual({ local_time: '2026-03-05T14:18:00', description: 'Returned to Sender', stage: 'returned', stage_source: 'wording:language' });
    expect(unlisted).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });

  it('reads a booking without steps from its current status alone', () => {
    expect(parseHitch(withoutSteps('New'), NUMBER)).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: 'New', last_update_local: null, summary_only: true, events: [],
    });
    expect(() => parseHitch(withoutSteps('Synthetic state'), NUMBER)).toThrow(NoHistoryError);
  });

  it('reads the tracker’s notice for a number it holds no booking under as not found', async () => {
    const fetcher = replying(() => html(text('not-found.html')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a moved route, a refusal, a firewall page, a rate limit and an outage apart from a missing parcel', async () => {
    const cases: [Response, string][] = [
      [html('', { status: 301, headers: { Location: 'https://hitch.com.ph/' } }), 'transport'],
      [html('', { status: 404 }), 'transport'],
      [html('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 }), 'challenge'],
      [html('', { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [html('', { status: 500 }), 'indeterminate'],
      [html('', { status: 503 }), 'maintenance'],
      [html('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'), 'challenge'],
      [html('<html><body><h1>Tracking</h1><p>Under maintenance</p></body></html>'), 'schema'],
      // The not-found page quotes another number than the one asked.
      [html(text('not-found.html')), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves another booking, a changed page and an unreadable step open or failed, never found', () => {
    expect(() => parseHitch(delivered(), 'ZIP0SYNTHETIC02')).toThrow('another shipment');
    expect(() => parseHitch(delivered(), 'B0000018')).toThrow('another shipment');
    expect(() => parseHitch(delivered().replace('<div class="">ZIP0SYNTHETIC01</div>', '<div class=""></div>'), NUMBER)).toThrow('without its number');
    expect(() => parseHitch(delivered().replace('<td><div>Delivered</div></td>', '<td><div></div></td>'), NUMBER)).toThrow('without its number or status');
    expect(() => parseHitch(delivered().replace('<strong>Tracking No.</strong>', '<strong>Waybill</strong>'), NUMBER)).toThrow('without its details');
    expect(() => parseHitch(delivered().replace('>Tracking Details<', '>Details<'), NUMBER)).toThrow('unexpected page');
    expect(() => parseHitch(text('not-found.html').replace("we couldn't find", 'we did not find'), UNKNOWN)).toThrow('unexpected notice');
    expect(() => parseHitch(delivered().replace('<div class="item-title">New</div>', '<div class="item-title"></div>'), NUMBER)).toThrow('invalid step');
    for (const [day, clock] of [['March 32, 2026', '3:05:PM'], ['Mars 2, 2026', '3:05:PM'], ['2026-03-02', '3:05:PM'],
      ['March 2, 2026', '13:05:PM'], ['March 2, 2026', '3:65:PM'], ['March 2, 2026', '15:05'], ['March 2, 2026', '']]) {
      const page = delivered().replace(/(<div class="strong">)March 2, 2026(<\/div>\s*<div>)3:05:PM(<\/div>)/, `$1${day}$2${clock}$3`);
      expect(page, `${day} ${clock}`).not.toBe(delivered());
      expect(() => parseHitch(page, NUMBER), `${day} ${clock}`).toThrow('invalid step time');
    }
  });

  it('reads noon and midnight on the twelve-hour clock', () => {
    const at = (clock: string) => parseHitch(delivered().replace('<div>2:18:PM</div>', `<div>${clock}</div>`), NUMBER).events!
      .find((event) => event.description === 'Delivered')!.local_time;
    expect(at('12:18:PM')).toBe('2026-03-05T12:18:00');
    expect(at('12:18:AM')).toBe('2026-03-05T00:18:00');
    expect(at('11:59:PM')).toBe('2026-03-05T23:59:00');
    expect(at('2:18 PM')).toBe('2026-03-05T14:18:00');
  });

  it('recognizes a number its tracker holds, and not one it does not', async () => {
    await expect(carrier(replying(() => html(delivered()))).recognize!(NUMBER))
      .resolves.toMatchObject({ known: true, lastActivityLocal: '2026-03-05T14:18:00' });
    await expect(carrier(replying(() => html(text('not-found.html')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).recognize!('ZIP123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Hitch status map', () => {
  it('stages every step name it lists, once each', () => {
    const wordings = statuses.entries.map((entry) => normalizeStatusWording(entry.wording));
    expect(new Set(wordings).size).toBe(wordings.length);
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('Synthetic state'))).toBeUndefined();
  });
});

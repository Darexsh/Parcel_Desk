import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ecomTrackingUrl } from './adapter.js';
import { normalizeEcomNumber, parseEcom } from './parser.js';
import { ecomStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'E00A0000001';
const UNKNOWN = 'E00A0000099';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const delivered = () => text('delivered.html');
const missing = () => text('not-found.html');
/** A history entry as the page renders it. */
const entry = (wording: string, datetime: string, place = '') => `
  <li class="track-event" > <span class="track-event__dot" aria-hidden="true"></span> <div> <p class="track-event__title">${wording}</p>
  <p class="type-small mt-1 text-ink-soft"> <time datetime="${datetime}" >Sample clock</time>${place ? ` <span aria-hidden="true">·</span> <span>${place}</span>` : ''} </p> </div> </li>`;
/** The fixture with its history's entries replaced. */
const withEntries = (...entries: string[]) => delivered().replace(/(<ol role="list" class="track-history[^>]*>)[\s\S]*?(<\/ol>)/, `$1${entries.join('')}$2`);

describe('Ecom Logistics numbers', () => {
  it('takes letters and digits, in either case', () => {
    expect(normalizeEcomNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['E00A', 'ECOMLOGISTICS', 'E00A0000001/2', '']) {
      expect(() => normalizeEcomNumber(other), other).toThrow('letters and digits');
    }
  });

  it('reads a link to the tracking page in each of its languages', () => {
    for (const link of [`https://shipecom.com/track/${NUMBER}`, `https://www.shipecom.com/fr/track/${NUMBER}/`, `https://shipecom.com/es/track/${NUMBER}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'ecom-logistics' });
    }
  });

  it('refuses another shape before asking, with no reason', async () => {
    const fetcher = replying(() => html(delivered()));
    const refused = carrier(fetcher).track({ number: 'E00A' }, { signal: AbortSignal.abort() });
    await expect(refused).rejects.toThrow(InvalidInputError);
    await expect(refused.catch((error: InvalidInputError) => error.reason)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Ecom Logistics tracking', () => {
  it('asks the tracking page for the one number', async () => {
    const fetcher = replying(() => html(delivered()));
    await carrier(fetcher).track({ number: NUMBER.toLowerCase() });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://shipecom.com/track/${NUMBER}`);
    expect(ecomTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the history newest first, with its offsets and the pickup town, without the destination prefix', () => {
    const result = parseEcom(delivered(), NUMBER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2031-04-19T14:06:40-04:00', expected_delivery: null,
      events: [
        { time: '2031-04-19T14:06:40-04:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2031-04-19T06:25:47-04:00', description: 'Outbound onto Delivery Truck', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2031-04-19T03:26:06-04:00', description: 'Linehaul Outbound', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2031-04-18T23:03:28-04:00', description: 'Received - No Discrepancy', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2031-04-18T18:22:03-04:00', description: 'First Mile Inbound', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2031-04-16T18:34:14-04:00', description: 'Sorted at our facility', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2031-04-16T15:48:35-04:00', location: 'Sampletown, ON, Canada', description: 'Picked Up', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/A0A|synthetic-form-token/);
  });

  it('reads a parcel on its way, keeps scans of one instant in the page’s order and stages another wording by the shared rules or not at all', () => {
    const result = parseEcom(withEntries(
      entry('Synthetic note', '2031-04-17T09:00:00-04:00'),
      entry('Out for delivery', '2031-04-17T09:00:00-04:00'),
      entry('Picked Up', '2031-04-16T15:48:35-04:00', 'Sampletown, ON, Canada'),
    ), NUMBER);
    expect(result.events?.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['Synthetic note', undefined, undefined], ['Out for delivery', 'out_for_delivery', 'wording:language'], ['Picked Up', 'accepted', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
  });

  it('reads the page for the number asked as not found', async () => {
    const fetcher = replying(() => html(missing(), { status: 404 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a moved route, a firewall page, a rate limit and an outage apart from a missing parcel', async () => {
    const cases: [Response, string][] = [
      [html('', { status: 302, headers: { Location: 'https://shipecom.com/track' } }), 'transport'],
      [html('<html><body><h1>Page not found</h1></body></html>', { status: 404 }), 'transport'],
      [html('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [html('', { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [html('', { status: 500 }), 'indeterminate'],
      [html('', { status: 503 }), 'maintenance'],
      [html('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [html('<html><body><h2>Server Error</h2></body></html>'), 'schema'],
      [html(''), 'schema'],
      // The not-found page echoes another number than the one asked.
      [html(missing(), { status: 404 }), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves another number, an empty history and a changed page open or failed, never found', () => {
    expect(() => parseEcom(delivered().replace(`<span class="track-code">${NUMBER}</span>`, '<span class="track-code">E00A0000002</span>'), NUMBER))
      .toThrow('another number');
    expect(() => parseEcom(delivered().replace(`<span class="track-code">${NUMBER}</span>`, ''), NUMBER)).toThrow('without the number asked');
    expect(() => parseEcom(delivered().replace('data-track-result="delivered"', 'data-track-result=""'), NUMBER)).toThrow('without its state');
    expect(() => parseEcom(delivered().replace('data-track-result="delivered"', ''), NUMBER)).toThrow('unexpected page');
    expect(() => parseEcom(missing().replace('</main>', '<ol class="track-history"></ol></main>'), UNKNOWN)).toThrow('unexpected page');
    expect(() => parseEcom(withEntries(), NUMBER)).toThrow(NoHistoryError);
    expect(() => parseEcom(withEntries(entry('', '2031-04-17T09:00:00-04:00')), NUMBER)).toThrow('invalid scan');
    for (const datetime of ['2031-04-17T09:00:00', '2031-04-31T09:00:00-04:00', 'Sat 17 Apr', '']) {
      expect(() => parseEcom(withEntries(entry('Picked Up', datetime)), NUMBER), datetime).toThrow('invalid scan');
    }
  });

  it('recognizes a number its tracker holds, and not one it does not know', async () => {
    await expect(carrier(replying(() => html(delivered()))).recognize!(NUMBER))
      .resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(missing(), { status: 404 }))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).recognize!('E00A')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Ecom Logistics status map', () => {
  it('stages every wording it lists, and the app reads it', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
      expect(ecomStage(wording), wording).toEqual({ stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'ecom-logistics', providerCode: null, description: 'Outbound onto Delivery Truck' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'ecom-logistics', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, goLogisticsTrackingUrl } from './adapter.js';
import { normalizeGoLogisticsNumber, parseGoLogistics } from './parser.js';
import { goLogisticsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '0000000099';
const UNKNOWN = '0000000098';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const delivered = () => text('delivered.html');
const missing = () => text('not-found.html');
/** A scan as the page lists it. */
const line = (day: string, time: string, wording: string) => `<div class="NTitemLine NTprimary">
<div class="NTitemDate">${day}</div>\n<div class="NTitemTime">${time}</div>\n<div class="NTitemAgent">Driver: 0001&nbsp;</div>
<div class="NTitemHistory">${wording}</div>\n</div>\n`;
/** The not-found page for the number with these scans. */
const withLines = (...lines: string[]) => missing().replace(UNKNOWN, NUMBER).replace('<div style="clear:both"></div>', `${lines.join('')}<div style="clear:both"></div>`);

describe('GO Logistics numbers', () => {
  it('takes six to twenty letters and digits, in either case', () => {
    expect(normalizeGoLogisticsNumber(` ${NUMBER.slice(0, 5)} ${NUMBER.slice(5)} `)).toBe(NUMBER);
    expect(normalizeGoLogisticsNumber('ab00001')).toBe('AB00001');
    for (const other of ['00001', 'GOLOGISTICS', '0'.repeat(21), '0000000099/1', '']) {
      expect(() => normalizeGoLogisticsNumber(other), other).toThrow('letters and digits');
    }
  });

  it('reads a link to the tracker', () => {
    expect(parseTrackingInput(`https://services.gologistics.com.au/track/iframe2.php?item=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'go-logistics-au' });
  });

  it('refuses another shape before asking', async () => {
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).track({ number: '00001' })).rejects.toThrow(InvalidInputError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('GO Logistics tracking', () => {
  it('asks the tracker for the one number', async () => {
    const fetcher = replying(() => html(delivered()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://services.gologistics.com.au/track/iframe2.php?item=${NUMBER}`);
    expect(goLogisticsTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the history newest first on Sydney’s clock, without the driver, the signatory or the signature', () => {
    const result = parseGoLogistics(delivered(), NUMBER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Consignment Delivered',
      last_update: '2025-03-04T09:47:00+11:00', expected_delivery: null, timezone: 'Australia/Sydney',
      events: [
        { time: '2025-03-04T09:47:00+11:00', description: 'Consignment Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2025-03-04T06:20:00+11:00', description: 'Consignment Accepted for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2025-03-03T16:05:00+11:00', description: 'Data Uploaded', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2025-03-03T14:40:00+11:00', description: 'Consignment Collected', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2025-03-03T14:15:00+11:00', description: 'Add To Consignment', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Signatory|pieces|base64|Driver|0001|0002/);
  });

  it('reads the latest consignment of a number used again', () => {
    const result = parseGoLogistics(text('reused.html'), NUMBER);
    expect(result.events?.map((event) => [event.time, event.description])).toEqual([
      ['2025-04-05T11:58:00+11:00', 'Data Uploaded'],
      ['2025-04-05T01:00:00+11:00', 'Consignment Collected'],
    ]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('keeps scans of one minute in the page’s order and stages another wording by the shared rules or not at all', () => {
    const result = parseGoLogistics(withLines(
      line('3 Mar 2025', '2:40 PM', 'Consignment Collected'),
      line('4 Mar 2025', '6:20 AM', 'Out for delivery'),
      line('4 Mar 2025', '6:20 AM', 'Synthetic note'),
    ), NUMBER);
    expect(result.events?.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['Synthetic note', undefined, undefined], ['Out for delivery', 'out_for_delivery', 'wording:language'], ['Consignment Collected', 'accepted', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
  });

  it('reads the heading alone as not found', async () => {
    const fetcher = replying(() => html(missing()));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => parseGoLogistics(missing(), UNKNOWN)).toThrow(NotFoundError);
  });

  it('keeps a moved route, a firewall page, a rate limit and an outage apart from a missing parcel', async () => {
    const cases: [Response, string][] = [
      [html('', { status: 302, headers: { Location: 'https://gologistics.com.au/' } }), 'transport'],
      [html('<html><body><h1>Not Found</h1></body></html>', { status: 404 }), 'transport'],
      [html('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [html('', { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [html('', { status: 500 }), 'indeterminate'],
      [html('', { status: 503 }), 'maintenance'],
      [html('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [html('<html><body><h2>Database Error</h2></body></html>'), 'schema'],
      [html(''), 'schema'],
      // The page repeats another number than the one asked.
      [html(missing()), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves another number and a changed page open or failed, never found', () => {
    expect(() => parseGoLogistics(delivered().replace(`>${NUMBER}<`, '>0000000097<'), NUMBER)).toThrow('another number');
    expect(() => parseGoLogistics(delivered().replace(`>${NUMBER}<`, '><'), NUMBER)).toThrow('without the number asked');
    expect(() => parseGoLogistics(delivered().replaceAll('NTtrackInfo', 'NTtrackOther'), NUMBER)).toThrow('unexpected page');
    expect(() => parseGoLogistics(withLines(line('3 Mar 2025', '2:40 PM', '')), NUMBER)).toThrow('invalid scan');
    for (const [day, time] of [['31 Feb 2025', '2:40 PM'], ['3 Mar 2025', '14:40'], ['', '2:40 PM'], ['3 Mar 2025', '']]) {
      expect(() => parseGoLogistics(withLines(line(day!, time!, 'Consignment Collected')), NUMBER), `${day} ${time}`).toThrow('invalid scan');
    }
  });

  it('recognizes a number its tracker holds, and not one it does not know', async () => {
    await expect(carrier(replying(() => html(delivered()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(missing()))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).recognize!('00001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('GO Logistics status map', () => {
  it('stages every wording it lists, and the app reads it', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
      expect(goLogisticsStage(wording), wording).toEqual({ stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'go-logistics-au', providerCode: null, description: 'Consignment Accepted for Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'go-logistics-au', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});

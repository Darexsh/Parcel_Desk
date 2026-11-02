import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, tntAuTrackingUrl } from './adapter.js';
import { normalizeTntAuNumber, parseTntAu } from './parser.js';
import { statusMap, tntAuStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'TNA000000001';
const UNKNOWN = 'TNA000000009';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const delivered = () => text('delivered.html');
const missing = () => text('not-found.html');
/** The delivered page with these scans in place of its own, oldest first. */
const withRows = (...rows: [string, string, string, string][]) => delivered().replace(/(Depot<\/td><\/tr>)[\s\S]*?(<\/table><br>)/,
  (_, head: string, tail: string) => `${head}${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}${tail}`);

describe('TNT Australia numbers', () => {
  it('takes a domestic consignment, three letters and nine digits, in either case', () => {
    expect(normalizeTntAuNumber(' tna 000000001 ')).toBe(NUMBER);
    for (const other of ['TN000000001', 'TNA00000001', '123456789', 'TNA0000000011', '']) {
      expect(() => normalizeTntAuNumber(other), other).toThrow('three letters and nine digits');
    }
  });

  it('is offered at low confidence beside the other carriers of the shape, and read from a link to the tracker', () => {
    expect(detectCarrierMatch(NUMBER).candidates).toContain('tnt-au');
    expect(detectCarrierMatch(NUMBER).confidence).toBe('low');
    expect(parseTrackingInput(tntAuTrackingUrl(NUMBER))).toMatchObject({ trackingNumber: NUMBER, carrier: 'tnt-au' });
  });

  it('refuses another shape before asking', async () => {
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).track({ number: '123456789' })).rejects.toThrow(InvalidInputError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('TNT Australia tracking', () => {
  it('asks the tracker for the one consignment', async () => {
    const fetcher = replying(() => html(delivered()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://www.tntexpress.com.au/interaction/ASPs/trackref_detail.asp?con=${NUMBER}`);
  });

  it('reads the history newest first on the depots’ wall clocks, and the booking notices keep the stage', () => {
    expect(parseTntAu(delivered(), NUMBER)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Book-In Delivery Arranged', last_update: null, last_update_local: '2026-03-05T16:59:00', expected_delivery: null,
      events: [
        { local_time: '2026-03-05T16:59:00', location: 'Bunbury', description: 'Book-In Delivery Arranged', stage: 'delivered', stage_source: 'none' },
        { local_time: '2026-03-05T11:04:00', location: 'Bunbury', description: 'We\'ve delivered your shipment', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T10:18:00', location: 'Bunbury', description: 'Your shipment\'s with a driver', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T10:09:00', location: 'Bunbury', description: 'We\'re processing your shipment', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-04T15:42:00', location: 'Bunbury', description: 'Book-In Delivery Requested', stage: 'in_transit', stage_source: 'none' },
        { local_time: '2026-03-04T06:56:00', location: 'Bunbury', description: 'We\'re processing your shipment', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T17:35:00', location: 'Perth - Kewdale', description: 'We\'re processing your shipment', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T14:19:00', location: 'Perth - Kewdale', description: 'Your shipment data is lodged', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('dates each scan on its depot’s clock', async () => {
    const answer = await createTracker({ fetcher: replying(() => html(delivered())), providers: [], env: {} })
      .track({ number: NUMBER, carrier: 'tnt-au' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'tnt-au', source: 'tnt-au', result: { current_stage: 'delivered', last_update: '2026-03-05T16:59:00+08:00' } });
    expect(answer.result.events.map((event) => [event.time, event.time_zone_basis])).toContainEqual(['2026-03-02T14:19:00+08:00', 'place']);
  });

  it('keeps the estimated delivery of a consignment on its way, and stages another wording by the shared rules or not at all', () => {
    const result = parseTntAu(withRows(
      ['Your shipment data is lodged', '02/03/2026', '14:19', 'Perth - Kewdale'],
      ['Book-In Delivery Requested', '03/03/2026', '08:00', 'Bunbury'],
      ['Out for delivery', '04/03/2026', '07:00', 'Bunbury'],
      ['Synthetic note', '04/03/2026', '07:05', ''],
    ), NUMBER);
    expect(result.events?.map((event) => [event.description, event.location, event.stage, event.stage_source])).toEqual([
      ['Synthetic note', undefined, undefined, undefined],
      ['Out for delivery', 'Bunbury', 'out_for_delivery', 'wording:language'],
      ['Book-In Delivery Requested', 'Bunbury', 'registered', 'none'],
      ['Your shipment data is lodged', 'Perth - Kewdale', 'registered', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Synthetic note', expected_delivery: '2026-03-03' });
  });

  it('reads the tracker’s answer for a number it does not know as not found', async () => {
    const fetcher = replying(() => html(missing()));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => parseTntAu(missing(), UNKNOWN)).toThrow(NotFoundError);
  });

  it('keeps a moved route, a firewall page, a rate limit and an outage apart from a missing parcel', async () => {
    const cases: [Response, string][] = [
      [html('', { status: 302, headers: { Location: 'https://www.tnt.com/' } }), 'transport'],
      [html('<html><body><h1>Not Found</h1></body></html>', { status: 404 }), 'transport'],
      [html('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [html('', { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [html('', { status: 500 }), 'indeterminate'],
      [html('', { status: 503 }), 'maintenance'],
      [html('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [html('<html><body><h2>Database Error</h2></body></html>'), 'schema'],
      [html(''), 'schema'],
      // The page repeats another consignment than the one asked.
      [html(missing()), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('leaves another consignment and a changed page open or failed, never found', () => {
    expect(() => parseTntAu(delivered().replace(`Consignment No: ${NUMBER}`, 'Consignment No: TNA000000002'), NUMBER)).toThrow('another consignment');
    expect(() => parseTntAu(delivered().replace(`Consignment No: ${NUMBER}`, ''), NUMBER)).toThrow('without the consignment asked');
    expect(() => parseTntAu(delivered().replaceAll('appTable', 'otherTable'), NUMBER)).toThrow('unexpected page');
    expect(() => parseTntAu(delivered().replace('Depot</td>', 'Branch</td>'), NUMBER)).toThrow('columns changed');
    expect(() => parseTntAu(missing().replace(UNKNOWN, NUMBER).replace('No consignment was found', 'Try again later'), NUMBER)).toThrow('without scans');
    for (const [day, time] of [['31/02/2026', '14:19'], ['2026-03-02', '14:19'], ['02/03/2026', '2:19 PM'], ['02/03/2026', '24:00'], ['', '14:19']]) {
      expect(() => parseTntAu(withRows(['Your shipment data is lodged', day!, time!, 'Perth - Kewdale']), NUMBER), `${day} ${time}`).toThrow('invalid scan');
    }
    expect(() => parseTntAu(withRows(['', '02/03/2026', '14:19', 'Perth - Kewdale']), NUMBER)).toThrow('invalid scan');
  });

  it('recognizes a consignment its tracker holds, and not one it does not know', async () => {
    await expect(carrier(replying(() => html(delivered()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(missing()))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => html(delivered()));
    await expect(carrier(fetcher).recognize!('123456789')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('TNT Australia status map', () => {
  it('stages every wording it lists and declares the booking notices, and the app reads them', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(stage);
      if (stage) expect(tntAuStage(entry.wording), entry.wording).toEqual({ stage, source: 'carrier_map' });
      else expect(statusMap.gaps.map((gap) => gap.wording)).toContain(normalizeStatusWording(entry.wording));
    }
    expect(statusMapAnswer({ carrier: 'tnt-au', providerCode: null, description: 'Your shipment\'s with a driver' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'tnt-au', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});

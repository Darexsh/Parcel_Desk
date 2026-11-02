import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SMSA_ENDPOINT, SmsaTracker } from './adapter.js';
import { parseSmsaApp, SMSA_APP_ENDPOINT } from './app.js';
import { parseSmsa, smsaWording } from './parser.js';
import { smsaScanStage, smsaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '200000000017';
const TRANSIT = '200000000028';
const UNKNOWN = '200000000039';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const page = (name: string) => fixture(`${name}.html`);
const app = (name: string) => fixture(`app-${name}.xml`);
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const isApp = (input: unknown) => String(input) === SMSA_APP_ENDPOINT;
/** A transport answering the app's service and the page each with their own reply. */
const routed = (fromApp: () => Response | Promise<Response>, fromPage: () => Response | Promise<Response>) =>
  vi.fn<typeof fetch>().mockImplementation(async (input) => (isApp(input) ? fromApp() : fromPage()));
const rows = (result: ReturnType<typeof parseSmsa>) => result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null]);
const appRows = (result: ReturnType<typeof parseSmsaApp>) => result.events!.map((event) => [event.time, event.provider_code ?? null, event.description,
  event.location ?? null, event.stage ?? null]);
// The page a FortiWeb firewall serves in place of the site.
const BLOCKED = '<html><head><title>Web Page Blocked</title></head><body><p>The page cannot be displayed. Please contact the administrator for additional information.</p>'
  + '<p>Attack ID: 20000000</p><p>Message ID: 000000000000</p></body></html>';
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'managed\'};</script></body></html>';
const FAULT = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode>'
  + '<faultstring>Synthetic fault</faultstring></s:Fault></s:Body></s:Envelope>';
// One scan on a page, by its clock, and one in the app's reply, by its time.
const WITHIN = '(?:(?!<div class="trk-wrap">)[\\s\\S])*?';
const scan = (clock: string) => new RegExp(`<div class="trk-wrap">${WITHIN}<span>${clock}</span>${WITHIN}</div>\\s*</div>\\s*</div>`);
const appScan = (time: string) => new RegExp(`\\s*<a:TrackingDetails>(?:(?!<a:TrackingDetails>)[\\s\\S])*?<a:EventTime>${time}</a:EventTime>[\\s\\S]*?</a:TrackingDetails>`);
const status = (body: string, text: string) => body.replace(/<RequestStatus>[^<]*<\/RequestStatus>/, `<RequestStatus>${text}</RequestStatus>`);

describe('SMSA Express app service', () => {
  it('asks the app’s service once in English for the whole airway bill through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(xml(app('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SmsaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2000-0000-0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://strack.cloudapp.net/trackSMSA.svc');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'http://smsaexpress.com/track/ITrack/AllTrackDetails', 'User-Agent': 'SyntheticHost/1.0',
    } });
    const body = String(init!.body);
    expect(body).toContain(`<AllTrackDetails xmlns="http://smsaexpress.com/track/"><RequestData><AWB>${DELIVERED}</AWB><Language>en</Language>`);
    expect(body).toContain('<Username>smsamobile</Username>');
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'smsa-express', step: 'app', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered cross-border history as instants with SMSA’s codes, without names, comments or the repeated scan', () => {
    const result = parseSmsaApp(app('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-10-05T08:32:45Z', expected_delivery: null, weight_kg: 12.5, destination_country: 'SA' });
    expect(appRows(result)).toEqual([
      ['2026-10-05T08:32:45Z', 'DL', 'Delivered', 'Example Town', 'delivered'],
      ['2026-10-05T06:06:00Z', 'OD', 'Out for Delivery', 'Example Town', 'out_for_delivery'],
      ['2026-10-04T11:00:00Z', 'DEX93-5', 'Delivery on Hold - Waiting Customs Info/Invoice Completion', 'Example Town', 'customs'],
      ['2026-10-02T04:45:00Z', 'HOP', 'Shipment Departed SMSA Sorting Facility', 'Example Town', 'in_transit'],
      ['2026-10-02T04:40:00Z', 'HIP', 'Shipment Received at SMSA Sorting Facility', 'Example Town', 'in_transit'],
      ['2026-10-01T00:36:00Z', 'IC', 'Shipment Arrived at Destination Country - Under clearance process', 'Example Town', 'customs'],
      ['2026-10-01T00:36:00Z', 'CR', 'Customs Released', 'Example Town', 'in_transit'],
      ['2026-09-29T17:20:00Z', 'ST60-6', 'Shipment On Hold At Customs - Waiting To Complete Payment To Customs', 'Example Town', 'customs'],
      // The border scan the reply repeats is kept once.
      ['2026-09-20T11:45:00Z', 'BTRO', 'Shipment departed at the border - In Transit to destination', 'Sample Border GW', 'in_transit'],
      ['2026-09-19T15:14:00Z', 'ST77', 'Shipment Departed Origin Country', 'Sample City', 'in_transit'],
      ['2026-09-19T09:45:00Z', 'HOP', 'Shipment Departed SMSA Sorting Facility', 'Sample City', 'in_transit'],
      ['2026-09-19T09:30:00Z', 'HIP', 'Shipment Received at SMSA Sorting Facility', 'Sample City', 'in_transit'],
      ['2026-09-18T11:05:00Z', 'SOP', 'Shipment Departed SMSA Origin Facility', 'Sample City', 'in_transit'],
      ['2026-09-17T21:10:00Z', 'PU', 'Shipment Picked up from the shipper.', 'Sample City', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Person|Sample Shop|SAMPLE-REF|SYNTHETIC|Sample Courier|PIN Verified|0500000000|Signed|Forward|"AE"|2026-09-17T10:29/);
  });

  it('reads the same scans as the page, three hours earlier, and an estimate when the parcel is still on its way', () => {
    const result = parseSmsaApp(app('in-transit'), TRANSIT);
    expect(result).toEqual({
      status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Attempted Delivery - Consignee No Response', last_update: '2026-10-12T13:15:22Z', expected_delivery: '2026-10-14',
      events: [
        { time: '2026-10-12T13:15:22Z', description: 'Attempted Delivery - Consignee No Response', location: 'Example Town', provider_code: 'DEX03-1', stage: 'failed_attempt', stage_source: 'carrier_map' },
        { time: '2026-10-12T05:50:00Z', description: 'Out for Delivery', location: 'Example Town', provider_code: 'OD', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-10-11T21:10:00Z', description: 'Arrived Delivery Facility', location: 'Example Town', provider_code: 'AF', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-10-11T18:30:00Z', description: 'Shipment Departed SMSA Sorting Facility', location: 'Sample Hub', provider_code: 'HOP', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-10-11T15:05:00Z', description: 'Shipment Received at SMSA Sorting Facility', location: 'Sample Hub', provider_code: 'HIP', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-10-10T12:20:00Z', description: 'Shipment Departed SMSA Origin Facility', location: 'Sample Origin', provider_code: 'SOP', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-10-10T09:55:00Z', description: 'Shipment Picked up from the shipper.', location: 'Sample Origin', provider_code: 'PU', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    const paged = parseSmsa(page('in-transit'), TRANSIT);
    expect(result.events!.map((event) => event.description)).toEqual(paged.events!.map((event) => event.description));
    expect(result.events!.map((event) => new Date(Date.parse(event.time!) + 3 * 3_600_000).toISOString().slice(0, 16)))
      .toEqual(paged.events!.map((event) => String(event.local_time).slice(0, 16)));
    // An estimate the reply does not hold, or cannot be read, is none.
    for (const estimate of ['<EDD i:nil="true"/>', '<EDD>2026-10-14</EDD>', '<EDD>13/14/2026</EDD>']) {
      expect(parseSmsaApp(app('in-transit').replace('<EDD>10/14/2026</EDD>', estimate), TRANSIT).expected_delivery, estimate).toBeNull();
    }
    const odd = parseSmsaApp(app('delivered').replace('<ShipmentWeight>12.5</ShipmentWeight>', '<ShipmentWeight>12,5 KG</ShipmentWeight>')
      .replace('<ShipmentDestCountry>SA</ShipmentDestCountry>', '<ShipmentDestCountry>Saudi</ShipmentDestCountry>'), DELIVERED);
    expect(odd).not.toHaveProperty('weight_kg');
    expect(odd).not.toHaveProperty('destination_country');
  });

  it('keeps a scan without an office or a readable code, sorts by time, and leaves new wording to the shared rules or without a stage', () => {
    const bare = parseSmsaApp(app('in-transit').replace('<a:Office>Example Town</a:Office>', '<a:Office/>')
      .replace('<a:StatusCode>DEX03-1</a:StatusCode>', '<a:StatusCode>DEX 03/1</a:StatusCode>'), TRANSIT);
    expect(bare.events![0]).toEqual({ time: '2026-10-12T13:15:22Z', description: 'Attempted Delivery - Consignee No Response',
      stage: 'failed_attempt', stage_source: 'carrier_map' });
    const late = app('in-transit').match(appScan('2026-10-12T13:15:22\\+00:00'))![0];
    const shuffled = parseSmsaApp(app('in-transit').replace(late, '').replace('</TrackingDetailsList>', `${late}\n  </TrackingDetailsList>`), TRANSIT);
    expect(shuffled.events).toEqual(parseSmsaApp(app('in-transit'), TRANSIT).events);
    const unknown = parseSmsaApp(app('in-transit').replace('<a:EventDesc>Attempted Delivery - Consignee No Response</a:EventDesc>',
      '<a:EventDesc>Synthetic Notice</a:EventDesc>'), TRANSIT);
    expect(unknown).toMatchObject({ last_status_text: 'Synthetic Notice', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    expect(unknown.events![0]).toEqual({ time: '2026-10-12T13:15:22Z', description: 'Synthetic Notice', location: 'Example Town', provider_code: 'DEX03-1' });
    const shared = parseSmsaApp(app('in-transit').replace('<a:EventDesc>Attempted Delivery - Consignee No Response</a:EventDesc>',
      '<a:EventDesc>Shipment returned to shipper</a:EventDesc>'), TRANSIT);
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
  });

  it('binds the reply to the requested airway bill and rejects replies it cannot read', () => {
    expect(() => parseSmsaApp(app('delivered'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SMSA answered for another airway bill' }));
    const delivered = app('delivered');
    for (const body of [
      delivered.replace(`<AirWaybill>${DELIVERED}</AirWaybill>`, '<AirWaybill/>'),
      delivered.replace(`<AirWaybill>${DELIVERED}</AirWaybill>`, `<AirWaybill>${DELIVERED}</AirWaybill><AirWaybill>${DELIVERED}</AirWaybill>`),
      delivered.replace(/<ShipmentDetails>[\s\S]*<\/ShipmentDetails>/, '<ShipmentDetails i:nil="true"/>'),
      delivered.replace('<a:EventTime>2026-10-05T06:06:00+00:00</a:EventTime>', '<a:EventTime>2026-10-05T06:06:00</a:EventTime>'),
      delivered.replace('<a:EventTime>2026-10-05T06:06:00+00:00</a:EventTime>', '<a:EventTime i:nil="true"/>'),
      delivered.replace('<a:EventDesc>Out for Delivery</a:EventDesc>', '<a:EventDesc> </a:EventDesc>'),
      delivered.replace('<a:EventDesc>Out for Delivery</a:EventDesc>', ''),
      delivered.replace('<a:TrackingDetails>', '<a:Notice/><a:TrackingDetails>'),
      delivered.replace(/<TrackingDetailsList[\s\S]*<\/TrackingDetailsList>/, ''),
      delivered.replaceAll('http://smsaexpress.com/track/', 'http://example.com/track/'),
      delivered.replace('</s:Envelope>', ''),
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "a">]><x>&a;</x>',
      '<html><head><title>SMSA Express</title></head><body><p>Service</p></body></html>']) {
      expect(() => parseSmsaApp(body, DELIVERED), body.slice(0, 160)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = delivered.replace(appScan('2026-09-29T17:20:00\\+00:00'), (row: string) => row.repeat(301));
    expect(() => parseSmsaApp(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema', message: 'SMSA returned too many scans' }));
    // A known shipment without scans yet is no answer about where it is.
    expect(() => parseSmsaApp(app('in-transit').replace(/<TrackingDetailsList[\s\S]*<\/TrackingDetailsList>/,
      '<TrackingDetailsList xmlns:a="http://schemas.datacontract.org/2004/07/TrackRole"/>'), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads only SMSA’s answers naming the number asked as a missing shipment', () => {
    expect(() => parseSmsaApp(app('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSmsaApp(status(app('not-found'), 'Successfully Done'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSmsaApp(app('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SMSA answered for another airway bill' }));
    const invalid = (number: string) => status(app('not-found'), `Your AirWaybill Number ${number} is not valid SMSA AirWaybill Number.`)
      .replace(/<ShipmentDetails>[\s\S]*<\/ShipmentDetails>/, '<ShipmentDetails i:nil="true"/>');
    expect(() => parseSmsaApp(invalid(UNKNOWN), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSmsaApp(invalid(DELIVERED), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A refused login, a fault or another notice is no answer about the shipment.
    expect(() => parseSmsaApp(status(app('not-found'), 'Username or password is not correct!'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'transport', message: 'SMSA\'s app service refused the app\'s login' }));
    for (const body of [status(app('not-found'), 'Service is busy'), status(app('not-found'), ''), FAULT]) {
      expect(() => parseSmsaApp(body, UNKNOWN), body.slice(0, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const body of [BLOCKED, CLOUDFLARE]) {
      expect(() => parseSmsaApp(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });
});

describe('SMSA Express tracking page', () => {
  it('reads a delivered cross-border history newest first as wall clocks, without the signer, the origin or the repeated scan', () => {
    const result = parseSmsa(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-10-05T11:32:00', expected_delivery: null,
      weight_kg: 12.5, destination_country: 'SA' });
    expect(rows(result)).toEqual([
      ['2026-10-05T11:32:00', 'Delivered', 'Example Town', 'delivered'],
      ['2026-10-05T09:06:00', 'Out for Delivery', 'Example Town', 'out_for_delivery'],
      ['2026-10-04T14:00:00', 'Delivery on Hold - Waiting Customs Info/Invoice Completion', 'Example Town', 'customs'],
      ['2026-10-02T07:45:00', 'Shipment Departed SMSA Sorting Facility', 'Example Town', 'in_transit'],
      ['2026-10-02T07:40:00', 'Shipment Received at SMSA Sorting Facility', 'Example Town', 'in_transit'],
      ['2026-10-01T03:36:00', 'Shipment Arrived at Destination Country - Under clearance process', 'Example Town', 'customs'],
      ['2026-10-01T03:36:00', 'Customs Released', 'Example Town', 'in_transit'],
      ['2026-09-29T20:20:00', 'Shipment On Hold At Customs - Waiting To Complete Payment To Customs', 'Example Town', 'customs'],
      // The border scan the page repeats is kept once.
      ['2026-09-20T14:45:00', 'Shipment departed at the border - In Transit to destination', 'Sample Border GW', 'in_transit'],
      ['2026-09-19T18:14:00', 'Shipment Departed Origin Country', 'Sample City', 'in_transit'],
      ['2026-09-19T12:45:00', 'Shipment Departed SMSA Sorting Facility', 'Sample City', 'in_transit'],
      ['2026-09-19T12:30:00', 'Shipment Received at SMSA Sorting Facility', 'Sample City', 'in_transit'],
      ['2026-09-18T14:05:00', 'Shipment Departed SMSA Origin Facility', 'Sample City', 'in_transit'],
      // Twelve past midnight.
      ['2026-09-18T00:10:00', 'Shipment Picked up from the shipper.', 'Sample City', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Sample Person|Signed|"AE"|, AE|, SA|KG|Picked Up|In Transit"/);
    // The app's reply for the same shipment holds the same scans.
    expect(parseSmsaApp(app('delivered'), DELIVERED).events!.map((event) => event.description)).toEqual(result.events!.map((event) => event.description));
  });

  it('reads a domestic history whose summary is empty, with its estimate and the missed delivery', () => {
    const result = parseSmsa(page('in-transit'), TRANSIT);
    expect(result).toEqual({
      status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Attempted Delivery - Consignee No Response', last_update: null, last_update_local: '2026-10-12T16:15:00',
      expected_delivery: '2026-10-14',
      events: [
        { local_time: '2026-10-12T16:15:00', description: 'Attempted Delivery - Consignee No Response', location: 'Example Town', stage: 'failed_attempt', stage_source: 'carrier_map' },
        { local_time: '2026-10-12T08:50:00', description: 'Out for Delivery', location: 'Example Town', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-10-12T00:10:00', description: 'Arrived Delivery Facility', location: 'Example Town', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-11T21:30:00', description: 'Shipment Departed SMSA Sorting Facility', location: 'Sample Hub', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-11T18:05:00', description: 'Shipment Received at SMSA Sorting Facility', location: 'Sample Hub', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-10T15:20:00', description: 'Shipment Departed SMSA Origin Facility', location: 'Sample Origin', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-10T12:55:00', description: 'Shipment Picked up from the shipper.', location: 'Sample Origin', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // A page without an estimate, or with a summary it cannot read, keeps the scans.
    const bare = parseSmsa(page('in-transit').replace('<p dir="ltr">14-Oct-2026</p>', '<p dir="ltr"></p>'), TRANSIT);
    expect(bare.expected_delivery).toBeNull();
    const odd = parseSmsa(page('delivered').replace('<p>12.5 KG</p>', '<p>12.5 LB</p>').replace('<p>Example Town, SA</p>', '<p>Example Town</p>'), DELIVERED);
    expect(odd).not.toHaveProperty('weight_kg');
    expect(odd).not.toHaveProperty('destination_country');
  });

  it('keeps a scan without a place, and leaves new wording to the shared rules or without a stage', () => {
    const placeless = parseSmsa(page('in-transit').replace(/(<span>04:15 PM<\/span>[\s\S]*?<span>)Example Town(<\/span>)/, '$1$2'), TRANSIT);
    expect(placeless.events![0]).toEqual({ local_time: '2026-10-12T16:15:00', description: 'Attempted Delivery - Consignee No Response',
      stage: 'failed_attempt', stage_source: 'carrier_map' });
    const unknown = parseSmsa(page('in-transit').replace('<h4>Attempted Delivery - Consignee No Response</h4>', '<h4>Synthetic Notice</h4>'), TRANSIT);
    expect(unknown).toMatchObject({ last_status_text: 'Synthetic Notice', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-10-12T16:15:00', description: 'Synthetic Notice', location: 'Example Town' });
    const shared = parseSmsa(page('in-transit').replace('<h4>Attempted Delivery - Consignee No Response</h4>', '<h4>Shipment returned to shipper</h4>'), TRANSIT);
    expect(shared).toMatchObject({ current_stage_source: expect.stringMatching(/^wording:/) });
    expect(shared.events![0]!.stage_source).toMatch(/^wording:/);
  });

  it('takes the signer and phone numbers out of the wording', () => {
    expect(smsaWording('Delivered, Signed by: Sample Person ')).toBe('Delivered');
    expect(smsaWording('Delivered,Signed by:')).toBe('Delivered');
    expect(smsaWording('Delivered signed by SAMPLE')).toBe('Delivered');
    expect(smsaWording('Call the branch on +966 00 000 0000')).toBe('Call the branch on');
    expect(smsaWording('  Shipment Departed SMSA Sorting Facility ')).toBe('Shipment Departed SMSA Sorting Facility');
    expect(smsaWording('Shipment Picked up from the shipper.')).toBe('Shipment Picked up from the shipper.');
  });

  it('binds the page to the requested airway bill and rejects pages it cannot read', () => {
    expect(() => parseSmsa(page('delivered'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SMSA answered for another airway bill' }));
    const delivered = page('delivered');
    for (const html of [
      delivered.replace(`<p>${DELIVERED}</p>`, '<p></p>'),
      delivered.replace(`<p>${DELIVERED}</p>`, `<p>${DELIVERED}</p><p>${DELIVERED}</p>`),
      delivered.replace(`<p>${DELIVERED}</p>`, `<p>${DELIVERED} ${TRANSIT}</p>`),
      delivered.replace('class="tracking-details-container"', 'class="tracking-details-list"'),
      delivered.replace('<h4>05-Oct-2026</h4>', '<h4>2026-10-05</h4>'),
      delivered.replace('<h4>05-Oct-2026</h4>', '<h4>31-Sep-2026</h4>'),
      delivered.replace('<h4>05-Oct-2026</h4>', '<h4>05-Okt-2026</h4>'),
      delivered.replace('<span>11:32 AM</span>', '<span>13:32 PM</span>'),
      delivered.replace('<span>11:32 AM</span>', '<span>00:32 AM</span>'),
      delivered.replace('<span>11:32 AM</span>', '<span>11:60 AM</span>'),
      delivered.replace('<span>11:32 AM</span>', '<span>11:32</span>'),
      delivered.replace('<h4>Out for Delivery</h4>', '<h4> </h4>'),
      delivered.replace('<h4>Out for Delivery</h4>', ''),
      delivered.replace(scan('02:00 PM'), ''),
      '<html><head><title>SMSA Express</title></head><body><form id="awb-tracking-form"></form></body></html>']) {
      expect(() => parseSmsa(html, DELIVERED), html.slice(-120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = delivered.replace(scan('02:00 PM'), (row: string) => row.repeat(301));
    expect(() => parseSmsa(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema', message: 'SMSA returned too many scans' }));
    const $ = load(delivered);
    $('.tracking-details-container').empty();
    expect(() => parseSmsa($.html(), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads only SMSA’s notice naming the number asked as a missing shipment', () => {
    expect(() => parseSmsa(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSmsa(page('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SMSA answered for another airway bill' }));
    // The notice for an empty request names no number, and another notice is no answer about the shipment.
    for (const html of [page('not-found').replace(`#${UNKNOWN} `, ''), page('not-found').replace('This tracking number is not found', 'The service is busy')]) {
      expect(() => parseSmsa(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const html of [BLOCKED, CLOUDFLARE, '<html><head><title>Access Denied</title></head><body>Reference #18.0</body></html>']) {
      expect(() => parseSmsa(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });
});

describe('SMSA Express tracking adapter', () => {
  it('takes twelve digits, without a request otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['20000000001', '2000000000170', 'SMSA20000000', '1Z999AA10123456784', `${'2'.repeat(12)}${' '.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the app’s answer for an unknown number as not found and recognizes a known shipment, without the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(xml(app('delivered'))).mockResolvedValueOnce(xml(app('not-found')))
      .mockResolvedValueOnce(xml(app('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-05T08:32:45.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([url]) => isApp(url))).toBe(true);
  });

  it('asks the page when the app’s service fails, blocks, refuses its login or gives no answer, and records both steps', async () => {
    for (const fromApp of [() => xml('', 404), () => xml(BLOCKED, 403), () => xml('', 500), () => xml('', 400), () => xml(BLOCKED),
      () => xml(status(app('not-found'), 'Username or password is not correct!')), () => xml(FAULT), () => xml('  '),
      () => new Response(null, { status: 302, headers: { Location: 'http://example.com/' } }), () => xml(app('delivered')),
      () => new Response(new Uint8Array(300_000))]) {
      const fetcher = routed(fromApp, () => reply(page('in-transit')));
      const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
      await expect(new SmsaTracker({ fetcher, recorder }).fetch(TRANSIT)).resolves.toMatchObject({ current_stage: 'failed_attempt',
        last_update_local: '2026-10-12T16:15:00' });
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([SMSA_APP_ENDPOINT, `${SMSA_ENDPOINT}?tracknumbers=${TRANSIT}`]);
      expect(recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'direct', outcome: 'ok', fallbackFrom: 'app' }));
    }
  });

  it.each([[429, 'rate_limited'], [503, 'maintenance']] as const)('keeps HTTP %s from the app’s service as %s, without the page', async (code, kind) => {
    const fetcher = routed(() => xml('', code), () => reply(page('delivered')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => isApp(url))).toBe(true);
  });

  it('keeps the app’s malformed reply as a schema change, without the page', async () => {
    const fetcher = routed(() => xml(app('delivered').replace('</s:Envelope>', '')), () => reply(page('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s from the page after the app’s failure as %s', async (code, kind) => {
      const fetcher = routed(() => xml('', 500), () => reply(code === 403 ? BLOCKED : '', code));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

  it('keeps the page’s block served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    for (const body of [BLOCKED, CLOUDFLARE]) {
      const blocked = routed(() => xml('', 500), () => reply(body));
      await expect(carrier(blocked).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    }
    for (const response of [() => new Response(null, { status: 302, headers: { Location: 'https://www.smsaexpress.com/sa' } }),
      () => new Response(null, { status: 301, headers: { Location: 'https://www.smsaexpress.com/' } })]) {
      await expect(carrier(routed(() => xml('', 500), response)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    }
    for (const body of ['', '  ']) {
      await expect(carrier(routed(() => xml('', 500), () => reply(body))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = routed(() => xml('', 500), () => new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
    // The page's not-found notice stands as SMSA's answer.
    await expect(carrier(routed(() => xml('', 500), () => reply(page('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('asks the app’s service once more after a failed connection, then the page, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(xml(app('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url]) => isApp(url))).toEqual([true, true]);
    const down = routed(() => Promise.reject(new TypeError('fetch failed')), () => reply(page('delivered')));
    await expect(carrier(down).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered', last_update_local: '2026-10-05T11:32:00' });
    expect(down.mock.calls.map(([url]) => isApp(url))).toEqual([true, true, false]);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(xml(app('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 40.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(3);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an airway bill to the adapter when the caller names SMSA or pastes its link, which detection never offers', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('smsa-express');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('smsa-express');
    for (const link of [`https://www.smsaexpress.com/sa/trackingdetails?tracknumbers=${DELIVERED}`,
      `https://www.smsaexpress.com/sa/ar/trackingdetails?tracknumbers%5B0%5D=${DELIVERED}`,
      `http://www.smsaexpress.com/Track.aspx?tracknumbers=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'smsa-express', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => xml(app('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'smsa-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'smsa-express', source: 'smsa-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => isApp(url))).toBe(true);
  });
});

describe('SMSA Express status vocabulary', () => {
  it('records every English scan wording the map knows with the stage it gives, whatever its code', () => {
    for (const entry of statuses.entries) {
      // The Arabic wordings come from captures of the Arabic tracker, which the adapter does not read.
      const expected = entry.language === 'en' ? entry.stage : undefined;
      const code = 'code' in entry ? entry.code ?? null : null;
      expect(smsaScanStage(entry.wording), entry.wording).toBe(expected);
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(expected);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(expected);
    }
    expect(smsaScanStage('  OUT  FOR DELIVERY ')).toBe('out_for_delivery');
    expect(smsaStage('Shipment Picked up from the shipper')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(smsaStage('Synthetic Notice')).toBeNull();
    for (const wording of ['constructor', 'Delivered, Signed by:', 'Out for Delivery today']) {
      expect(smsaScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('DL', 'synthetic notice')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'smsa-express', description: 'Customs Released' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'smsa-express', providerCode: 'CR', description: 'Customs Released' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});

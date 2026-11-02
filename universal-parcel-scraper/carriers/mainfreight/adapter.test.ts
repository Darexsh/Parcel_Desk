import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import {
  adapter, CONSIGNMENT_SERVICES, MAINFREIGHT_API, MAINFREIGHT_APP_API, MainfreightTracker, mainfreightSearchUrl, mainfreightShipmentUrl,
} from './adapter.js';
import { listedJobs, masterBillsOf, normalizeMainfreightNumber, parseMainfreight, searchedShipment } from './parser.js';
import { mainfreightMappedStage, mainfreightStage, placedWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const JOB = 'S09990001';
const TRANSIT_JOB = 'S09990003';
const CONSIGNMENT = '99900000014';
const SENDER_REFERENCE = 'ZZT0000001';
const US = '99900000028';
const EU = '99900000035';
const CONTAINER = 'CJ999000001';
const UNKNOWN = 'S09990009';
const MASTER_BILL = '00012345675';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Row = { status: unknown; additionalDetails: { value: unknown }[] };
type Shipment = Record<string, unknown> & { timelineDetails: Row[]; details: { items: { label: string; value: unknown }[] }[] };
const fixture = (name: string): Shipment[] => JSON.parse(text(`${name}.json`)) as Shipment[];
const edited = (name: string, change: (shipment: Shipment, reply: Shipment[]) => void): Shipment[] => {
  const reply = fixture(name);
  change(reply[0]!, reply);
  return reply;
};
type AppDocument = Record<string, unknown> & { references: Record<string, unknown>[] };
type AppReply = Record<string, unknown> & { document: { document: AppDocument } };
/** The app's reply for the air job, changed. */
const appReply = (change: (document: AppDocument, reply: AppReply) => void = () => {}): AppReply => {
  const reply = JSON.parse(text('app-job.json')) as AppReply;
  change(reply.document.document, reply);
  return reply;
};
const at = (code: string, reference: string) => ({ code, reference });
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const listing = (url: string, reference: string) => JSON.stringify([{ reference, url, status: 'In Transit', statusDateUtc: '2026-05-11T20:41:00', journey: 'SAMPLETOWN to EXAMPLE HILL',
  hero: { status: 'In Transit', colour: 'grey', icon: 'icon-status in-transit' } }]);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A transport that answers each address from a table, and an empty list for any other. */
const routed = (routes: Record<string, string>) => vi.fn<typeof fetch>().mockImplementation(async (url) => reply(routes[String(url)] ?? '[]'));

describe('Mainfreight tracking adapter', () => {
  it('searches as the tracking page does, then opens the shipment it lists, through the supplied transport', async () => {
    const fetcher = routed({ [mainfreightSearchUrl(JOB)]: text('search-job.json'), [mainfreightShipmentUrl(at('CW', JOB))]: text('job-delivered.json') });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MainfreightTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' s0999 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${MAINFREIGHT_API}?reference=${JOB}`, `${MAINFREIGHT_API}/CW/${JOB}?lang=en-NZ`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mainfreight', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an ocean job by each milestone’s wall clock, keeping a repeated one once', () => {
    const result = parseMainfreight(fixture('job-delivered'), at('CW', JOB), JOB)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Cargo Delivered',
      last_update: null, last_update_local: '2026-03-05T10:15:00', expected_delivery: null, weight_kg: 1200 });
    expect(result.events!.map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-03-05T10:15:00', 'Cargo Delivered', 'delivered'],
      ['2026-03-02T14:30:00', 'Cargo Available', 'in_transit'],
      ['2026-03-02T11:05:00', 'Customs Clearance Finalised', 'in_transit'],
      ['2026-03-01T09:40:00', 'Customs Clearance Commenced', 'customs'],
      ['2026-02-28T06:20:00', 'Arrival at Final Discharge Port', 'in_transit'],
      ['2026-02-09', 'Departure from First Load Port', 'in_transit'],
      ['2026-02-05T16:12:00', 'Origin Customs Cleared', 'in_transit'],
      ['2026-02-04T13:19:00', 'Pick up Cartage Complete', 'accepted'],
      ['2026-01-30T09:49:00', 'Pickup Cartage Advised', 'registered'],
      ['2026-01-30T09:50:00', 'Booking Confirmation Sent', 'registered'],
    ]);
    // A port's clock has no zone in the reply.
    expect(result.events!.every(event => event.time === undefined && event.location === undefined)).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|ZZHBL|example\.com|Sampleport|Exampleton/);
  });

  it('leaves out a milestone still estimated, and keeps the estimated delivery day of a job on its way', async () => {
    const fetcher = routed({ [mainfreightSearchUrl(TRANSIT_JOB)]: listing(`CW/${TRANSIT_JOB}`, 'ZZHBL9990003'),
      [mainfreightShipmentUrl(at('CW', TRANSIT_JOB))]: text('job-in-transit.json') });
    const result = await carrier(fetcher).track({ number: TRANSIT_JOB });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departure from First Load Port',
      last_update_local: '2026-04-08T23:30:00', expected_delivery: '2026-04-14', weight_kg: 85.5 });
    expect(result.events!.map(event => [event.local_time, event.description])).toEqual([
      ['2026-04-08T23:30:00', 'Departure from First Load Port'], ['2026-04-06', 'Pick up Cartage Complete'], ['2026-04-02T15:05:00', 'Booking Confirmation Sent'],
    ]);
  });

  it('finds a consignment by the sender’s reference, with each scan’s instant from the zone it names', async () => {
    const fetcher = routed({ [mainfreightSearchUrl(SENDER_REFERENCE)]: listing(`MSAUS/${CONSIGNMENT}`, SENDER_REFERENCE),
      [mainfreightShipmentUrl(at('MSAUS', CONSIGNMENT))]: text('consignment-in-transit.json') });
    const result = await carrier(fetcher).track({ number: SENDER_REFERENCE });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'At Delivery Depot',
      last_update: '2026-05-12T06:41:00+10:00', expected_delivery: null, weight_kg: 42, canonical_tracking_number: CONSIGNMENT });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-05-12T06:41:00+10:00', 'EXAMPLE HILL', 'At Delivery Depot', 'in_transit'],
      // A leg is no place.
      ['2026-05-11T19:00:00+10:00', undefined, 'In Transit', 'in_transit'],
      ['2026-05-11T17:30:00+10:00', undefined, 'In Transit', 'in_transit'],
      ['2026-05-11T14:34:00+10:00', 'SAMPLETOWN', 'Picked Up', 'accepted'],
      ['2026-05-11T11:50:00+10:00', undefined, 'Pickup Allocated to Driver', 'registered'],
      ['2026-05-11T11:13:00+10:00', undefined, 'Information Received', 'registered'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/example\.com|\+61|Sample Street|Example Road|Branch|SYNTHETIC|M<sup>/);
  });

  it('opens an eleven-digit consignment the search does not find under each transport service at once', async () => {
    const fetcher = routed({ [mainfreightShipmentUrl(at('MSAUS', CONSIGNMENT))]: text('consignment-in-transit.json') });
    await expect(carrier(fetcher).track({ number: CONSIGNMENT })).resolves.toMatchObject({ current_stage: 'in_transit', events: { length: 6 } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      mainfreightSearchUrl(CONSIGNMENT), ...CONSIGNMENT_SERVICES.map(code => mainfreightShipmentUrl(at(code, CONSIGNMENT))),
    ]);
    const result = await carrier(fetcher).track({ number: CONSIGNMENT });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    const both = routed({ [mainfreightShipmentUrl(at('MSAUS', CONSIGNMENT))]: text('consignment-in-transit.json'),
      [mainfreightShipmentUrl(at('MSNZS', CONSIGNMENT))]: text('consignment-in-transit.json').replaceAll('MSAUS', 'MSNZS') });
    await expect(carrier(both).track({ number: CONSIGNMENT })).rejects.toMatchObject({ kind: 'indeterminate' });
    const failing = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('MSUSS') ? reply('', 500, 'text/plain') : reply('[]'));
    await expect(carrier(failing).track({ number: CONSIGNMENT })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('takes the place and ZIP code out of an American scan’s wording, with Central and Pacific clocks', () => {
    const result = parseMainfreight(fixture('consignment-delivered-us'), at('MSUSS', US), US)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Goods delivered',
      last_update: '2026-01-16T10:30:00-08:00', delivered_at: '2026-01-16T10:30:00-08:00', service_name: 'LTL', destination_country: 'US' });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-01-16T10:30:00-08:00', 'EXAMPLE CITY, CALIFORNIA', 'Goods delivered', 'delivered'],
      ['2026-01-16T08:00:00-08:00', 'EXAMPLE CITY, CALIFORNIA', 'On drivers vehicle en-route', 'out_for_delivery'],
      ['2026-01-15T21:15:00-08:00', 'SAMPLE JUNCTION, CALIFORNIA', 'Arrived at Terminal', 'in_transit'],
      ['2026-01-12T14:33:00-06:00', 'SAMPLEVILLE, TEXAS', 'Departed from Terminal', 'in_transit'],
      ['2026-01-12T08:00:00-06:00', 'SAMPLEVILLE, TEXAS', 'Goods picked up', 'accepted'],
      ['2026-01-11T16:10:00-06:00', undefined, 'Pickup assigned to driver', 'registered'],
      ['2026-01-11T14:28:00-06:00', undefined, 'Booked', 'registered'],
    ]);
    // Neither postcode, nor the chargeable weight without its unit.
    expect(JSON.stringify(result)).not.toMatch(/0000[01]|1500|weight_kg/);
  });

  it('reads a European consignment on wall clocks, with its rescheduled arrival day, service and destination', () => {
    const result = parseMainfreight(fixture('shipment-eu'), at('MM', EU), EU)!;
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipment loaded into line haul truck',
      last_update: null, last_update_local: '2026-06-02T10:45:00', expected_delivery: '2026-06-04', weight_kg: 310.5, service_name: 'Standard',
      destination_country: 'DE' });
    expect(result.events!.map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-06-02T10:45:00', 'Shipment loaded into line haul truck', 'in_transit'], ['2026-06-01T17:52:00', 'Order received', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample reason/);
  });

  it('reads a container job’s legs as moves until its final delivery', () => {
    const result = parseMainfreight(fixture('container-job'), at('MSNZCJ', CONTAINER), CONTAINER)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', weight_kg: 2400, last_update_local: '2026-07-16T13:43:00' });
    expect(result.events!.map(event => [event.local_time, event.location, event.stage])).toEqual([
      ['2026-07-16T13:43:00', 'EXAMPLE PARK, AUCKLAND', 'delivered'],
      ['2026-07-16T12:05:00', 'SAMPLE BAY, AUCKLAND', 'in_transit'],
      ['2026-07-16', undefined, 'in_transit'],
      ['2026-07-15T16:20:00', 'SAMPLE BAY, AUCKLAND', 'in_transit'],
      ['2026-07-15T13:41:00', undefined, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ZZZU/);
  });

  it('reads a status without scans as a summary, and a shipment with neither as no history', () => {
    const summary = parseMainfreight(edited('job-in-transit', shipment => { shipment.timelineDetails = []; }), at('CW', TRANSIT_JOB), TRANSIT_JOB)!;
    expect(summary).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departed Origin', summary_only: true, events: [] });
    const estimated = parseMainfreight(edited('job-in-transit', shipment => { shipment.timelineDetails = shipment.timelineDetails.slice(0, 1); }),
      at('CW', TRANSIT_JOB), TRANSIT_JOB)!;
    expect(estimated).toMatchObject({ summary_only: true, events: [] });
    expect(() => parseMainfreight(fixture('declaration'), at('CWID', 'B09990002'), 'B09990002'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const unknown = parseMainfreight(edited('consignment-in-transit', shipment => { shipment.timelineDetails[0]!.status = 'Sample milestone'; }),
      at('MSAUS', CONSIGNMENT), CONSIGNMENT)!;
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample milestone' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    const offset = parseMainfreight(edited('consignment-in-transit', shipment => {
      shipment.timelineDetails[0]!.additionalDetails[0]!.value = '12 May 2026, 6:41 AM SMPL';
    }), at('MSAUS', CONSIGNMENT), CONSIGNMENT)!;
    // A zone the adapter does not know leaves the wall clock.
    expect(offset.events![0]).toMatchObject({ local_time: '2026-05-12T06:41:00' });
    expect(offset.events![0]).not.toHaveProperty('time');
  });

  it('reads an empty search as not found, without asking the transport services about a number that is not a consignment', async () => {
    const fetcher = routed({});
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier(fetcher).track({ number: CONSIGNMENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(5);
    // The search also matches other fields: an entry under another number is not this shipment.
    const other = routed({ [mainfreightSearchUrl(UNKNOWN)]: listing('CWID/B09990002', 'SAMPLEORDER') });
    await expect(carrier(other).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('binds the search to the whole number, preferring Mainfreight’s own number to a reference', () => {
    const entries = (...pairs: [string, string][]) => pairs.map(([url, reference]) => ({ url, reference, status: 'Delivered' }));
    expect(searchedShipment(JSON.parse(text('search-job.json')), JOB)).toEqual(at('CW', JOB));
    expect(searchedShipment(JSON.parse(text('search-job.json')), 'ZZHBL9990001')).toEqual(at('CW', JOB));
    expect(searchedShipment(entries([`cw/${JOB.toLowerCase()}`, 'X']), JOB)).toEqual(at('CW', JOB));
    expect(searchedShipment(entries(['MSNZS/99900000042', JOB], [`CW/${JOB}`, 'ZZHBL9990001']), JOB)).toEqual(at('CW', JOB));
    expect(searchedShipment(entries(['MSNZS/99900000042', 'zzt-000-0001']), SENDER_REFERENCE)).toEqual(at('MSNZS', '99900000042'));
    expect(searchedShipment(entries(['CW/S0999000', JOB.slice(0, -1)], ['CW/S099900011', 'X']), JOB)).toBeNull();
    expect(searchedShipment([], JOB)).toBeNull();
    expect(() => searchedShipment(entries(['MSNZS/99900000042', SENDER_REFERENCE], ['MSAUS/99900000059', SENDER_REFERENCE]), SENDER_REFERENCE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(searchedShipment(entries([`CW/${JOB}`, 'A'], [`CW/${JOB}`, 'B']), JOB)).toEqual(at('CW', JOB));
    for (const payload of [null, {}, 'list', [null], [{ reference: JOB }], [{ url: 7 }], entries([`CW/${JOB}/X`, JOB]), entries([`C/${JOB}`, JOB]),
      Array.from({ length: 501 }, () => ({ url: 'CW/S00000000' }))]) {
      expect(() => searchedShipment(payload, JOB), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the shipment to the address it was asked for and rejects changed replies', () => {
    expect(parseMainfreight([], at('CW', JOB), JOB)).toBeNull();
    expect(() => parseMainfreight(fixture('job-delivered'), at('CW', 'S09990002'), 'S09990002'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Mainfreight answered for a different shipment' }));
    expect(() => parseMainfreight(fixture('job-delivered'), at('CWID', JOB), JOB)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseMainfreight(edited('job-delivered', shipment => { shipment.fullReference = ` ${JOB.toLowerCase()} `; }), at('CW', JOB), JOB)!.events)
      .toHaveLength(10);
    const row = (shipment: Shipment) => shipment.timelineDetails[2]!;
    for (const payload of [null, {}, [null], [7],
      edited('job-delivered', (shipment, all) => { all.push(shipment); }),
      edited('job-delivered', shipment => { delete shipment.fullReference; }),
      edited('job-delivered', shipment => { shipment.shortCode = 7; }),
      edited('job-delivered', shipment => { shipment.timelineDetails = 'rows' as never; }),
      edited('job-delivered', shipment => { shipment.timelineDetails = Array.from({ length: 501 }, () => row(shipment)); }),
      edited('job-delivered', shipment => { shipment.status = ['Delivered']; }),
      edited('job-delivered', shipment => { shipment.details = {} as never; }),
      edited('job-delivered', shipment => { shipment.details[0]!.items = null as never; }),
      edited('job-delivered', shipment => { shipment.details[0]!.items[0]!.value = { value: 'x' }; }),
      edited('job-delivered', shipment => { (shipment.timelineDetails as unknown[])[2] = 'row'; }),
      edited('job-delivered', shipment => { row(shipment).status = ' '; }),
      edited('job-delivered', shipment => { row(shipment).status = 7; }),
      edited('job-delivered', shipment => { row(shipment).additionalDetails = null as never; }),
      edited('job-delivered', shipment => { row(shipment).additionalDetails = []; }),
      edited('job-delivered', shipment => { row(shipment).additionalDetails[0] = 'x' as never; }),
      edited('job-delivered', shipment => { row(shipment).additionalDetails[1]!.value = '02/03/2026'; }),
      edited('job-delivered', shipment => { row(shipment).additionalDetails[1]!.value = '30 February 2026'; }),
      edited('job-delivered', shipment => { row(shipment).additionalDetails[0]!.value = '14:30 PM'; }),
      edited('job-delivered', shipment => { row(shipment).additionalDetails[0]!.value = 7; }),
      edited('consignment-in-transit', shipment => { shipment.timelineDetails[0]!.additionalDetails[0]!.value = '12 Sample 2026, 6:41 AM AEST'; }),
      edited('consignment-in-transit', shipment => { shipment.timelineDetails[0]!.additionalDetails[0]!.value = '12 May 2026 6:41 AM AEST'; })]) {
      const shipment = Array.isArray(payload) && payload[0] && typeof payload[0] === 'object' ? payload[0] as Shipment : null;
      const reference = String(shipment?.fullReference ?? JOB).trim();
      const code = typeof shipment?.shortCode === 'string' ? shipment.shortCode : 'CW';
      expect(() => parseMainfreight(payload, at(code, reference), reference), JSON.stringify(payload).slice(0, 120))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a search listing a shipment the tracker does not open as inconclusive', async () => {
    const fetcher = routed({ [mainfreightSearchUrl(JOB)]: text('search-job.json') });
    await expect(carrier(fetcher).track({ number: JOB })).rejects.toMatchObject({ kind: 'indeterminate' });
    const several = routed({ [mainfreightSearchUrl(SENDER_REFERENCE)]: JSON.stringify([
      { url: 'MSNZS/99900000042', reference: SENDER_REFERENCE }, { url: 'MSAUS/99900000059', reference: SENDER_REFERENCE }]) });
    await expect(carrier(several).track({ number: SENDER_REFERENCE })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(several).toHaveBeenCalledTimes(1);
  });

  it('finds an air and ocean job by its master bill once Mainfreight’s app names it the job’s', async () => {
    const fetcher = routed({ [mainfreightSearchUrl(MASTER_BILL)]: listing(`CW/${TRANSIT_JOB}`, 'ZZHBL9990003'),
      [MAINFREIGHT_APP_API]: text('app-job.json'), [mainfreightShipmentUrl(at('CW', TRANSIT_JOB))]: text('job-in-transit.json') });
    const result = await carrier(fetcher).track({ number: '000-1234 5675' });
    expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Departure from First Load Port', last_update_local: '2026-04-08T23:30:00',
      canonical_tracking_number: TRANSIT_JOB });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      mainfreightSearchUrl(MASTER_BILL), MAINFREIGHT_APP_API, mainfreightShipmentUrl(at('CW', TRANSIT_JOB)),
    ]);
    const [, init] = fetcher.mock.calls[1]!;
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(init!.body))).toEqual({ permalink: 'CW', reference: TRANSIT_JOB, brand: 'MFT' });
    expect(JSON.stringify(result)).not.toMatch(/ZZZU|SAMPLE\.ORDER|SYNTHETIC|Sampleport/);
    await expect(carrier(fetcher).recognize!(MASTER_BILL)).resolves.toMatchObject({ known: true });
  });

  it('takes a job the search lists for a master bill only when the app names that bill, and one job alone', async () => {
    const pages = (app: unknown) => routed({ [mainfreightSearchUrl(MASTER_BILL)]: listing(`CW/${TRANSIT_JOB}`, 'ZZHBL9990003'),
      [MAINFREIGHT_APP_API]: JSON.stringify(app), [mainfreightShipmentUrl(at('CW', TRANSIT_JOB))]: text('job-in-transit.json') });
    // Another master bill: the job is not this number's, which the transport services may still know.
    const other = pages(appReply((document) => { document.references[5]!.reference = '00012345686'; }));
    await expect(carrier(other).track({ number: MASTER_BILL })).rejects.toMatchObject({ kind: 'not_found' });
    expect(other.mock.calls.map(([url]) => String(url))).toEqual([
      mainfreightSearchUrl(MASTER_BILL), MAINFREIGHT_APP_API, ...CONSIGNMENT_SERVICES.map(code => mainfreightShipmentUrl(at(code, MASTER_BILL))),
    ]);
    const unopened = pages({ document: { document: null, resultDocument: null, podUrl: '' }, success: false,
      message: 'Sorry, we couldn’t find that one...', podUrl: '' });
    await expect(carrier(unopened).track({ number: MASTER_BILL })).rejects.toMatchObject({ kind: 'indeterminate' });
    const elsewhere = pages(appReply((document) => { document.primaryReference = 'S09990001'; }));
    await expect(carrier(elsewhere).track({ number: MASTER_BILL })).rejects.toMatchObject({ kind: 'schema' });
    for (const [status, kind] of [[429, 'rate_limited'], [403, 'challenge'], [404, 'transport']] as const) {
      const failing = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === MAINFREIGHT_APP_API ? reply('', status)
        : reply(listing(`CW/${TRANSIT_JOB}`, 'ZZHBL9990003')));
      await expect(carrier(failing).track({ number: MASTER_BILL }), String(status)).rejects.toMatchObject({ kind });
    }
    const blocked = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === MAINFREIGHT_APP_API ? reply(text('block.html'), 200, 'text/html')
      : reply(listing(`CW/${TRANSIT_JOB}`, 'ZZHBL9990003')));
    await expect(carrier(blocked).track({ number: MASTER_BILL })).rejects.toMatchObject({ kind: 'challenge' });
    // A consolidation lists each of its jobs under the one master bill.
    const consolidation = routed({ [mainfreightSearchUrl(MASTER_BILL)]: JSON.stringify([
      { url: `CW/${TRANSIT_JOB}`, reference: 'ZZHBL9990003' }, { url: 'CW/S09990004', reference: 'ZZHBL9990004' }, { url: 'CWID/B09990005', reference: 'X' }]) });
    await expect(carrier(consolidation).track({ number: MASTER_BILL })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(consolidation).toHaveBeenCalledTimes(1);
  });

  it('reads the master bills in the app’s reply, bound to the job it was asked for', () => {
    const job = at('CW', TRANSIT_JOB);
    expect(masterBillsOf(appReply(), job)).toEqual([MASTER_BILL]);
    expect(masterBillsOf(appReply((document) => { document.references.pop(); }), job)).toEqual([]);
    expect(masterBillsOf(appReply((document) => { document.references[5]!.reference = ' 000-12345675 '; }), job)).toEqual([MASTER_BILL]);
    // Only the master bill is read: the other references can be anything.
    expect(masterBillsOf(appReply((document) => { document.references[4]!.reference = null; }), job)).toEqual([MASTER_BILL]);
    expect(masterBillsOf({ success: false, document: { document: null } }, job)).toBeNull();
    expect(listedJobs([{ url: `CW/${TRANSIT_JOB}` }, { url: `cw/${TRANSIT_JOB.toLowerCase()}` }, { url: 'CWID/B09990005' }, { url: 'MSNZS/99900000042' }]))
      .toEqual([job]);
    for (const payload of [null, [], {}, { success: 'true' }, appReply((_, reply) => { reply.document = null as never; }),
      appReply((document) => { document.references = {} as never; }),
      appReply((document) => { document.references = Array.from({ length: 501 }, () => ({ type: 'OrderReference' })); }),
      appReply((document) => { document.references[5] = 'x' as never; }), appReply((document) => { document.references[5]!.type = 7; }),
      appReply((document) => { document.references[5]!.reference = 7; }), appReply((document) => { document.shortCode = 'CWID'; }),
      appReply((document) => { document.primaryReference = 'S09990004'; }), appReply((document) => { delete document.primaryReference; })]) {
      expect(() => masterBillsOf(payload, job), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a firewall page as a challenge, and other replies that are not the API’s as inconclusive or changed', async () => {
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: JOB });
    await expect(lookup(text('block.html'), 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(text('block.html'), 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('{"Message":"An error has occurred."}')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('﻿[]')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(carrier(fetcher).track({ number: JOB })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    await expect(carrier(fetcher).recognize!(JOB)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('[]', status));
      await expect(carrier(fetcher).track({ number: JOB })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(JOB)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const pages = { [mainfreightSearchUrl(JOB)]: text('search-job.json'), [mainfreightShipmentUrl(at('CW', JOB))]: text('job-delivered.json') };
    let failed = false;
    const flaky = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes('lang=') && !failed) {
        failed = true;
        throw new TypeError('fetch failed');
      }
      return reply(pages[String(url)] ?? '[]');
    });
    await expect(carrier(flaky).track({ number: JOB })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(4);
    const immediate = routed(pages);
    await expect(carrier(immediate).track({ number: JOB }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: JOB }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: JOB }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: JOB })).rejects.toThrow('unexpectedly large');
  });

  it('takes four to forty letters and digits, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['S09', 'ZZ_0000001', 'ZZ/0000001', `S${'0'.repeat(40)}`, 'ÅÄÖ00001', `S${' '.repeat(90)}1`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMainfreightNumber(' zzt-000.0001 ')).toBe(SENDER_REFERENCE);
  });

  it('recognizes a known shipment and an unknown number from plain HTTP', async () => {
    const fetcher = routed({ [mainfreightShipmentUrl(at('MSAUS', CONSIGNMENT))]: text('consignment-in-transit.json') });
    await expect(carrier(fetcher).recognize!(CONSIGNMENT)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-11T20:41:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('routes a shipment filed under Mainfreight to the adapter, and reads its tracking links', async () => {
    const fetcher = routed({ [mainfreightSearchUrl(JOB)]: text('search-job.json'), [mainfreightShipmentUrl(at('CW', JOB))]: text('job-delivered.json') });
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: JOB, carrier: 'mainfreight' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'mainfreight', source: 'mainfreight', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(MAINFREIGHT_API))).toBe(true);
    for (const [link, number] of [[`https://www.mainfreight.com/track/MSAUS/${CONSIGNMENT}`, CONSIGNMENT], [`https://www.mainfreight.com/track/CW/${JOB}?lang=en`, JOB],
      [`https://www.mainfreight.com/tracking?trackingnumber=${SENDER_REFERENCE}`, SENDER_REFERENCE]] as const) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: number, carrier: 'mainfreight', source: 'link' });
    }
  });
});

describe('Mainfreight numbers', () => {
  it('suggests eleven digits and is asked about them only for a lookup in New Zealand, Australia or the United States', () => {
    expect(detectCarrierMatch(CONSIGNMENT)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(CONSIGNMENT).candidates).toContain('mainfreight');
    for (const countryHint of ['NZ', 'AU', 'US']) {
      expect(recognitionAskedCarriers(CONSIGNMENT, { countryHint })[0], countryHint).toBe('mainfreight');
    }
    // In Europe GLS prints the same eleven digits.
    for (const countryHint of [undefined, 'DE', 'FR', 'CO', 'RO']) {
      expect(recognitionAskedCarriers(CONSIGNMENT, { countryHint }), `${countryHint}`).not.toContain('mainfreight');
    }
    for (const other of [JOB, CONTAINER, SENDER_REFERENCE, `${CONSIGNMENT}0`]) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('mainfreight');
    }
  });
});

describe('Mainfreight status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and leaves the expected step without one', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(mainfreightStage(entry.wording)?.stage, entry.wording).toBe(stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'mainfreight', description: entry.wording }), entry.wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(mainfreightMappedStage(' cargo  delivered ')).toBe('delivered');
    for (const wording of ['constructor', 'toString', 'Deliver (Site Movement) (Sample)', 'Sample (Site Movement)']) {
      expect(mainfreightMappedStage(wording), wording).toBeUndefined();
    }
    expect(mainfreightMappedStage('Final Delivery (Sample Leg)')).toBe('delivered');
    expect(mainfreightMappedStage('Picked Up (Sample Leg)')).toBe('in_transit');
  });

  it('takes the place out of the wordings that name one', () => {
    expect(placedWording('Goods delivered to SAMPLE CITY, CALIFORNIA, 00001-0002')).toEqual({ wording: 'Goods delivered', place: 'SAMPLE CITY, CALIFORNIA' });
    expect(placedWording('Departed from Terminal SAMPLE CITY, TEXAS')).toEqual({ wording: 'Departed from Terminal', place: 'SAMPLE CITY, TEXAS' });
    expect(placedWording('Sample milestone at SAMPLE CITY, 00001')).toEqual({ wording: 'Sample milestone at SAMPLE CITY' });
    expect(placedWording('Delivered')).toEqual({ wording: 'Delivered' });
  });
});

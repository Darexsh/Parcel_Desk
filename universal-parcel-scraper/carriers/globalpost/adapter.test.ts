import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GLOBALPOST_TRACK_DETAIL, GlobalpostTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeGlobalpostNumber, parseGlobalpost } from './parser.js';
import { globalpostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'GPSIZZ9900000017US';
const IN_TRANSIT = 'GPPIZZ9900000025US';
const UNKNOWN = 'GPEIZZ9900000033US';
const RETURNED = 'GPPIZZ9900000041US';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, from: string | RegExp, to: string) => {
  const html = fixture(name);
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The ${name} fixture has no ${String(from)}`);
  return next;
};
// The fixture with each place replaced wherever it appears.
const placed = (name: string, places: Record<string, string>) => Object.entries(places).reduce((html, [from, to]) => {
  if (!html.includes(from)) throw new Error(`The ${name} fixture has no ${from}`);
  return html.replaceAll(from, to);
}, fixture(name));
// The page as it read on a day, without the later days' scans.
const asOf = (html: string, day: string) => {
  const first = html.indexOf('<div class="trackingEvents-day-wrapper">');
  const start = html.lastIndexOf('<div class="trackingEvents-day-wrapper">', html.indexOf(`</strong>, ${day}</div>`));
  if (first < 0 || start < first) throw new Error(`The page has no ${day}`);
  return html.slice(0, first) + html.slice(start);
};
// The in-transit parcel with its USPS scans at towns of Illinois.
const illinois = () => placed('in-transit', { 'SAMPLE IL': 'CHICAGO IL', 'SAMPLE STREAM,IL': 'CAROL STREAM,IL', 'SAMPLETOWN,IL': 'CHICAGO,IL' });
const clocks = (result: ReturnType<typeof parseGlobalpost>) => result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null]);
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
const pageFor = (number: string) => `${GLOBALPOST_TRACK_DETAIL}?t=${number}`;
const notFoundFor = (number: string) => `https://www.goglobalpost.com/tracking/?t=${number}&status=not_found`;
const partner = (name: string, href: string, number: string) => changed('in-transit', /<span class="finalMileTrackingCarrier">Canada Post<\/span>[\s\S]*?<\/a>/,
  `<span class="finalMileTrackingCarrier">${name}</span></div><div class="finalMileTrackingNumber"><div id='${IN_TRANSIT}-finalMile-tracking-id'><a target="_blank" href="${href}">${number}</a>`);

describe('GlobalPost HTTP adapter', () => {
  it('opens the tracking page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GlobalpostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' gppizz 9900-000025 us ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(pageFor(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'globalpost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first and hands it to Royal Mail', () => {
    const result = parseGlobalpost(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-06T11:36:00', expected_delivery: null,
      service_name: 'GlobalPost Standard', destination_country: 'GB', delivery_carrier: 'royal-mail', delivery_tracking_number: 'ZZ123456785GB' });
    // The delivery abroad keeps its wall clock, so no delivery time comes from an earlier scan's.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null, event.stage])).toEqual([
      // The delivering post's scans come without a place.
      ['2026-03-06T11:36:00', 'Delivered', null, 'delivered'],
      ['2026-03-06T08:57:00', 'Out for Delivery', null, 'out_for_delivery'],
      ['2026-03-05T17:11:00', 'In Transit', null, 'in_transit'],
      // "Not Available" is no place.
      ['2026-03-04T20:59:00', 'Arrived in Destination Country', null, 'in_transit'],
      // Twelve past midnight, at a processing center on California's clock.
      ['2026-02-27T00:05:00-08:00', 'Departed GlobalPost Facility', 'Sampleton CA', 'in_transit'],
      // The repeated scan is kept once.
      ['2026-02-26T12:04:00-08:00', 'Arrived at GlobalPost Facility', 'Sampleton CA', 'accepted'],
      // The shipper's ZIP code is no place.
      ['2026-02-24T18:57:00', 'Data Received', null, 'registered'],
      ['2026-02-24T17:14:00', 'Label Created', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && Boolean(event.time) !== Boolean(event.local_time))).toBe(true);
    expect(deliveryHandoff('globalpost', DELIVERED, normalizeCarrierResult(result)))
      .toEqual({ carrier: 'royal-mail', number: 'ZZ123456785GB', basis: 'partner' });
  });

  it('reads a parcel through customs and hands it to Canada Post', () => {
    const result = parseGlobalpost(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Transit',
      last_update_local: '2026-06-04T23:02:00', service_name: 'GlobalPost Plus', destination_country: 'CA',
      delivery_carrier: 'canada-post', delivery_tracking_number: 'LZ123456785US' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2026-06-04T23:02:00', 'In Transit', 'SAMPLEVILLE', 'in_transit'],
      ['2026-06-04T20:02:00', 'Arrived at Partner Facility', null, 'in_transit'],
      ['2026-06-04T16:56:00', 'In Customs', 'CA', 'customs'],
      ['2026-06-03T08:02:00-05:00', 'Departed GlobalPost Facility', 'Sampleburg IL', 'in_transit'],
      // Customs let the parcel go on.
      ['2026-06-03T06:51:00', 'Cleared Customs', null, 'in_transit'],
      // USPS's scans at towns that could be in Illinois or in Israel keep their wall clocks.
      ['2026-06-03T05:24:00', 'Departed Partner Facility', 'SAMPLE IL INTERNATI', 'in_transit'],
      ['2026-06-03T05:00:00', 'Arrived at Partner Facility', 'SAMPLE IL INTERNATI', 'in_transit'],
      ['2026-06-02T06:49:00', 'Arrived at Partner Facility', 'ISC SAMPLE IL (USPS', 'in_transit'],
      ['2026-06-02T06:49:00', 'In Customs', null, 'customs'],
      // A facility's place loses the cut-off ZIP code after it; written as Asendia's are, it keeps its wall clock.
      ['2026-06-01T10:56:00', 'Arrived at GlobalPost Facility', 'Sampleburg, IL', 'accepted'],
      ['2026-05-31T21:22:00', 'In-Transit', null, 'in_transit'],
      ['2026-05-30T10:39:00', 'In Transit', 'SAMPLE STREAM,IL', 'in_transit'],
      ['2026-05-29T08:33:00', 'Departed Partner Facility', 'SAMPLE IL DISTRIBUT', 'in_transit'],
      ['2026-05-21T19:36:00', 'Arrived at Partner Facility', 'SAMPLETOWN,IL', 'in_transit'],
      ['2026-05-20T16:27:00', 'Data Received', null, 'registered'],
      ['2026-05-20T14:35:00', 'Label Created', null, 'registered'],
    ]);
    expect(deliveryHandoff('globalpost', IN_TRANSIT, normalizeCarrierResult(result)))
      .toEqual({ carrier: 'canada-post', number: 'LZ123456785US', basis: 'partner' });
  });

  it('dates USPS\'s scans on the way out, and a processing center\'s, on their state\'s clock', () => {
    const result = parseGlobalpost(illinois(), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-06-04T23:02:00' });
    expect(clocks(result)).toEqual([
      // Canada Post's scans name no province.
      ['2026-06-04T23:02:00', 'In Transit', 'SAMPLEVILLE'],
      ['2026-06-04T20:02:00', 'Arrived at Partner Facility', null],
      ['2026-06-04T16:56:00', 'In Customs', 'CA'],
      ['2026-06-03T08:02:00-05:00', 'Departed GlobalPost Facility', 'Sampleburg IL'],
      ['2026-06-03T06:51:00', 'Cleared Customs', null],
      // USPS's exchange office, named by its facility, before and after GlobalPost's last scan.
      ['2026-06-03T05:24:00-05:00', 'Departed Partner Facility', 'CHICAGO IL INTERNATI'],
      ['2026-06-03T05:00:00-05:00', 'Arrived at Partner Facility', 'CHICAGO IL INTERNATI'],
      ['2026-06-02T06:49:00-05:00', 'Arrived at Partner Facility', 'ISC CHICAGO IL (USPS'],
      ['2026-06-02T06:49:00', 'In Customs', null],
      ['2026-06-01T10:56:00', 'Arrived at GlobalPost Facility', 'Sampleburg, IL'],
      // GlobalPost's own row in transit names no place.
      ['2026-05-31T21:22:00', 'In-Transit', null],
      // USPS's scans on the way to GlobalPost, by town and by facility.
      ['2026-05-30T10:39:00-05:00', 'In Transit', 'CAROL STREAM,IL'],
      ['2026-05-29T08:33:00-05:00', 'Departed Partner Facility', 'CHICAGO IL DISTRIBUT'],
      ['2026-05-21T19:36:00-05:00', 'Arrived at Partner Facility', 'CHICAGO,IL'],
      ['2026-05-20T16:27:00', 'Data Received', null],
      ['2026-05-20T14:35:00', 'Label Created', null],
    ]);
    // A town written as USPS writes it, once GlobalPost has the parcel, could be abroad.
    const abroad = parseGlobalpost(illinois().replace('SAMPLEVILLE', 'SAMPLEVILLE,CA'), IN_TRANSIT);
    expect(abroad.events![0]).toMatchObject({ local_time: '2026-06-04T23:02:00', location: 'SAMPLEVILLE,CA' });
    expect(abroad.events![0]).not.toHaveProperty('time');
    // Without GlobalPost's scans, the parcel is GlobalPost's once customs scans it.
    const unscanned = parseGlobalpost(illinois().replace('SAMPLEVILLE', 'SAMPLEVILLE,CA').replace(/(?:Arrived at|Departed) GlobalPost Facility/g, 'Synthetic Note'), IN_TRANSIT);
    expect(unscanned.events!.filter((event) => event.time).map((event) => event.location)).toEqual([
      'CHICAGO IL INTERNATI', 'CHICAGO IL INTERNATI', 'ISC CHICAGO IL (USPS', 'CAROL STREAM,IL', 'CHICAGO IL DISTRIBUT', 'CHICAGO,IL']);
  });

  it('follows the newest scan\'s instant with the last update, and keeps the wall clock of one without', () => {
    const read = (html: string, number: string) => {
      const { current_stage, last_status_text, last_update, last_update_local } = parseGlobalpost(html, number);
      return { current_stage, last_status_text, last_update, last_update_local };
    };
    // USPS on the way to GlobalPost, its exchange office before the facility's departure, and the facility.
    expect(read(asOf(illinois(), 'May 30, 2026'), IN_TRANSIT)).toEqual({ current_stage: 'in_transit', last_status_text: 'In Transit',
      last_update: '2026-05-30T10:39:00-05:00', last_update_local: undefined });
    expect(read(asOf(illinois(), 'Jun 2, 2026'), IN_TRANSIT)).toEqual({ current_stage: 'in_transit', last_status_text: 'Arrived at Partner Facility',
      last_update: '2026-06-02T06:49:00-05:00', last_update_local: undefined });
    expect(read(asOf(fixture('returned'), 'Jun 1, 2026'), RETURNED)).toEqual({ current_stage: 'accepted', last_status_text: 'Arrived at GlobalPost Facility',
      last_update: '2026-06-01T10:56:00-05:00', last_update_local: undefined });
    expect(read(asOf(fixture('delivered'), 'Feb 27, 2026'), DELIVERED)).toEqual({ current_stage: 'in_transit', last_status_text: 'Departed GlobalPost Facility',
      last_update: '2026-02-27T00:05:00-08:00', last_update_local: undefined });
    // GlobalPost's own row in transit, without a place, and a facility Asendia runs.
    expect(read(asOf(illinois(), 'May 31, 2026'), IN_TRANSIT)).toMatchObject({ last_update: null, last_update_local: '2026-05-31T21:22:00' });
    expect(read(asOf(illinois(), 'Jun 1, 2026'), IN_TRANSIT)).toMatchObject({ current_stage: 'accepted', last_update: null, last_update_local: '2026-06-01T10:56:00' });
  });

  it('keeps the wall clocks of scans whose place does not settle a zone', () => {
    const times = (html: string, number: string) => parseGlobalpost(html, number).events!.filter((event) => event.time).length;
    expect(times(fixture('delivered'), DELIVERED)).toBe(2);
    // A state with two clocks, for a processing center and for USPS.
    expect(times(fixture('delivered').replaceAll('Sampleton CA', 'Sampleton TX'), DELIVERED)).toBe(0);
    expect(times(asOf(illinois(), 'May 30, 2026').replace('CAROL STREAM,IL', 'SAMPLE CITY,TX').replace('CHICAGO IL DISTRIBUT', 'SAMPLE TX DISTRIBUT')
      .replace('CHICAGO,IL', 'SAMPLETON,KY'), IN_TRANSIT)).toBe(0);
    // A facility without its state, a place cut before the facility's kind, and a USPS-shaped registration.
    expect(times(fixture('delivered').replaceAll('Sampleton CA', 'Sampleton'), DELIVERED)).toBe(0);
    expect(times(asOf(illinois(), 'May 29, 2026').replace('CHICAGO IL DISTRIBUT', 'SAMPLE VILLAGE PA').replace('CHICAGO,IL', 'CHICAGO'), IN_TRANSIT)).toBe(0);
    expect(times(fixture('delivered').replaceAll('Sampleton CA', 'Sampleton').replace(/(Label Created\t+<\/div>)/, '$1<div class="city">SAMPLETON,OH</div>'), DELIVERED))
      .toBe(0);
    // Midnight sharp is where the page puts a day without its time.
    expect(parseGlobalpost(changed('delivered', '12:05 am', '12:00 am'), DELIVERED).events![4]).toMatchObject({ local_time: '2026-02-27T00:00:00' });
    // A clock the zone skips when summer time starts.
    const skipped = parseGlobalpost(fixture('delivered').replace(/<strong>Friday<\/strong>, Feb 27, 2026([\s\S]*?)12:05 am/,
      (_page, between: string) => `<strong>Sunday</strong>, Mar 8, 2026${between}2:05 am`), DELIVERED);
    expect(skipped.events![4]).toMatchObject({ local_time: '2026-03-08T02:05:00', description: 'Departed GlobalPost Facility' });
  });

  it('dates only a parcel sent from the United States, and not on its way back', () => {
    const times = (html: string, number: string) => parseGlobalpost(html, number).events!.filter((event) => event.time).map((event) => event.location);
    // From the United Kingdom, by its number or, on an older number, by its route.
    const british = DELIVERED.replace(/US$/, 'GB');
    expect(times(fixture('delivered').replaceAll(DELIVERED, british), british)).toEqual([]);
    const older = 'SDC000000000000017';
    expect(times(fixture('delivered').replaceAll(DELIVERED, older), older)).toEqual(['Sampleton CA', 'Sampleton CA']);
    expect(times(fixture('delivered').replaceAll(DELIVERED, older).replace('Senderville, OR, US', 'Senderville, ENG, GB'), older)).toEqual([]);
    // USPS's exchange office on the way back keeps its wall clock, after the attempt abroad.
    const back = parseGlobalpost(placed('returned', { 'SAMPLE IL INTERNATI': 'CHICAGO IL INTERNATI' }), RETURNED);
    expect(back.events!.filter((event) => event.time).map((event) => [event.time, event.description]))
      .toEqual([['2026-06-03T08:02:00-05:00', 'Departed GlobalPost Facility'], ['2026-06-01T10:56:00-05:00', 'Arrived at GlobalPost Facility']]);
    expect(back).toMatchObject({ current_stage: 'returned', last_update: null, last_update_local: '2026-08-06T13:43:00' });
  });

  it('keeps no recipient or shipper town, ZIP code or progress rail', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT], ['returned', RETURNED]] as const) {
      const text = JSON.stringify(parseGlobalpost(fixture(name), number));
      expect(text, name).not.toMatch(/Recipient|Senderville|Senderton|SMP|\b00000\b|\b6000\b|Ordered|Out For Delivery/);
    }
  });

  it('reads a delivery at the sender\'s town, after an attempt abroad, as the return it is', () => {
    const result = parseGlobalpost(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update_local: '2026-08-06T13:43:00', destination_country: 'CA',
      delivery_carrier: 'canada-post', delivery_tracking_number: 'LZ000000014US' });
    expect(result.events!.map((event) => [event.description, event.location ?? null, event.stage])).toEqual([
      ['Delivered', 'SENDERTON', 'returned'],
      ['Arrived at Partner Facility', 'SENDERTON', 'in_transit'],
      ['Departed Partner Facility', 'SAMPLE IL INTERNATI', 'in_transit'],
      ['In Transit', 'SAMPLEPORT', 'in_transit'],
      ['In Customs', null, 'customs'],
      ['Arrived at Partner Facility', 'CA', 'in_transit'],
      ['Attempted Delivery', 'CA', 'failed_attempt'],
      ['Out for Delivery', 'CA', 'out_for_delivery'],
      ['In Customs', 'CA', 'customs'],
      ['Departed GlobalPost Facility', 'Sampleburg IL', 'in_transit'],
      ['Arrived at GlobalPost Facility', 'Sampleburg IL', 'accepted'],
      ['Label Created', null, 'registered'],
    ]);
    expect(result.events![0]).toMatchObject({ stage_source: 'carrier_map' });
    expect(deliveryHandoff('globalpost', RETURNED, normalizeCarrierResult(result)))
      .toEqual({ carrier: 'canada-post', number: 'LZ000000014US', basis: 'partner' });
  });

  it('keeps a delivery that the route does not place at the sender\'s town', () => {
    const stage = (html: string) => parseGlobalpost(html, RETURNED).current_stage;
    const delivered = (place: string) => changed('returned', /(Delivered\t+<\/div>\s*<div class="city">\s*)SENDERTON/, `$1${place}`);
    // At the recipient's town, at another town, with a ZIP code only or without a place.
    expect(stage(delivered('RECIPIENTVALE'))).toBe('delivered');
    expect(stage(delivered('Sampleport'))).toBe('delivered');
    expect(stage(delivered('00000'))).toBe('delivered');
    expect(stage(delivered('Senderton,IL'))).toBe('returned');
    expect(stage(delivered('Sénderton'))).toBe('returned');
    // A route within one country, a recipient in a town of the sender's name, or no route tells nothing.
    expect(stage(changed('returned', 'Recipientvale, BC, CA', 'Recipientvale, IL, US'))).toBe('delivered');
    expect(stage(changed('returned', 'Recipientvale, BC, CA', 'Senderton, ON, CA'))).toBe('delivered');
    expect(stage(changed('returned', 'Senderton, IL, US', ''))).toBe('delivered');
    expect(stage(changed('returned', 'Senderton, IL, US', 'IL, US, Senderton'))).toBe('delivered');
    // A second round abroad after an attempt is a delivery.
    expect(parseGlobalpost(changed('delivered', /Out for Delivery/, 'Attempted Delivery'), DELIVERED).current_stage).toBe('delivered');
  });

  it('names a final-mile partner only from a name the catalog knows and a link that agrees, and keeps its number', () => {
    const named = (name: string, href: string, number: string) => {
      const { delivery_carrier, delivery_tracking_number } = parseGlobalpost(partner(name, href, number), IN_TRANSIT);
      return { delivery_carrier, delivery_tracking_number };
    };
    expect(named('DHL Germany', 'https://www.dhl.com/de-en/home/tracking/tracking-parcel.html?submit=1&amp;tracking-id=ZZ123456785FR', 'ZZ123456785FR'))
      .toEqual({ delivery_carrier: 'dhl', delivery_tracking_number: 'ZZ123456785FR' });
    expect(named('DAI Post', 'https://daiglobaltrack.com/tracking.aspx?custtracknbr=00000000000000000017', '00000000000000000017'))
      .toEqual({ delivery_carrier: 'dai-post', delivery_tracking_number: '00000000000000000017' });
    // A courier the catalog does not know by that name keeps only its number.
    expect(named('Sample Courier', 'https://track.sample.invalid/?id=SC000000000017', 'SC000000000017'))
      .toEqual({ delivery_carrier: undefined, delivery_tracking_number: 'SC000000000017' });
    // A known name with another carrier's link names nobody.
    expect(named('Canada Post', 'https://www.royalmail.com/track-your-item#/tracking-results/ZZ123456785GB', 'ZZ123456785GB'))
      .toEqual({ delivery_carrier: undefined, delivery_tracking_number: 'ZZ123456785GB' });
    // A USPS routing barcode loses the recipient's ZIP code.
    expect(named('USPS', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=420000009261290100130600000011', '420000009261290100130600000011'))
      .toEqual({ delivery_carrier: 'usps', delivery_tracking_number: '9261290100130600000011' });
    // GlobalPost's own number repeated there, or no number, hands nothing on.
    expect(named('Canada Post', 'https://www.canadapost-postescanada.ca/track-reperage/en#/details/X', IN_TRANSIT))
      .toEqual({ delivery_carrier: undefined, delivery_tracking_number: undefined });
    expect(named('Canada Post', 'https://www.canadapost-postescanada.ca/track-reperage/en', ''))
      .toEqual({ delivery_carrier: undefined, delivery_tracking_number: undefined });
    const before = changed('in-transit', /<div class="finalMiletrackingSection">[\s\S]*?<div class="copy-icon"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '');
    const unassigned = parseGlobalpost(before, IN_TRANSIT);
    expect(unassigned).not.toHaveProperty('delivery_carrier');
    expect(unassigned).not.toHaveProperty('delivery_tracking_number');
    expect(deliveryHandoff('globalpost', IN_TRANSIT, normalizeCarrierResult(unassigned))).toBeNull();
  });

  it('does not step back to a registration listed after the parcel moved', () => {
    const late = parseGlobalpost(changed('delivered', /(<div class="eventDescription">\s*)Delivered/, '$1Data Received'), DELIVERED);
    expect(late.events![0]).toMatchObject({ description: 'Data Received', stage: 'registered' });
    expect(late).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Data Received', last_update_local: '2026-03-06T11:36:00' });
  });

  it('stages a wording it does not know through the shared rules, or leaves it unstaged', () => {
    const worded = parseGlobalpost(changed('in-transit', /In Transit(\t+<\/div>\s*<div class="city">\s*SAMPLEVILLE)/, 'Available for Pickup$1'), IN_TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Available for Pickup' });
    expect(worded.events![0]).toMatchObject({ stage: 'ready_for_pickup', stage_source: expect.not.stringMatching(/^carrier_map$/) });
    const unstaged = parseGlobalpost(changed('in-transit', /In Transit(\t+<\/div>\s*<div class="city">\s*SAMPLEVILLE)/, 'Synthetic Note$1'), IN_TRANSIT);
    expect(unstaged).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic Note' });
    expect(unstaged.events![0]).not.toHaveProperty('stage');
  });

  it('binds the page to the whole number it echoes', () => {
    expect(() => parseGlobalpost(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GlobalPost answered for another number' }));
    const other = changed('delivered', `<div id="${DELIVERED}-global-post-tracking-id">\n\t\t\t\t\t\t\t\t\t\t${DELIVERED}`,
      `<div id="${DELIVERED}-global-post-tracking-id">\n\t\t\t\t\t\t\t\t\t\t${UNKNOWN}`);
    expect(() => parseGlobalpost(other, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseGlobalpost(fixture('delivered'), DELIVERED.toLowerCase())).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads a page with several shipments as inconclusive and one without scans as no history', () => {
    const page = fixture('delivered');
    const start = page.indexOf('<div class="single-tracking-container');
    const card = page.slice(start, page.indexOf('<footer'));
    expect(() => parseGlobalpost(page.replace(card, `${card}${card}`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GlobalPost answered for several shipments' }));
    const list = page.indexOf("<div class='single-view-tracking-details-container'>");
    const empty = `${page.slice(0, list)}<div class='single-view-tracking-details-container'></div></div></div></div></body></html>`;
    expect(() => parseGlobalpost(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads scans listed without their timestamp wrappers, as an older page did', () => {
    const bare = fixture('delivered').replace(/<div class="trackingEvents-timestamp-wrapper">/g, '<div>');
    expect(parseGlobalpost(bare, DELIVERED).events).toHaveLength(8);
  });

  it('rejects a changed page', () => {
    for (const html of [
      '<html><title>Track-Detail - GlobalPost</title><body>Enter tracking numbers</body></html>',
      changed('delivered', "<div class='single-view-tracking-details-container'>", "<div class='tracking-list'>"),
      changed('delivered', /<div class="trackingEvents-timeline-row">/g, '<div class="row">'),
      changed('delivered', 'Mar 6, 2026', '6 Mar 2026'),
      changed('delivered', 'Mar 6, 2026', 'Mar 7, 2026'),
      changed('delivered', 'Mar 6, 2026', 'Feb 30, 2026'),
      changed('delivered', 'Mar 6, 2026', 'Sept 6, 2026'),
      changed('delivered', '11:36 am', '11:36'),
      changed('delivered', '11:36 am', '13:36 pm'),
      changed('delivered', '11:36 am', '0:36 am'),
      changed('delivered', '11:36 am', '11:66 am'),
      changed('delivered', /Delivered(\t+<\/div>\s*<div class="city">)/, '$1'),
      changed('delivered', '<div class="trackingEvents-timestamp-header">', '<div class="day">'),
    ]) {
      expect(() => parseGlobalpost(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the redirect to the search page’s notice as not found, and keeps other redirects, a moved page, a bot check and a broken page apart', async () => {
    await expect(lookup('', { status: 302, headers: { Location: notFoundFor(UNKNOWN) } }, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: `/tracking/?t=${UNKNOWN}&status=not_found` } }, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: notFoundFor(DELIVERED) } }, UNKNOWN))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'GlobalPost answered for another number' });
    await expect(lookup('', { status: 302, headers: { Location: `https://www.goglobalpost.com/tracking/?t=${UNKNOWN}&status=error` } }, UNKNOWN))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.goglobalpost.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Page not found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="cf-turnstile" data-sitekey="synthetic"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>GlobalPost</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a page over its size limit', async () => {
    await expect(lookup('x', { headers: { 'Content-Length': String(3_000_000) } })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects numbers GlobalPost does not issue and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['GPSIZZ990000001US', 'GPSIZZ99000000170US', 'GPSIZZ9900000017CA', 'GP1IZZ9900000017US', 'SDC00000000000001',
      'ZZ123456785US', '9261290100130600000017', `GP${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGlobalpostNumber('gppizz-9900-0000-25us')).toBe(IN_TRANSIT);
    expect(normalizeGlobalpostNumber('sdc 000000000000017')).toBe('SDC000000000000017');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('routes a number filed under GlobalPost, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).startsWith(GLOBALPOST_TRACK_DETAIL) ? reply(fixture('delivered')) : new Response('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'globalpost' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'globalpost', source: 'globalpost', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'globalpost', source: 'globalpost' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === pageFor(DELIVERED))).toBe(true);
  });
});

describe('GlobalPost numbers', () => {
  it('accepts every public GlobalPost number, which its rule settles without recognition, and reads the tracker links', () => {
    const own = numbers.records.filter((record) => record.expect.carrier === 'globalpost');
    expect(own.length).toBeGreaterThan(0);
    for (const record of own) {
      expect(normalizeGlobalpostNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number), record.number).toMatchObject({ carrier: 'globalpost', confidence: 'high' });
      expect(recognitionCandidates(record.number), record.number).toEqual([]);
    }
    // The older SDC layout is GlobalPost's too, though no rule claims it; a USPS label it shows is not.
    const older = numbers.records.filter((record) => record.number.startsWith('SDC'));
    const postal = numbers.records.filter((record) => record.expect.carrier === 'usps');
    expect(older.length && postal.length).toBeTruthy();
    for (const { number } of older) expect(normalizeGlobalpostNumber(number), number).toBe(number);
    for (const { number } of postal) expect(() => normalizeGlobalpostNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(parseTrackingInput(`https://www.goglobalpost.com/track-detail/?t=${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'globalpost' });
  });
});

describe('GlobalPost status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    expect(statuses.entries).toHaveLength(17);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(globalpostStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'globalpost', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'globalpost', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(globalpostStage('Synthetic note')).toBeNull();
  });
});

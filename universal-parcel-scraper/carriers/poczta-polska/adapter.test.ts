import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, parsePocztaPolskaBootstrap, PocztaPolskaTracker } from './adapter.js';
import { normalizePocztaPolskaNumber, parsePocztaPolska } from './parser.js';
import { classifyPocztaPolskaStatus } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '00000000000000000001';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const bootstrap = readFileSync(new URL('./fixtures/bootstrap.html', import.meta.url), 'utf8');
const payload = () => structuredClone(fixture);
const negative = () => ({ number: NUMBER, mailStatus: -1 });

describe('Poczta Polska identity-bound scans', () => {
  it('reads Polish offices on Warsaw time and keeps office names and explicit kg weight without addresses', () => {
    const result = normalizeCarrierResult(parsePocztaPolska(payload(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-06T12:00:00+01:00',
      weight_kg: 0.35, expected_delivery: null });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'exception', 'accepted', 'registered']);
    expect(result.events?.[0]).toMatchObject({ location: 'Example Post Office', description: 'Final delivery', provider_code: 'P_D' });
    // An office type marks a Polish office; the electronic sender has none.
    expect(result.events?.map(event => event.time ?? event.local_time)).toEqual(['2026-01-06T12:00:00+01:00',
      '2026-01-06T08:00:00+01:00', '2026-01-05T16:00:00+01:00', '2026-01-04T12:00:00+01:00', '2026-01-04T08:00:00']);
    expect(result.events?.slice(0, 4).every(event => !event.local_time)).toBe(true);
    expect(result.events?.[4]).not.toHaveProperty('time');
    expect(result).toMatchObject({ delivered_at: '2026-01-06T12:00:00+01:00', service_name: 'Synthetic parcel' });
    expect(result).not.toHaveProperty('timezone');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|openingHours|additionalServices|dispatchDate/);
    const declared = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    const evidence: Record<string, boolean> = { history: Boolean(result.events?.length),
      location: Boolean(result.events?.[0]?.location), weight: result.weight_kg === 0.35,
      delivered_at: Boolean(result.delivered_at), service_name: Boolean(result.service_name) };
    for (const capability of declared.capabilities) expect(evidence[capability], capability).toBe(true);
  });

  it('requires both exact identities and rejects malformed envelopes', () => {
    const wrong = payload(); wrong.number = '00000000000000000002';
    const inner = payload(); inner.mailInfo.number = '00000000000000000002';
    const punctuation = payload(); punctuation.mailInfo.number = '0000000000 0000000001';
    for (const value of [null, {}, { number: NUMBER, mailStatus: '0' }, { number: NUMBER, mailStatus: 0 }, wrong, inner, punctuation]) {
      expect(() => parsePocztaPolska(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const padded = payload(); padded.number = ` ${NUMBER} `; padded.mailInfo.number = ` ${NUMBER} `;
    expect(parsePocztaPolska(padded, NUMBER).status).toBe('delivered');
  });

  it('keeps ambiguous reuse, empty history and generic errors distinct from explicit absence', () => {
    expect(() => parsePocztaPolska(negative(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const mixed = { ...negative(), mailInfo: payload().mailInfo };
    const empty = payload(); empty.mailInfo.events = [];
    for (const value of [mixed, empty, { ...negative(), mailStatus: 1 }, { ...negative(), mailStatus: -2 },
      { ...negative(), mailStatus: -99 }]) {
      expect(() => parsePocztaPolska(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const wrong = negative(); wrong.number = '00000000000000000002';
    expect(() => parsePocztaPolska(wrong, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['2026-02-30T12:00:00', '2026-01-06T12:00:00+02:99', '2026-01-06T12:00:00+99:00', '12:00', '', null])(
    'retains an unresolved newest clock %s without promoting earlier dated history', (time) => {
      const value = payload(); value.mailInfo.events.at(-1).time = time;
      const result = parsePocztaPolska(value, NUMBER);
      expect(result).toMatchObject({ status: 'delivered', last_update: null });
      expect(result.events?.[0]!.description).toBe('Final delivery');
      expect(result.events?.[0]).not.toHaveProperty('time'); expect(result.events?.[0]).not.toHaveProperty('local_time');
      if (time) expect(result.events?.[0]).toMatchObject({ provider_time_text: time });
    });

  it('uses explicit offsets when provided and keeps local order across countries', () => {
    const explicit = payload(); for (const event of explicit.mailInfo.events) event.time += '-03:00';
    expect(parsePocztaPolska(explicit, NUMBER)).toMatchObject({ last_update: '2026-01-06T12:00:00-03:00' });
    // Scans relayed from abroad name no Polish office and keep their own wall clock.
    const relayed = payload(); relayed.mailInfo.recipientCountryCode = 'NZ';
    relayed.mailInfo.events.at(-2).postOffice = { name: 'International Postal System' };
    relayed.mailInfo.events.at(-2).time = '2026-01-07T08:00:00';
    const result = parsePocztaPolska(relayed, NUMBER);
    expect(result).toMatchObject({ last_update: '2026-01-06T12:00:00+01:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events?.map(event => event.provider_code)).toEqual(['P_D', 'P_WD', 'P_ND', 'P_NAD', 'P_REJ_KN1']);
    expect(result.events?.[1]).toMatchObject({ local_time: '2026-01-07T08:00:00' });
    expect(result.events?.[1]).not.toHaveProperty('time');
  });

  it('dates an item from abroad once a Polish office scans it, on winter or summer time', () => {
    const office = { code: '000003', name: 'Example Exchange Office', officeType: 'CP WER' };
    const inbound = (date: string) => {
      const value = payload(); value.mailInfo.events = [
        { ...scan('P_NAD', 'Posting/collection', 'NA', `${date}T09:00:00`, 'International Postal System') },
        { ...scan('P_WYOC', 'Dispatch from the country of origin', 'TR', `${date}T23:30:00`), postOffice: {} },
        { ...scan('P_WEPL', 'Arrival in Poland', 'TR', `${date}T22:15:00`), postOffice: office },
        { ...scan('P_D', 'Final delivery', 'DO', `${date}T23:45:00`), postOffice: { name: 'Example Post Office', officeType: 'UP' } }];
      return parsePocztaPolska(value, NUMBER);
    };
    const winter = inbound('2026-01-10');
    expect(winter).toMatchObject({ status: 'delivered', last_update: '2026-01-10T23:45:00+01:00' });
    expect(winter.events?.map(event => event.time ?? event.local_time)).toEqual(['2026-01-10T23:45:00+01:00',
      '2026-01-10T22:15:00+01:00', '2026-01-10T23:30:00', '2026-01-10T09:00:00']);
    expect(inbound('2026-07-10').events?.slice(0, 2).map(event => event.time))
      .toEqual(['2026-07-10T23:45:00+02:00', '2026-07-10T22:15:00+02:00']);
  });

  it("reads a partner post's relayed scans on its clock: the issuing post's, or the destination's for an item sent abroad", () => {
    const office = { code: '000003', name: 'Example Exchange Office', officeType: 'CP WER' };
    const item = (number: string, destination: string) => {
      const value = payload(); value.number = number; value.mailInfo.number = number; value.mailInfo.recipientCountryCode = destination;
      value.mailInfo.events = [
        { ...scan('P_NAD', 'Posting/collection', 'NA', '2026-10-20T12:10:00', 'International Postal System') },
        { ...scan('P_WYOC', 'Item departure', 'TR', '2026-10-21T00:04:00'), postOffice: {} },
        { ...scan('P_WEPL', 'Arrival in Poland', 'TR', '2026-10-23T00:50:26'), postOffice: office }];
      return parsePocztaPolska(value, number);
    };
    const inbound = item('LS000000005LV', 'PL');
    expect(inbound.events?.map(event => [event.time, event.time_zone_basis])).toEqual([['2026-10-23T00:50:26+02:00', undefined],
      ['2026-10-21T00:04:00+03:00', 'carrier'], ['2026-10-20T12:10:00+03:00', 'carrier']]);
    expect(inbound.events?.[2]).toMatchObject({ local_time: '2026-10-20T12:10:00', time_zone: 'Europe/Riga' });
    // An item Poczta Polska numbered meets the destination's post; a country of several clocks gives none.
    expect(item('RR000000005PL', 'FI').events?.[1])
      .toMatchObject({ time: '2026-10-21T00:04:00+03:00', time_zone: 'Europe/Helsinki', time_zone_basis: 'destination' });
    for (const country of ['ES', 'US']) expect(item('RR000000005PL', country).events?.[1]).not.toHaveProperty('time');
  });

  it('needs an office type, since a relayed office code can be a foreign postcode', () => {
    const value = payload(); value.mailInfo.events.at(-1).postOffice = { code: '000004', name: 'Example Foreign Office' };
    const result = parsePocztaPolska(value, NUMBER);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-01-06T12:00:00' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result).not.toHaveProperty('delivered_at');
  });

  it("dates item data from Poczta Polska's own sender platform on Warsaw time", () => {
    const sent = (time: string, name = 'Elektroniczny Nadawca') => {
      const value = payload(); value.mailInfo.events[0].time = time;
      value.mailInfo.events[0].postOffice = { name };
      return parsePocztaPolska(value, NUMBER).events?.at(-1);
    };
    expect(sent('2026-01-04T08:00:00')).toMatchObject({ time: '2026-01-04T08:00:00+01:00' });
    expect(sent('2026-07-04T08:00:00', 'ELEKTRONICZNY NADAWCA')).toMatchObject({ time: '2026-07-04T08:00:00+02:00' });
    expect(sent('2026-07-04T08:00:00', 'International Postal System')).toMatchObject({ local_time: '2026-07-04T08:00:00' });
    expect(sent('2026-07-04T08:00:00', 'International Postal System')).not.toHaveProperty('time');
  });

  it('gives no location for an office that names a system or a terminal with no address', () => {
    const value = payload();
    value.mailInfo.events = [
      { ...scan('P_REJ_KN1', 'Electronic item data received', 'NA', '2026-01-04T08:00:00', 'Elektroniczny Nadawca'), postOffice: { name: 'Elektroniczny Nadawca' } },
      scan('P_NAD', 'Posting/collection', 'NA', '2026-01-04T12:00:00', 'Sending Office'),
      { ...scan('P_PZL', 'In transport', 'TR', '2026-01-05T01:00:00'), postOffice: { name: 'Transshipment', officeType: 'CP WER' } },
      { ...scan('P_PZL', 'In transport', 'TR', '2026-01-05T03:00:00'), postOffice: { name: ' Terminal  Przeładunkowy ', officeType: 'CP WER' } },
      scan('P_WD', 'In delivery', 'DOR', '2026-01-05T08:00:00')];
    const events = parsePocztaPolska(value, NUMBER).events!;
    expect(events.map(event => event.location ?? null)).toEqual(['Example Post Office', null, null, 'Sending Office', null]);
    // The terminal is still a Polish office, so its scans keep Warsaw time.
    expect(events[1]).toMatchObject({ time: '2026-01-05T03:00:00+01:00' });
  });

  it("keeps the provider's order when every scan is dated", () => {
    const office = { code: '000001', name: 'Example Post Office', officeType: 'UP' };
    const value = payload(); value.mailInfo.events = [
      { ...scan('P_NAD', 'Posting/collection', 'NA', '2026-01-06T12:00:00'), postOffice: office },
      { ...scan('P_WD', 'In delivery', 'DOR', '2026-01-06T10:00:00'), postOffice: office },
      { ...scan('P_D', 'Final delivery', 'DO', '2026-01-06T09:59:00'), postOffice: office }];
    const dated = parsePocztaPolska(value, NUMBER);
    expect(dated).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-06T09:59:00+01:00' });
    expect(dated.events?.map(event => event.provider_code)).toEqual(['P_D', 'P_WD', 'P_NAD']);
    value.mailInfo.events.unshift(scan('P_REJ_KN1', 'Electronic item data received', 'PRZ', '2026-01-05T08:00:00', 'Electronic Sender'));
    expect(parsePocztaPolska(value, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    const offsets = payload(); offsets.mailInfo.events = value.mailInfo.events.slice(1)
      .map((event: { time: string }) => ({ ...event, time: `${event.time}+01:00` }));
    expect(parsePocztaPolska(offsets, NUMBER).events?.map(event => event.provider_code)).toEqual(['P_D', 'P_WD', 'P_NAD']);
  });

  it.each(['2026-03-29T02:30:00', '2026-10-25T02:30:00'])('keeps a Polish wall clock the clocks skip or repeat local: %s', (time) => {
    const value = payload(); value.mailInfo.events.at(-1).time = time;
    const result = parsePocztaPolska(value, NUMBER);
    expect(result).toMatchObject({ last_update: null, last_update_local: time });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result.events?.map(event => event.provider_code)).toEqual(['P_D', 'P_WD', 'P_ND', 'P_NAD', 'P_REJ_KN1']);
  });

  it('uses specific failure codes and never borrows a broad state or finished flag for unknown scans', () => {
    const failed = payload(); failed.mailInfo.events = [failed.mailInfo.events[2]];
    expect(parsePocztaPolska(failed, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception' });
    const unknown = payload(); Object.assign(unknown.mailInfo.events.at(-1), { code: '__proto__', name: 'Unmapped scan' });
    expect(parsePocztaPolska(unknown, NUMBER).status).toBe('unknown');
    expect(parsePocztaPolska(unknown, NUMBER)).not.toHaveProperty('current_stage');
    expect(parsePocztaPolska(unknown, NUMBER).events?.[0]).not.toHaveProperty('stage');
    expect(classifyPocztaPolskaStatus('constructor')).toBeUndefined();
    // The Polish answer's code for an item in delivery.
    expect(classifyPocztaPolskaStatus('P_WDML')).toEqual(classifyPocztaPolskaStatus('P_WD'));
  });

  const scan = (code: string, name: string, state: string, time: string, office = 'Example Post Office') =>
    ({ code, name, time, postOffice: { name: office }, finished: false, canceled: false, state: { code: state, name: 'SYNTHETIC' } });
  const unclaimed = () => [
    scan('P_NAD', 'Posting/collection', 'NA', '2026-01-04T12:00:00', 'Sending Office'),
    scan('P_WD', 'In delivery', 'DOR', '2026-01-05T08:00:00'),
    scan('P_A', 'Unsuccessful (physical) delivery', 'AW', '2026-01-05T15:00:00'),
    scan('P_KWD', 'Ready for pick-up at the Post Office', 'ODB', '2026-01-05T16:00:00'),
  ];

  it('waits at the office after a missed delivery and names the office that holds the item', () => {
    const value = payload(); value.mailInfo.events = unclaimed();
    const result = normalizeCarrierResult(parsePocztaPolska(value, NUMBER));
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'Example Post Office', destination_country: 'PL' });
    expect(result.events?.map(event => event.stage)).toEqual(['ready_for_pickup', 'failed_attempt', 'out_for_delivery', 'accepted']);
    value.mailInfo.events.push(scan('P_D', 'Final delivery', 'DO', '2026-01-06T10:00:00'));
    expect(parsePocztaPolska(value, NUMBER)).not.toHaveProperty('pickup_point');
  });

  it('turns the trip around at a return scan, so a final delivery back at the sender reads as returned', () => {
    const value = payload();
    value.mailInfo.events = [...unclaimed(),
      scan('P_NDZ', 'Returned', 'ZW', '2026-01-13T09:00:00'),
      scan('P_PZL', 'In transport', 'TR', '2026-01-14T04:00:00', 'Transshipment'),
      scan('P_WD', 'In delivery', 'DOR', '2026-01-14T08:00:00', 'Sending Office')];
    const travelling = normalizeCarrierResult(parsePocztaPolska(value, NUMBER));
    expect(travelling).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(travelling.events?.[0]).toMatchObject({ provider_leg: 'return' });
    value.mailInfo.events.push(scan('P_D', 'Final delivery', 'DO', '2026-01-14T14:00:00', 'Sending Office'));
    const result = normalizeCarrierResult(parsePocztaPolska(value, NUMBER));
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Final delivery' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events?.map(event => event.stage)).toEqual(['returned', 'out_for_delivery', 'in_transit', 'returned',
      'ready_for_pickup', 'failed_attempt', 'out_for_delivery', 'accepted']);
    expect(result.events?.map(event => event.provider_leg ?? null)).toEqual(['return', 'return', 'return', 'return',
      null, null, null, null]);
    // The returned state turns the trip around even under a code the map does not know.
    const unnamed = payload();
    unnamed.mailInfo.events = [...unclaimed(), scan('P_SYNTH', 'Sent back', 'ZW', '2026-01-13T09:00:00'),
      scan('P_D', 'Final delivery', 'DO', '2026-01-14T14:00:00', 'Sending Office')];
    const back = parsePocztaPolska(unnamed, NUMBER);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(back.events?.[1]).not.toHaveProperty('stage');
  });

  it('marks customs handling and keeps only a two-letter destination country', () => {
    const value = payload();
    value.mailInfo.recipientCountryCode = 'NZ';
    value.mailInfo.events = [scan('P_NAD', 'Posting/collection', 'NA', '2026-01-04T12:00:00'),
      scan('P_WYPL', 'Departure from Poland', 'WYPL', '2026-01-05T10:00:00'),
      scan('P_ZWC', 'Customs service', 'OCP', '2026-01-12T14:00:00', 'International Postal System')];
    expect(parsePocztaPolska(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'customs', destination_country: 'NZ' });
    for (const country of ['New Zealand', 'nz', null]) {
      value.mailInfo.recipientCountryCode = country;
      expect(parsePocztaPolska(value, NUMBER)).not.toHaveProperty('destination_country');
    }
  });

  it('follows an item from abroad through the exchange office and customs to its collection', () => {
    const value = payload();
    const office = { name: 'Example Post Office', officeType: 'UP' };
    const exchange = { name: 'Example Exchange Office', officeType: 'WER' };
    value.mailInfo.events = [
      { ...scan('P_NAD', 'Posting/collection', 'NA', '2026-01-04T12:00:00', 'International Postal System'), postOffice: { name: 'International Postal System' } },
      { ...scan('P_WYOC', 'Item departure', 'TR', '2026-01-05T10:00:00'), postOffice: null },
      { ...scan('P_WEPL', 'Arrival at inward office of exchange (Poland)', 'TR', '2026-01-12T13:00:00'), postOffice: exchange },
      { ...scan('P_ZWC', 'Customs service', 'OCP', '2026-01-12T14:00:00'), postOffice: exchange },
      { ...scan('P_ZWOLDDOR', 'Customs service II', 'OCP', '2026-01-13T09:00:00'), postOffice: exchange },
      { ...scan('P_KWD', 'Ready for pick-up at the Post Office', 'ODB', '2026-01-14T16:00:00'), postOffice: office },
      { ...scan('P_OWU', 'Collected at the post office', 'OP', '2026-01-15T11:00:00'), postOffice: office },
      { ...scan('P_ROZL_CEL', 'Customs service', 'OCP', '2026-01-21T08:00:00'), postOffice: exchange }];
    const collected = normalizeCarrierResult(parsePocztaPolska(value, NUMBER));
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Collected at the post office',
      last_update: '2026-01-15T11:00:00+01:00', delivered_at: '2026-01-15T11:00:00+01:00' });
    expect(collected).not.toHaveProperty('pickup_point');
    expect(collected.events?.map(event => event.provider_code)).toEqual(['P_ROZL_CEL', 'P_OWU', 'P_KWD', 'P_ZWOLDDOR', 'P_ZWC',
      'P_WEPL', 'P_WYOC', 'P_NAD']);
    expect(parsePocztaPolska(value, NUMBER).events?.slice(1, 7).map(event => event.stage)).toEqual(['delivered', 'ready_for_pickup',
      'customs', 'customs', 'in_transit', 'in_transit']);
    expect(parsePocztaPolska(value, NUMBER).events?.[0]).not.toHaveProperty('stage');
    value.mailInfo.events = value.mailInfo.events.slice(0, 3);
    expect(parsePocztaPolska(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('reads a second failed delivery and has nothing to read for unregistered mail', () => {
    const value = payload(); value.mailInfo.events = [...unclaimed(),
      scan('P_PA', 'Second unsuccessful (physical) delivery', 'AW', '2026-01-12T09:00:00')];
    expect(parsePocztaPolska(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    const unregistered = { number: NUMBER, mailStatus: 0, mailInfo: { typeOfMailCode: 'UNREGISTERED_MAIL_TYPE', finished: true } };
    expect(() => parsePocztaPolska(unregistered, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePocztaPolska({ ...unregistered, mailInfo: { typeOfMailCode: 'PRP', finished: true } }, NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the widget check-digit alias while requiring the full returned barcode', () => {
    const prefix = '0000000000000000001';
    const canonical = normalizePocztaPolskaNumber(prefix);
    expect(canonical).toBe('00000000000000000017');
    const value = payload(); value.number = canonical; value.mailInfo.number = canonical;
    expect(parsePocztaPolska(value, prefix).canonical_tracking_number).toBe(canonical);
    value.number = prefix;
    expect(() => parsePocztaPolska(value, prefix)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // The SSCC a label prints after "(00)" is looked up as the whole barcode.
    expect(normalizePocztaPolskaNumber('1 5900773 000000001 1')).toBe('00159007730000000011');
    value.number = '00159007730000000011'; value.mailInfo.number = '00159007730000000011';
    expect(parsePocztaPolska(value, '159007730000000011').canonical_tracking_number).toBe('00159007730000000011');
    expect(() => normalizePocztaPolskaNumber('15900773000000001')).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    expect(normalizePocztaPolskaNumber('px 0000000001')).toBe('PX0000000001');
    expect(normalizePocztaPolskaNumber('rr 000000005 pl')).toBe('RR000000005PL');
  });

  it('bounds history, refuses grouped and invalidated scans, and deduplicates only exact projections', () => {
    const invalidated = payload(); invalidated.mailInfo.events.at(-1).canceled = true;
    const pallet = payload(); pallet.mailInfo.typeOfMailCode = 'PPL';
    const components = payload(); components.mailInfo.components = ['PX0000000001', 'PX0000000002'];
    const single = payload(); single.mailInfo.components = ['PX0000000001'];
    for (const value of [invalidated, pallet, components, single]) expect(() => parsePocztaPolska(value, NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const components of [{}, 'PX0000000001', [null], ['']]) {
      const value = payload(); value.mailInfo.components = components;
      expect(() => parsePocztaPolska(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const components of [null, []]) {
      const value = payload(); value.mailInfo.components = components;
      expect(parsePocztaPolska(value, NUMBER).status).toBe('delivered');
    }
    for (const scan of [null, {}, { name: 'Final delivery', code: 'P_D', time: 123 }]) {
      const value = payload(); value.mailInfo.events.push(scan);
      expect(() => parsePocztaPolska(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const duplicate = payload(); duplicate.mailInfo.events.push(duplicate.mailInfo.events.at(-1));
    expect(parsePocztaPolska(duplicate, NUMBER).events).toHaveLength(5);
    const excessive = payload(); excessive.mailInfo.events = Array(501).fill(excessive.mailInfo.events[0]);
    expect(() => parsePocztaPolska(excessive, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const weight of [0, -1, '0.35', null, Infinity]) {
      const value = payload(); value.mailInfo.weight = weight;
      expect(parsePocztaPolska(value, NUMBER)).not.toHaveProperty('weight_kg');
    }
  });
});

describe('Poczta Polska public widget request', () => {
  it('validates one pinned public configuration before sending two bounded anonymous requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(bootstrap))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://emonitoring.poczta-polska.pl/');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://uss.poczta-polska.pl/uss/v2.0/tracking/checkmailex');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error',
      body: JSON.stringify({ language: 'EN', number: NUMBER, addPostOfficeInfo: false }) });
    const headers = new Headers(init?.headers);
    expect(headers.get('API_KEY')).toBe('synthetic-public-widget-configuration-key');
    // A Polish reader gets the scans in Polish; every other language reads English.
    for (const [language, asked] of [['pl', 'PL'], ['pl-PL', 'PL'], ['de', 'EN'], [null, 'EN']] as const) {
      fetcher.mockResolvedValueOnce(new Response(bootstrap)).mockResolvedValueOnce(new Response(JSON.stringify(payload())));
      await instance.track({ number: NUMBER, language });
      expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ language: asked });
    }
    expect(headers.has('Cookie')).toBe(false); expect(headers.has('Authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    for (const html of ['', bootstrap + bootstrap, bootstrap.replace('uss.poczta-polska.pl', 'untrusted.example'),
      bootstrap.replace('synthetic-public-widget-configuration-key', '')]) {
      expect(() => parsePocztaPolskaBootstrap(html)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('recognizes exact history and proven absence while preserving ambiguous failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(bootstrap))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload())))
      .mockResolvedValueOnce(new Response(bootstrap)).mockResolvedValueOnce(new Response(JSON.stringify(negative())))
      .mockResolvedValueOnce(new Response(bootstrap)).mockResolvedValueOnce(new Response(JSON.stringify({ ...negative(), mailStatus: 1 })));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-06T11:00:00.000Z' });
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])(
    'keeps HTTP %s distinct from parcel absence', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: Number(status) }));
      await expect(new PocztaPolskaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('rejects invalid inputs and cancels before sending the tracking query', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['123', 'RR000000006PL', `${NUMBER}&payment=1`]) {
      expect(() => new PocztaPolskaTracker({ fetcher: unused }).fetch(number)).toThrow(InvalidInputError);
    }
    await expect(new PocztaPolskaTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return new Response(bootstrap); });
    await expect(new PocztaPolskaTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(500_001)));
    await expect(new PocztaPolskaTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});

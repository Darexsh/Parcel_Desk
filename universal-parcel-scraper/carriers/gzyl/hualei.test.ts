import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import {
  HualeiTracker, hualeiPartner, hualeiScanText, normalizeHualeiNumber, parseHualeiPage, parseHualeiTrack, type HualeiRow,
} from './hualei.js';
import { GZYL } from './parser.js';

const NUMBER = 'GZTEST00000001';
// Noon in Beijing on the fixtures' last day: their last row is still ahead.
const READ_AT = Date.parse('2026-03-06T04:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** The track fixture's record, changed in place by `change`. */
const edited = (change: (record: Reply) => void): Reply => {
  const payload = fixture('track');
  change(payload[0].data[0]);
  return payload;
};
const row = (track_date: string, track_content: string, track_location = '', track_kind = '') => ({ track_date, track_content, track_location, track_kind });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body),
  { status, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...headers } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const ascii = (text: string) => [...new TextEncoder().encode(text)];

describe('Hualei numbers', () => {
  it('sends a number or reference as written, upper case and dashes included', () => {
    expect(normalizeHualeiNumber(' gz test-00001 ', 'GZYL')).toBe('GZTEST-00001');
    expect(normalizeHualeiNumber('SHOP-REF-0001', 'GZYL')).toBe('SHOP-REF-0001');
    // A comma would ask for several numbers at once.
    for (const raw of ['GZ1,GZ2', 'SHORT', 'A'.repeat(41), 'GZ.TEST.0001', 'GZ--TEST0001', '-GZTEST0001', 'GZTEST0001-', `${'A'.repeat(65)}`]) {
      expect(() => normalizeHualeiNumber(raw, 'GZYL'), raw).toThrow(InvalidInputError);
    }
  });
});

describe('Hualei track interface', () => {
  it('binds the record to the number asked in any of its own fields', () => {
    for (const asked of [NUMBER, 'SHOP-REF-0001', 'GZYL-TEST000001']) {
      expect(parseHualeiTrack(fixture('track'), asked, GZYL, READ_AT), asked).toMatchObject({ status: 'in_transit' });
    }
    // The tracking number is the order's own when the lookup used another.
    expect(parseHualeiTrack(fixture('track'), 'SHOP-REF-0001', GZYL, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
    expect(parseHualeiTrack(fixture('track'), NUMBER, GZYL, READ_AT)?.canonical_tracking_number).toBeUndefined();
    expect(() => parseHualeiTrack(fixture('track'), 'GZTEST00000009', GZYL, READ_AT)).toThrow(IndeterminateError);
    // A record that carries the number only in another field, or within one, is no answer; the error names the fields.
    const moved = fixture('track');
    Object.assign(moved[0].data[0], { trackingNumber: `${NUMBER}-1`, customerOrderNumber: NUMBER.toLowerCase() });
    expect(() => parseHualeiTrack(moved, NUMBER, GZYL, READ_AT))
      .toThrow(`GZYL answered with another shipment; its trackingNumber, customerOrderNumber holds the number`);
    // A child parcel's number, in its list.
    const child = fixture('track');
    Object.assign(child[0].data[0], { trackingNumber: 'GZTEST00000002', childrenTrackDetails: [{ trackingNumber: NUMBER }] });
    expect(() => parseHualeiTrack(child, NUMBER, GZYL, READ_AT))
      .toThrow(/^GZYL answered with another shipment; its childrenTrackDetails holds the number$/);
    // Otherwise the shapes of the record's own numbers, without their characters.
    expect(() => parseHualeiTrack(fixture('track'), 'GZTEST00000009', GZYL, READ_AT)).toThrow(new RegExp('^GZYL answered with another shipment; '
      + 'its numbers read trackingNumber A6D8, referenceNumber A7D4, business_seqinvoicecode A8D6$'));
    // Or a shorter form of it, eight characters or more.
    const shorter = fixture('track');
    Object.assign(shorter[0].data[0], { trackingNumber: 'OTHER0001', customerOrderNumber: NUMBER.slice(2, 10), referenceNumber: NUMBER.slice(0, 7) });
    expect(() => parseHualeiTrack(shorter, NUMBER, GZYL, READ_AT))
      .toThrow(/^GZYL answered with another shipment; its customerOrderNumber holds part of the number$/);
    // Two orders that share a reference are no answer.
    const shared = fixture('track');
    shared[0].data.push({ ...shared[0].data[0], trackingNumber: 'GZTEST00000002' });
    expect(() => parseHualeiTrack(shared, 'SHOP-REF-0001', GZYL, READ_AT)).toThrow('several shipments');
    // The same order twice is still one.
    const twice = fixture('track');
    twice[0].data.push(twice[0].data[0]);
    expect(parseHualeiTrack(twice, NUMBER, GZYL, READ_AT)?.events).toHaveLength(6);
  });

  it('tells its no-row answer from other refusals and from a changed reply', () => {
    expect(parseHualeiTrack(fixture('no-track'), NUMBER, GZYL, READ_AT)).toBeNull();
    // The answer for an empty number, and any other refusal, is no answer about the parcel.
    expect(() => parseHualeiTrack([{ ack: 'false', message: '单号为空，禁止查询轨迹' }], NUMBER, GZYL, READ_AT)).toThrow(IndeterminateError);
    for (const payload of [{}, [], [{ ack: 'true', data: [] }], [{ ack: 'true' }], [{ ack: true, data: [{}] }], fixture('track').concat(fixture('track')),
      edited((record) => { record.trackDetails = 'none'; }), edited((record) => { record.trackingNumber = 7; }),
      edited((record) => { record.trackDetails[0].track_date = '2026-03-01 24:00:00'; }),
      edited((record) => { record.trackDetails[0].track_date = '2026-02-30 10:00:00'; }),
      edited((record) => { record.trackDetails[0] = 'row'; })]) {
      expect(() => parseHualeiTrack(payload, NUMBER, GZYL, READ_AT), JSON.stringify(payload).slice(0, 80)).toThrow(SchemaError);
    }
  });

  it('holds back rows written ahead of the lookup on the trackers’ clock, and reads none of the parties', () => {
    const result = parseHualeiTrack(fixture('track'), NUMBER, GZYL, READ_AT)!;
    expect(result.events!.map((event) => event.time)).not.toContain('2026-03-06T15:10:42+08:00');
    expect(result).toMatchObject({ last_update: '2026-03-05T09:31:20+08:00', current_stage: 'customs' });
    // An hour later in Beijing, the row is due.
    expect(parseHualeiTrack(fixture('track'), NUMBER, GZYL, Date.parse('2026-03-06T07:11:00Z'))?.last_update).toBe('2026-03-06T15:10:42+08:00');
    // An order whose every row is ahead has nothing to show yet.
    expect(() => parseHualeiTrack(fixture('track'), NUMBER, GZYL, Date.parse('2026-03-01T12:00:00Z'))).toThrow(NoHistoryError);
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Example Street', 'Synthetic Shop', 'TEST01', '0.250', 'SHOP-REF-0001', 'GZYL-TEST000001', '转运中']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('reads a row the platform wrote again an hour off, after a clock change, once, as first written', () => {
    const airport = (record: Reply) => record.trackDetails.find((row: Reply) => row.track_content === 'Item arrives at destination airport');
    const rewritten = (written: string, clock = '2026-03-04 15:40:05') => edited((record) => {
      for (const row of record.trackDetails) row.track_createdate = row.track_date;
      record.trackDetails.unshift({ ...airport(record), track_date: clock, track_createdate: written });
    });
    const times = (payload: Reply) => parseHualeiTrack(payload, NUMBER, GZYL, READ_AT)!.events!
      .filter((event) => event.description === 'Item arrives at destination airport').map((event) => event.time);
    expect(times(rewritten('2026-03-05 20:00:00'))).toEqual(['2026-03-04T14:40:05+08:00']);
    // Written before the first, the copy is the one kept.
    expect(times(rewritten('2026-03-04 14:00:00'))).toEqual(['2026-03-04T15:40:05+08:00']);
    // Two hours off, or without the time it was written, it is another scan.
    expect(times(rewritten('2026-03-05 20:00:00', '2026-03-04 16:40:05'))).toHaveLength(2);
    expect(times(edited((record) => { record.trackDetails.unshift({ ...airport(record), track_date: '2026-03-04 15:40:05', track_createdate: '' }); }))).toHaveLength(2);
  });

  it('holds back a timeline written ahead: a row written well before its own clock is no scan', () => {
    // The order's whole script, written at its creation; the delivery's row came with the delivery.
    const script = (delivery?: string) => edited((record) => {
      for (const row of record.trackDetails) row.track_createdate = '2026-03-01 18:00:00';
      if (delivery) record.trackDetails.unshift({ ...record.trackDetails[0], track_content: 'Delivered', track_date: '2026-03-07 10:00:00', track_createdate: delivery });
    });
    const after = Date.parse('2026-03-10T00:00:00Z');
    // The first row, four hours after the order, is kept; the rest, a day and more ahead, are not.
    expect(parseHualeiTrack(script(), NUMBER, GZYL, after)?.events?.map((event) => event.description)).toEqual(['Order information received']);
    // Beside the rows kept, those written ahead are named too.
    expect(parseHualeiTrack(script(), NUMBER, GZYL, after)?.written_ahead).toEqual(expect.arrayContaining(['2026-03-06T15:10:42+08:00']));
    expect(parseHualeiTrack(fixture('track'), NUMBER, GZYL, after)).not.toHaveProperty('written_ahead');
    expect(parseHualeiTrack(script('2026-03-07 18:30:00'), NUMBER, GZYL, after)).toMatchObject({ current_stage: 'delivered',
      events: [expect.objectContaining({ description: 'Delivered' }), expect.objectContaining({ description: 'Order information received' })] });
    // A destination clock up to twelve hours ahead of the platform's is still a scan written as it happened.
    expect(parseHualeiTrack(script('2026-03-06 22:00:00'), NUMBER, GZYL, after)).toMatchObject({ current_stage: 'delivered' });
    expect(parseHualeiTrack(script('2026-03-02 10:00:00'), NUMBER, GZYL, after)).toMatchObject({ current_stage: 'registered' });
    // An order whose every row was written ahead names their clocks, so that a provider's copies of them are no scans either.
    const scripted = edited((record) => { for (const row of record.trackDetails) row.track_createdate = '2026-03-01 08:00:00'; });
    expect(() => parseHualeiTrack(scripted, NUMBER, GZYL, after)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'written_ahead',
      writtenAhead: expect.arrayContaining(['2026-03-01T22:36:51+08:00', '2026-03-06T15:10:42+08:00']) }));
    expect(() => parseHualeiTrack(scripted, NUMBER, { ...GZYL, wallClocks: true }, after)).toThrow(expect.objectContaining({
      writtenAhead: expect.arrayContaining(['2026-03-01T22:36:51']) }));
    expect(() => parseHualeiTrack(fixture('track'), NUMBER, GZYL, Date.parse('2026-03-01T12:00:00Z'))).toThrow(expect.objectContaining({ writtenAhead: undefined }));
    // A creation time it cannot read is no evidence either way.
    for (const unread of ['soon', 7, null]) {
      expect(parseHualeiTrack(edited((record) => { for (const row of record.trackDetails) row.track_createdate = unread; }), NUMBER, GZYL, after)?.events).toHaveLength(7);
    }
  });

  it('keeps when the platform wrote each row, which only the track interface says', () => {
    const late = edited((record) => { for (const row of record.trackDetails) row.track_createdate = '2026-03-05 18:00:00'; });
    const events = parseHualeiTrack(late, NUMBER, GZYL, READ_AT)!.events!;
    expect(events.map((event) => event.written_at)).toEqual(events.map(() => '2026-03-05T18:00:00+08:00'));
    // A creation time it cannot read, or the page, which shows none, leaves the scans without one.
    const unread = edited((record) => { for (const row of record.trackDetails) row.track_createdate = 'soon'; });
    expect(parseHualeiTrack(unread, NUMBER, GZYL, READ_AT)!.events!.some((event) => 'written_at' in event)).toBe(false);
    expect(parseHualeiPage(page('page'), NUMBER, GZYL, READ_AT).events!.some((event) => 'written_at' in event)).toBe(false);
  });

  it('counts identical rows once, keeps the reply’s order on one clock, and bounds the history', () => {
    const repeated = edited((record) => {
      record.trackDetails = [row('2026-03-03 10:00:00', 'Second'), row('2026-03-03 10:00:00', 'First'), row('2026-03-03 10:00:00', 'Second')];
    });
    expect(parseHualeiTrack(repeated, NUMBER, GZYL, READ_AT)?.events?.map((event) => event.description)).toEqual(['Second', 'First']);
    const long = edited((record) => {
      record.trackDetails = Array.from({ length: 120 }, (_, index) => row(`2026-03-0${1 + Math.floor(index / 60)} 10:${String(index % 60).padStart(2, '0')}:00`, `Row ${index}`));
    });
    const result = parseHualeiTrack(long, NUMBER, GZYL, READ_AT)!;
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
    expect(() => parseHualeiTrack(edited((record) => { record.trackDetails = Array.from({ length: 501 }, () => row('2026-03-01 10:00:00', 'Row')); }),
      NUMBER, GZYL, READ_AT)).toThrow(SchemaError);
  });

  it('reads each row on the clock its tenant gives it, and counts a row the tenant says repeats another once', () => {
    const tenant = {
      ...GZYL, repeats: (wording: string, other: string) => wording.endsWith(`, ${other}`),
      clock: ({ clock }: HualeiRow) => (clock.endsWith(' 00:00:00') ? 'day' as const : clock.endsWith(':00') ? 'wall' as const : 'platform' as const),
    };
    const rows = edited((record) => {
      record.trackDetails = [row('2026-03-05 00:00:00', 'Moving'), row('2026-03-04 21:07:00', 'Group, Arrived', 'HUB'),
        row('2026-03-04 21:07:00', 'Arrived', 'HUB'), row('2026-03-04 21:07:00', 'Group, Arrived', 'OTHER HUB'), row('2026-03-03 10:15:42', 'Departed', 'ORIGIN')];
    });
    expect(parseHualeiTrack(rows, NUMBER, tenant, READ_AT)?.events?.map(({ time, local_time, description, location }) => [time ?? local_time, description, location]))
      .toEqual([['2026-03-05', 'Moving', undefined], ['2026-03-04T21:07:00', 'Arrived', 'HUB'], ['2026-03-04T21:07:00', 'Group, Arrived', 'OTHER HUB'],
        ['2026-03-03T10:15:42+08:00', 'Departed', 'ORIGIN']]);
    // Without them, every row is on the platform's clock and each wording stands.
    expect(parseHualeiTrack(rows, NUMBER, GZYL, READ_AT)?.events?.map(({ time, description }) => [time, description])).toEqual([
      ['2026-03-05T00:00:00+08:00', 'Moving'], ['2026-03-04T21:07:00+08:00', 'Group, Arrived'], ['2026-03-04T21:07:00+08:00', 'Arrived'],
      ['2026-03-04T21:07:00+08:00', 'Group, Arrived'], ['2026-03-03T10:15:42+08:00', 'Departed']]);
  });

  it('keeps no postcode or signatory in scan text', () => {
    expect(hualeiScanText('Arrived at EXAMPLETOWN 0000 hub, signed by Synthetic Clerk')).toBe('Arrived at EXAMPLETOWN hub');
    expect(hualeiScanText('已签收，签收人：测试')).toBe('已签收');
    expect(hualeiScanText('EXAMPLETOWN, 75001')).toBe('EXAMPLETOWN');
    // A space GBK could not carry arrives as a question mark between two words.
    expect(hualeiScanText('Customs?clearance?completed')).toBe('Customs clearance completed');
    expect(hualeiScanText('Where is it? Arrived')).toBe('Where is it? Arrived');
    // Longer runs, codes and clocks are not postcodes.
    expect(hualeiScanText('Flight CA123 at 10:30, bag 1234567')).toBe('Flight CA123 at 10:30, bag 1234567');
    // Nor is a date's year.
    for (const text of ['Expected on 2026-10-24', 'Delivered on 24/10/2026 at 10:00', 'Delivered at 11:55 am on March 10, 2026 in EXAMPLETOWN']) {
      expect(hualeiScanText(text), text).toBe(text);
    }
    expect(hualeiScanText('Delivered on 24.10.2026 in EXAMPLETOWN 99999')).toBe('Delivered on 24.10.2026 in EXAMPLETOWN');
    expect(hualeiScanText('Delivered Dec 5 2026 in EXAMPLETOWN 9999')).toBe('Delivered Dec 5 2026 in EXAMPLETOWN');
    expect(hualeiScanText('Delivered EXAMPLETOWN 13, 99999')).toBe('Delivered EXAMPLETOWN 13');
    // A delivery row's place written with a postcode of another form.
    for (const place of ['EXAMPLETOWN 999 99', 'EXAMPLETOWN 99-999', 'EXAMPLETOWN 9999-999', 'EXAMPLETOWN Z9Z 9Z9', 'EXAMPLETOWN ZZ9 9ZZ', 'EXAMPLETOWN 9999 ZZ']) {
      expect(hualeiScanText(place), place).toBe('EXAMPLETOWN');
    }
    expect(hualeiScanText('Z9Z9Z9')).toBe('');
    // With its country's letters before it, or in brackets after the town.
    for (const place of ['ZZ-9999 EXAMPLETOWN', 'Z-99999 EXAMPLETOWN', 'ZZ-9999 ZZ EXAMPLETOWN', 'ZZ-99-999 EXAMPLETOWN', 'EXAMPLETOWN(9999)', 'EXAMPLETOWN （99999）']) {
      expect(hualeiScanText(place), place).toBe('EXAMPLETOWN');
    }
  });

  it('keeps no markup in scan text', () => {
    // DHL's row as JRT copies it, its link escaped, and as a page shows it.
    const failed = 'The shipment could not be delivered. Please find more information here.';
    expect(hualeiScanText('The shipment could not be delivered. Please find more information&lt;a href=https://www.example.com/help.html#not-delivered&gt; here.&lt;/a&gt;'))
      .toBe(failed);
    expect(hualeiScanText('The shipment could not be delivered. Please find more information<a href="https://www.example.com/help.html"> here.</a>'))
      .toBe(failed);
    expect(hualeiScanText('Handed to A &amp; B Logistics')).toBe('Handed to A & B Logistics');
    expect(hualeiScanText('Weight <2 kg, 3 > 2')).toBe('Weight <2 kg, 3 > 2');
  });

  it('lets a delivery row stored with a postcode in its place take the place without it, or none', () => {
    const policy = sameInstantIdentityPolicy('gzyl', { supportsScanMatching: true });
    const stored = { stage: 'delivered', description: 'Delivered', location: 'EXAMPLETOWN 99-999', providerCode: '' };
    expect(policy?.matches?.({ ...stored, location: 'EXAMPLETOWN' }, stored)).toBe(true);
    expect(policy?.matches?.({ ...stored, location: '' }, { ...stored, location: 'Z9Z9Z9' })).toBe(true);
    expect(policy?.matches?.({ ...stored, location: 'OTHERTOWN' }, stored)).toBe(false);
    expect(policy?.matches?.({ ...stored, location: '' }, { ...stored, location: 'EXAMPLETOWN' })).toBe(false);
  });
});

describe('Hualei delivery partners', () => {
  const SWISS = 'RR123456785CH';
  const handedOver = (label: string, transfer: string, country = 'CH') => edited((record) => {
    record.channel_name = label;
    record.business_channeltransfercode = transfer;
    record.consigneeCountry = country;
  });

  it('names a partner only for a label the table holds, a number its detection offers and a destination it serves', () => {
    for (const label of ['Swiss Post', 'SWISS  POST', 'swisspost', 'Post CH', '瑞士邮政']) expect(hualeiPartner(label, SWISS, 'CH'), label).toBe('swiss-post');
    expect(hualeiPartner('Swiss Post', SWISS)).toBe('swiss-post');
    expect(hualeiPartner('Swiss Express Line', SWISS, 'CH')).toBeUndefined();
    expect(hualeiPartner('Swiss Post', 'GZTEST00000001', 'CH')).toBeUndefined();
    expect(hualeiPartner('Swiss Post', SWISS, 'DE')).toBeUndefined();
  });

  it('hands the parcel to the delivery carrier under the channel’s transfer number', () => {
    const result = parseHualeiTrack(handedOver('Swiss Post', SWISS), NUMBER, GZYL, READ_AT)!;
    expect(result).toMatchObject({ delivery_carrier: 'swiss-post', delivery_tracking_number: SWISS, destination_country: 'CH' });
    expect(deliveryHandoff('gzyl', NUMBER, result)).toEqual({ carrier: 'swiss-post', number: SWISS, basis: 'partner' });
    // The transfer number also finds the order; asked for it, the partner is named alone.
    const asked = parseHualeiTrack(handedOver('Swiss Post', SWISS), SWISS, GZYL, READ_AT)!;
    expect(asked).toMatchObject({ delivery_carrier: 'swiss-post', canonical_tracking_number: NUMBER });
    expect(asked.delivery_tracking_number).toBeUndefined();
    for (const payload of [handedOver('Swiss Express Line', SWISS), handedOver('Swiss Post', 'ZZ000000001'), handedOver('Swiss Post', SWISS, 'DE'),
      handedOver('', SWISS)]) {
      const other = parseHualeiTrack(payload, NUMBER, GZYL, READ_AT)!;
      expect(other.delivery_carrier).toBeUndefined();
      expect(other.delivery_tracking_number).toBeUndefined();
    }
  });

  it('takes a tracking number the line filled with the partner’s number as the hand-off, not as the order’s own', () => {
    const payload = edited((record) => {
      record.channel_name = '瑞士邮政';
      record.trackingNumber = SWISS;
    });
    const result = parseHualeiTrack(payload, 'SHOP-REF-0001', GZYL, READ_AT)!;
    expect(result).toMatchObject({ delivery_carrier: 'swiss-post', delivery_tracking_number: SWISS });
    expect(result.canonical_tracking_number).toBeUndefined();
  });
});

describe('Hualei tracking page', () => {
  it('reads the waybill bound to the number without its recipient', () => {
    const result = parseHualeiPage(page('page'), NUMBER, GZYL, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', destination_country: 'CH', last_update: '2026-03-05T09:31:20+08:00' });
    expect(result.service_name).toBeUndefined();
    expect(result.events!.map((event) => [event.description, event.location ?? null])).toEqual([
      ['local carrier Agent Import customs clearance', null],
      ['Arrived at EXAMPLETOWN hub', 'EXAMPLETOWN'],
      ['Order information received', null],
    ]);
    expect(parseHualeiPage(page('page'), 'SHOP-REF-0001', GZYL, READ_AT).canonical_tracking_number).toBe(NUMBER);
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Synthetic Clerk', '0000', 'SHOP-REF-0001']) expect(text, value).not.toContain(value);
  });

  it('reads the answer for an unknown number as not found, and anything else unbound as inconclusive', () => {
    expect(() => parseHualeiPage(page('page-unknown'), 'NOTFOUND000001', GZYL, READ_AT)).toThrow(NotFoundError);
    // The same layout echoing another number is no answer about this one.
    expect(() => parseHualeiPage(page('page-unknown'), 'NOTFOUND000009', GZYL, READ_AT)).toThrow(IndeterminateError);
    expect(() => parseHualeiPage(page('page'), 'GZTEST00000009', GZYL, READ_AT)).toThrow(IndeterminateError);
    const twice = page('page').replace(/(<div class="div_cont">[\s\S]*?)(\s*<\/div>\s*<!--查看附件-->)/, '$1$1$2');
    expect(() => parseHualeiPage(twice, NUMBER, GZYL, READ_AT)).toThrow(IndeterminateError);
    expect(() => parseHualeiPage('<html><body><div class="div_canta"></div></body></html>', NUMBER, GZYL, READ_AT)).toThrow(SchemaError);
    expect(() => parseHualeiPage(page('page').replace('<li class="div_li3 abc">收件人</li>', ''), NUMBER, GZYL, READ_AT)).toThrow(SchemaError);
  });
});

describe('Hualei tracker', () => {
  const tracker = (fetcher: typeof fetch) => new HualeiTracker(GZYL, { fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' });

  it('decodes the track interface’s GBK reply', async () => {
    // [{"ack":"true","data":[{"trackingNumber":"GZTEST00000001","trackDetails":[{"track_date":"2020-01-02 10:00:00","track_content":"货物离开操作中心"}]}]}]
    const body = new Uint8Array([
      ...ascii('[{"ack":"true","data":[{"trackingNumber":"GZTEST00000001","trackDetails":[{"track_date":"2020-01-02 10:00:00","track_content":"'),
      0xbb, 0xf5, 0xce, 0xef, 0xc0, 0xeb, 0xbf, 0xaa, 0xb2, 0xd9, 0xd7, 0xf7, 0xd6, 0xd0, 0xd0, 0xc4,
      ...ascii('"}]}]}]'),
    ]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html;charset=GBK' } }));
    await expect(tracker(fetcher).fetch(NUMBER)).resolves.toMatchObject({ last_status_text: '货物离开操作中心' });
    // Its no-row answer in GBK sends the page.
    const noTrack = new Uint8Array([...ascii('[{"ack":"false","message":"'), 0xce, 0xb4, 0xb2, 0xe9, 0xd1, 0xaf, 0xb5, 0xbd, 0xb9, 0xec, 0xbc, 0xa3, ...ascii('"}]')]);
    const paged = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(noTrack, { headers: { 'Content-Type': 'text/html;charset=GBK' } }))
      .mockResolvedValueOnce(html(page('page-unknown')));
    await expect(tracker(paged).fetch('NOTFOUND000001')).rejects.toBeInstanceOf(NotFoundError);
    expect(paged).toHaveBeenCalledTimes(2);
  });

  it('asks the page with the form’s field when the interface has no row', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(tracker(fetcher).fetch('notfound000001', { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('http://134.175.243.207:8082/trackIndex.htm');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe('documentCode=NOTFOUND000001');
  });

  it('keeps refusals, blocks, changed replies and network failures apart', async () => {
    const once = (response: Response) => tracker(vi.fn<typeof fetch>().mockResolvedValue(response)).fetch(NUMBER);
    await expect(once(json({}, 429, { 'Retry-After': '30' }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(once(new Response('', { status: 302, headers: { Location: '/login.htm' } }))).rejects.toBeInstanceOf(TransportError);
    await expect(once(html('Not Found', 404))).rejects.toBeInstanceOf(TransportError);
    await expect(once(html('<html><head><title>Just a moment...</title></head></html>'))).rejects.toBeInstanceOf(ChallengeError);
    await expect(once(html('<html><head><title>安全验证</title></head></html>'))).rejects.toBeInstanceOf(ChallengeError);
    await expect(once(html('<html><body>Service Unavailable</body></html>'))).rejects.toBeInstanceOf(SchemaError);
    // A page in place of the results is a block when it is one, else a changed page.
    const paged = (body: string) => tracker(vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(body))).fetch(NUMBER);
    await expect(paged('<html><head><title>验证码</title></head></html>')).rejects.toBeInstanceOf(ChallengeError);
    await expect(paged('<html><body>login</body></html>')).rejects.toBeInstanceOf(SchemaError);
    await expect(tracker(vi.fn<typeof fetch>()).fetch('GZ,TEST0001')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('sends a read that fails to reach the tracker once more, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(fixture('track')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HualeiTracker(GZYL, { fetcher, recorder }).fetch(NUMBER, { budgetMs: 4000 })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step.mock.calls.map(([record]) => [record.step, record.outcome])).toEqual([['direct', 'transport'], ['retry', 'ok']]);
  });
});

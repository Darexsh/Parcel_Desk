import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, UniuniTracker } from './adapter.js';
import { normalizeUniuniNumber, normalizeUniuniRecognitionNumber, parseUniuni } from './parser.js';
import { uniuniStatus } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { detectCarrierMatch } from '../../core/detection/index.js';

const NUMBER = 'UUS0000000000000001';
const OTHER = 'UUS0000000000000002';
const UUSC_NUMBER = 'UUSC000000000001';
const U9999_NUMBER = 'U999900000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const uuscFixture = () => JSON.parse(readFileSync(new URL('./fixtures/uusc-delivered.json', import.meta.url), 'utf8'));

describe('UniUni confirmed parcel formats', () => {
  const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
  const uuscRule = metadata.detection.find((rule: { id: string }) => rule.id === 'uniuni-3');

  it('detects the complete UUSC numeric reference without broadening adjacent formats', () => {
    expect(uuscRule.confidence).toBe('high');
    expect(new RegExp(uuscRule.pattern).test(UUSC_NUMBER)).toBe(true);
    expect(normalizeUniuniRecognitionNumber('uusc-000000 000001')).toBe(UUSC_NUMBER);
    for (const number of ['UUSC00000000001', 'UUSC0000000000001', 'UUSX000000000001', 'UUSC00000000000A',
      `X${UUSC_NUMBER}`, `${UUSC_NUMBER}X`]) {
      expect(new RegExp(uuscRule.pattern).test(number), number).toBe(false);
      expect(() => normalizeUniuniRecognitionNumber(number), number).toThrow(InvalidInputError);
    }
    expect(normalizeUniuniRecognitionNumber(NUMBER)).toBe(NUMBER);
    expect(normalizeUniuniRecognitionNumber('4C000000001US')).toBe('4C000000001US');
  });

  it('claims the U9999 numeric reference and only suggests other U and fifteen-digit references', () => {
    const rule = metadata.detection.find((candidate: { id: string }) => candidate.id === 'uniuni-4');
    const suggestion = metadata.detection.find((candidate: { id: string }) => candidate.id === 'uniuni-5');
    expect(rule.confidence).toBe('high');
    expect(suggestion.confidence).toBe('low');
    expect(new RegExp(rule.pattern).test(U9999_NUMBER)).toBe(true);
    expect(new RegExp(suggestion.pattern).test(U9999_NUMBER)).toBe(false);
    expect(normalizeUniuniRecognitionNumber('u9999-00000 000001')).toBe(U9999_NUMBER);
    expect(new RegExp(rule.pattern).test('U999800000000001')).toBe(false);
    expect(new RegExp(suggestion.pattern).test('U999800000000001')).toBe(true);
    expect(normalizeUniuniRecognitionNumber('U000100000000001')).toBe('U000100000000001');
    for (const number of ['U99990000000001', 'U9999000000000001', 'U99990000000000A', `X${U9999_NUMBER}`]) {
      expect(new RegExp(rule.pattern).test(number), number).toBe(false);
      expect(new RegExp(suggestion.pattern).test(number), number).toBe(false);
      expect(() => normalizeUniuniRecognitionNumber(number), number).toThrow(InvalidInputError);
    }
  });

  it('claims the UR tracking IDs of its seller platform, not its URB batch IDs', () => {
    const rule = metadata.detection.find((candidate: { id: string }) => candidate.id === 'uniuni-9');
    expect(rule.confidence).toBe('high');
    expect(detectCarrierMatch('UR00000000000000001')).toMatchObject({ carrier: 'uniuni', confidence: 'high' });
    expect(normalizeUniuniRecognitionNumber('ur-00000000 000000001')).toBe('UR00000000000000001');
    for (const number of ['URB0000000000000001', 'UR0000000000000001', 'UR000000000000000001', 'UR0000000000000000A']) {
      expect(new RegExp(rule.pattern).test(number), number).toBe(false);
      expect(detectCarrierMatch(number).candidates, number).not.toContain('uniuni');
      expect(() => normalizeUniuniRecognitionNumber(number), number).toThrow(InvalidInputError);
    }
  });

  it('keeps full identity-bound history for the compact format', () => {
    const result = normalizeCarrierResult(parseUniuni(uuscFixture(), UUSC_NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: result.last_update });
    expect(result.events).toHaveLength(6);
    const wrong = uuscFixture(); wrong.data.valid_tno[0].tno = 'UUSC000000000002';
    expect(() => parseUniuni(wrong, UUSC_NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('UniUni parcel history', () => {
  it('binds the parcel and uses corrected seconds, excluding private detail and day estimates', () => {
    const result = normalizeCarrierResult(parseUniuni(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_update: '2026-01-05T22:00:00Z', delivered_at: '2026-01-05T22:00:00Z', expected_delivery: null });
    expect(result.events).toHaveLength(9);
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', provider_code: '203', location: 'Example City, EX', time: result.last_update });
    expect(result.events?.[2]).toMatchObject({ stage: 'failed_attempt', description: 'Failed delivery attempt, returning to the warehouse' });
    expect(result.events?.at(-1)).toMatchObject({ stage: 'registered', time: '2026-01-01T14:30:00Z' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|pathTime|latitude|longitude|operator|estimate_time|second_delivery/);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    const evidence: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.some(scan => scan.location)),
      delivered_at: Boolean(result.delivered_at) };
    // An estimate belongs to the separate active-parcel fixture.
    for (const capability of metadata.capabilities.filter((value: string) => value !== 'eta')) expect(evidence[capability], capability).toBe(true);
  });

  it('keeps a partner courier\'s scans after a handover and a Uni Store drop-off', () => {
    const value = fixture(); const item = value.data.valid_tno[0]; const scans = item.spath_list;
    item.country = 'CA';
    scans.splice(1, 0, { pathInfo: 'Parcel dropped off at Uni Store', pathAddress: 'PRIVATE_SYNTHETIC_STORE',
      dateTime: { localTime: '2026-01-01 09:00:00', timestamp: '', timezone: 'America/Toronto' } });
    scans.push({ pathInfo: 'Delivered to your community mailbox, parcel locker or apt./condo mailbox', pathAddress: 'PRIVATE_SYNTHETIC_ADDRESS',
      state: 203, city: 'Example City', province: 'EX', dateTime: { timezone: 'America/Vancouver', localTime: '2026-01-06 11:48:30' } });
    const result = normalizeCarrierResult(parseUniuni(value, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-01-06T11:48:30', destination_country: 'CA' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered to your community mailbox, parcel locker or apt./condo mailbox',
      provider_code: '203', stage: 'delivered', location: 'Example City, EX', local_time: '2026-01-06T11:48:30' });
    const dropOff = result.events?.find(scan => scan.description === 'Parcel dropped off at Uni Store');
    expect(dropOff).toMatchObject({ local_time: '2026-01-01T09:00:00', stage: 'accepted' });
    expect(dropOff).not.toHaveProperty('provider_code');
    const dropped = fixture(); dropped.data.valid_tno[0].spath_list.splice(1);
    dropped.data.valid_tno[0].spath_list.push(scans[1]);
    expect(parseUniuni(dropped, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Parcel dropped off at Uni Store' });
    expect(uniuniStatus(204)).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    for (const change of [{ state: '203' }, { state: -1 }, { pathInfo: '' }, { code: 'Delivered' }, { description_en: '' }]) {
      const broken = fixture(); broken.data.valid_tno[0].spath_list.push({ ...scans.at(-1), ...change });
      expect(() => parseUniuni(broken, NUMBER), JSON.stringify(change)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    item.country = 'MX';
    expect(parseUniuni(value, NUMBER)).not.toHaveProperty('destination_country');
  });

  it('reads code 202 on cross-border shipper scans by their wording', () => {
    const reference = 'ZZ00CAA0U000000001';
    const scan = (pathInfo: string, state: number, localTime: string) => ({ pathInfo, pathAddress: 'PRIVATE_SYNTHETIC_ADDRESS', state,
      city: 'Example City', province: 'EX', dateTime: { timezone: 'America/Toronto', localTime } });
    const scans = [
      scan('Shipping information received. Your parcel is on its way to UniUni for delivery to you', 202, '2026-01-01 09:00:00'),
      scan('Parcel received by UniUni', 202, '2026-01-04 18:00:00'),
      scan('Your parcel has been assigned to a delivery driver', 202, '2026-01-05 07:00:00'),
      scan('Out for delivery', 202, '2026-01-05 08:00:00'),
      scan('Delivered', 203, '2026-01-05 12:00:00'),
    ];
    const reply = (count: number) => ({ status: 'SUCCESS', data: { invalid_tno: '',
      valid_tno: [{ tno: reference, urlType: 'ltian', state: count === scans.length ? 203 : 202, spath_list: scans.slice(0, count) }] } });
    expect(parseUniuni(reply(1), reference)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: scans[0]!.pathInfo, last_update_local: '2026-01-01T09:00:00' });
    expect(parseUniuni(reply(3), reference)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(parseUniuni(reply(4), reference)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    const delivered = parseUniuni(reply(5), reference);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(delivered.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit']);
    expect(JSON.stringify(delivered)).not.toContain('PRIVATE');
  });

  it('never falls back to a mismatching first parcel or merges ambiguous identities', () => {
    const wrong = fixture(); wrong.data.valid_tno[0].tno = OTHER;
    const duplicate = fixture(); duplicate.data.valid_tno.push(duplicate.data.valid_tno[0]);
    const conflicting = fixture(); conflicting.data.invalid_tno = NUMBER;
    for (const value of [null, {}, { status: 'SUCCESS' }, wrong, duplicate, conflicting]) {
      expect(() => parseUniuni(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('requires the exact observed negative signature and leaves empty or failed lookups inconclusive', () => {
    const negative = { status: 'SUCCESS', err_code: 1, data: { invalid_tno: NUMBER, valid_tno: [] } };
    expect(() => parseUniuni(negative, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const invalid of [OTHER, `${NUMBER},${OTHER}`]) {
      expect(() => parseUniuni({ ...negative, data: { ...negative.data, invalid_tno: invalid } }, NUMBER))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseUniuni({ ...negative, data: { invalid_tno: '', valid_tno: [] } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUniuni({ status: 'ERROR', ret_msg: 'Unknown key', data: negative.data }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([true, 1, '1'])('rejects master shipments with marker %s instead of completing unfinished pieces', is_master => {
    const value = fixture(); value.data.valid_tno[0].is_master = is_master;
    expect(() => parseUniuni(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([false, 0, '0', null, undefined])('accepts explicit non-master marker %s', is_master => {
    const value = fixture(); value.data.valid_tno[0].is_master = is_master;
    expect(parseUniuni(value, NUMBER).status).toBe('delivered');
  });

  it.each(['true', 'false', 2, -1, {}, []])('rejects unrecognized master marker %s', is_master => {
    const value = fixture(); value.data.valid_tno[0].is_master = is_master;
    expect(() => parseUniuni(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects master/piece envelopes and malformed or excessive histories', () => {
    const master = fixture(); master.data.valid_tno[0].master_tno = NUMBER;
    const pieces = fixture(); pieces.data.valid_tno[0].orders_list = [{ tno: OTHER, state: 200 }];
    for (const value of [master, pieces]) expect(() => parseUniuni(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const row of [null, {}, { ...fixture().data.valid_tno[0].spath_list[0], description_en: '' }]) {
      const value = fixture(); value.data.valid_tno[0].spath_list[0] = row;
      expect(() => parseUniuni(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = fixture(); empty.data.valid_tno[0].spath_list = [];
    expect(() => parseUniuni(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const excessive = fixture(); excessive.data.valid_tno[0].spath_list = Array(501).fill(excessive.data.valid_tno[0].spath_list[0]);
    expect(() => parseUniuni(excessive, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it("dates a scan without corrected seconds on the zone UniUni names when its province keeps that clock", () => {
    // Live shapes: a cross-border shipper's rows name a zone and no corrected seconds;
    // the zone can be another country's, and the first row names no province.
    const reference = 'ZZ00CAA0U000000001';
    const scan = (pathInfo: string, province: string, timezone: string, localTime: string) => ({ pathInfo,
      pathAddress: 'PRIVATE_SYNTHETIC_ADDRESS', state: 202, city: 'Example City', province, dateTime: { timezone, localTime } });
    const reply = (...spath_list: object[]) => ({ status: 'SUCCESS', data: { invalid_tno: '',
      valid_tno: [{ tno: reference, urlType: 'ltian', state: 202, spath_list }] } });
    const info = scan('Shipping information received. Your parcel is on its way to UniUni for delivery to you', '', 'Asia/Krasnoyarsk', '2026-01-01 00:48:44');
    const received = scan('Parcel received by UniUni', 'ON', 'America/New_York', '2026-01-04 13:17:48');
    const result = parseUniuni(reply(info, received), reference, new Date('2026-01-05T00:00:00Z'));
    expect(result).toMatchObject({ last_update: '2026-01-04T13:17:48-05:00', last_update_local: null });
    expect(result.events?.map(({ time, local_time }) => time ?? local_time)).toEqual(['2026-01-04T13:17:48-05:00', '2026-01-01T00:48:44']);
    // London for Quebec is no clock of the place; a reading after the lookup, or after a newer scan's instant, does not stand.
    expect(parseUniuni(reply(info, { ...received, province: 'QC', dateTime: { timezone: 'Europe/London', localTime: '2026-01-04 13:17:48' } }),
      reference, new Date('2026-01-05T00:00:00Z')).events?.[0]).toMatchObject({ local_time: '2026-01-04T13:17:48' });
    expect(parseUniuni(reply(info, received), reference, new Date('2026-01-04T12:00:00Z')).events?.[0]).not.toHaveProperty('time');
    const newer = { ...scan('Delivered', 'ON', 'America/Toronto', '2026-01-04 13:00:00'), state: 203, dateTime: { ts: 1767549600 } };
    expect(parseUniuni(reply(info, received, newer), reference, new Date('2026-01-05T00:00:00Z')).events?.[1])
      .toMatchObject({ local_time: '2026-01-04T13:17:48' });
  });

  it('preserves an incomplete newest clock without borrowing local-encoded pathTime or an older delivery', () => {
    const value = fixture(); const latest = value.data.valid_tno[0].spath_list.at(-1);
    delete latest.dateTime.ts;
    const result = normalizeCarrierResult(parseUniuni(value, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-05T16:00:00' });
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-01-05T16:00:00' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result).not.toHaveProperty('delivered_at');
    latest.dateTime.localTime = '2026-02-30 16:00:00';
    expect(parseUniuni(value, NUMBER).events?.[0]).toMatchObject({ provider_time_text: '2026-02-30 16:00:00' });
    delete latest.dateTime;
    expect(parseUniuni(value, NUMBER).events?.[0]).not.toHaveProperty('time');
  });

  it.each([0, -1, 1760000000000, 1.2, '1767646800', Number.NaN])('rejects invalid corrected seconds %s', ts => {
    const value = fixture(); value.data.valid_tno[0].spath_list.at(-1).dateTime.ts = ts;
    expect(() => parseUniuni(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['2026-01-05 24:00:00', '2026-02-30 16:00:00'])('retains impossible local digits %s without calendar rollover', localTime => {
    const value = uuscFixture(), latest = value.data.valid_tno[0].spath_list.at(-1);
    latest.dateTime = { localTime };
    const result = parseUniuni(value, UUSC_NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: null });
    expect(result.events?.[0]).toMatchObject({ provider_time_text: localTime });
    expect(result.events?.[0]).not.toHaveProperty('local_time');
    expect(result).not.toHaveProperty('delivered_at');
  });

  it.each(['clock', 1, [], { localTime: 123 }])('rejects malformed latest clock envelopes %s', dateTime => {
    const value = uuscFixture(); value.data.valid_tno[0].spath_list.at(-1).dateTime = dateTime;
    expect(() => parseUniuni(value, UUSC_NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the actual latest scan instead of a terminal summary and keeps failed attempts nonterminal', () => {
    const value = fixture(); value.data.valid_tno[0].spath_list.pop();
    expect(parseUniuni(value, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    value.data.valid_tno[0].spath_list.pop();
    expect(parseUniuni(value, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(uniuniStatus(217)).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(uniuniStatus(230)).toEqual({ status: 'exception', stage: 'returned' });
    expect(uniuniStatus(99999)).toBeUndefined();
  });

  it('keeps unknown and equal-time scans in provider order, deduplicating and bounding output', () => {
    const value = fixture(); const latest = value.data.valid_tno[0].spath_list.at(-1);
    value.data.valid_tno[0].spath_list.push({ ...latest, state: 99999, description_en: 'Awaiting review' });
    const unknown = parseUniuni(value, NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Awaiting review' });
    expect(unknown.events?.[0]).not.toHaveProperty('stage');
    expect(unknown.events?.[1]!.description).toBe('Delivered');
    value.data.valid_tno[0].spath_list.push(latest);
    expect(parseUniuni(value, NUMBER).events).toHaveLength(10);
    for (let i = 0; i < 110; i++) value.data.valid_tno[0].spath_list.push({ ...latest, city: `Example City ${i}` });
    expect(parseUniuni(value, NUMBER).events).toHaveLength(100);
  });
});

describe('UniUni direct retrieval', () => {
  it('probes normalized compact references and rejects neighboring shapes before I/O', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(uuscFixture()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.recognize!('uusc-000000 000001')).resolves.toEqual({ known: true, lastActivityAt: '2026-01-05T22:00:00.000Z' });
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('id')).toBe(UUSC_NUMBER);
    await expect(instance.recognize!('UUSC00000000000A')).resolves.toEqual({ known: false });
    await expect(instance.recognize!('UUSC00000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('probes normalized U9999 references against the exact returned parcel', async () => {
    const value = uuscFixture(); value.data.valid_tno[0].tno = U9999_NUMBER;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.recognize!('u9999 00000000001')).resolves.toEqual({ known: true, lastActivityAt: '2026-01-05T22:00:00.000Z' });
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('id')).toBe(U9999_NUMBER);
  });

  it('probes cross-border shipper references in their CAA0, USA0 and JY layouts, and answers their exact absence', async () => {
    const reference = 'ZZ00CAA0Z000000001';
    const value = uuscFixture(); value.data.valid_tno[0].tno = reference;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(value))
      .mockResolvedValueOnce(Response.json({ status: 'SUCCESS', data: { invalid_tno: reference, valid_tno: [] } }));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.recognize!('zz00-caa0 z000000001')).resolves.toEqual({ known: true, lastActivityAt: '2026-01-05T22:00:00.000Z' });
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('id')).toBe(reference);
    expect(normalizeUniuniRecognitionNumber('ZZ00USA0Z000000001')).toBe('ZZ00USA0Z000000001');
    expect(normalizeUniuniRecognitionNumber('jy00-ca00 a000000001')).toBe('JY00CA00A000000001');
    await expect(instance.recognize!(reference)).resolves.toEqual({ known: false });
    for (const number of ['ZZ00CAA1Z000000001', 'ZZ00CAA0Z00000001', 'Z100CAA0Z000000001', 'ZZ00CAA00000000001', 'ZZ00UKA0Z000000001',
      'ZZ00CA00A000000001', 'JY00CA00Z000000001']) {
      expect(() => normalizeUniuniRecognitionNumber(number), number).toThrow(InvalidInputError);
      await expect(instance.recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes only supported formats, exact absence and dated activity while preserving uncertain failures', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    for (const number of ['123', 'TRACKING000000001', 'YT0000000000000000', 'UR0000000000000000']) {
      await expect(instance.recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(fixture())));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-05T22:00:00.000Z' });
    const local = fixture();
    for (const scan of local.data.valid_tno[0].spath_list) delete scan.dateTime.ts;
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(local)));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-05T16:00:00' });
    const negative = { status: 'SUCCESS', data: { invalid_tno: NUMBER, valid_tno: [] } };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(negative)));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
    const wrong = fixture(); wrong.data.valid_tno[0].tno = OTHER;
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(wrong)));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    fetcher.mockResolvedValueOnce(new Response('Verification', { status: 403 }));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('uses one fresh anonymous request with the current public website configuration', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(fixture())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await instance.track({ number: 'uus-00000000 00000001' });
    await instance.track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [rawUrl, init] of fetcher.mock.calls) {
      const url = new URL(String(rawUrl));
      expect(url.origin + url.pathname).toBe('https://tracking-service-api.uniuni.ca/tracking/trackinguniuninew');
      expect(Object.fromEntries(url.searchParams)).toEqual({ id: NUMBER, key: 'SMq45nJhQuNR3WHsJA6N', source: 'web' }); // gitleaks:allow
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    }
    expect(normalizeUniuniNumber('4c000000001us')).toBe('4C000000001US');
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s distinct from parcel absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new UniuniTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects invalid input before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['123', `${NUMBER}&id=OTHER`, 'U'.repeat(36)]) {
      await expect(new UniuniTracker({ fetcher: unused }).fetch(number)).rejects.toThrow(InvalidInputError);
    }
    await expect(new UniuniTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted(); return new Response('{}');
    });
    await expect(new UniuniTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new UniuniTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Unavailable</html>'));
    await expect(new UniuniTracker({ fetcher: malformed }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PAKISTAN_POST_TRACKER, PakistanPostTracker } from './adapter.js';
import { normalizePakistanPostNumber, pakistanPostWording, parsePakistanPost } from './parser.js';
import { pakistanPostScanStage, pakistanPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014PK';
const INBOUND = 'ZZ000000028GB';
const UNKNOWN = 'PAR00000002';
const DOMESTIC = 'RGL00000001';
const COD = 'COD00000001';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// One scan row of the history, and a day's heading, as the page writes them.
const scan = (time: string, place: string, wording: string) =>
  `   <tr><td>&nbsp;&nbsp;&nbsp;&nbsp;</td> <td class='time'><div >${time}</div></td><td><b>${place}</b></td><td>${wording}</td></tr>`;
const day = (date: string) => `<tr><td colspan='4' > <div class='date-heading'> ${date}</div></td></tr>`;
// The domestic page with its history rows replaced.
const withRows = (rows: string) => page('domestic')
  .replace(/(<div class='row-heading'> Article Track Detail<\/div><\/td><\/tr>)[\s\S]*?(<\/table><\/div>)/, `$1${rows}$2`);
const BLOCKED = '<!DOCTYPE html><html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>';

describe('Pakistan Post tracking adapter', () => {
  it('asks the tracker for the whole number once, as its form\'s frame does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PakistanPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 pk ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PAKISTAN_POST_TRACKER}?ArticleIDz=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pakistan-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an item delivered abroad newest first, with each office\'s wall clock and the destination country', () => {
    const result = parsePakistanPost(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Update item in destination country', last_update: null, last_update_local: '2026-05-08T15:05:00',
      expected_delivery: null, destination_country: 'TH' });
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      // An update after the delivery moves nothing.
      ['2026-05-08T15:05:00', undefined, 'Update item in destination country', undefined],
      ['2026-05-08T12:30:00', undefined, 'Deliver item in destination country', 'delivered'],
      ['2026-05-08T08:02:00', undefined, 'Send item out for physical delivery in destination country', 'out_for_delivery'],
      ['2026-05-08T04:18:00', undefined, 'Receive item at delivery office in destination country', 'in_transit'],
      // Scans at the same minute keep the page's order, the later one first.
      ['2026-05-07T12:45:00', 'SAMPLE MAIL CENTRE', 'Return item from customs in destination country', 'in_transit'],
      ['2026-05-07T12:45:00', 'SAMPLE MAIL CENTRE', 'Send item to customs in destination country', 'customs'],
      ['2026-05-07T09:14:00', 'SAMPLE MAIL CENTRE', 'Receive item at office of exchange in destination country', 'in_transit'],
      ['2026-05-06T21:29:00', undefined, 'Handed over from airline to office of exchange in destination country', 'in_transit'],
      // The departure the page lists twice is kept once; "-" names no place.
      ['2026-05-06T00:46:00', undefined, 'Flight departure', 'in_transit'],
      ['2026-05-05T06:18:00', 'SAMPLE INTERNATIONAL MAIL OFFICE', 'Handedover to airline flight no:ZZ 0000, Destination THBKKD', 'in_transit'],
      ['2026-05-05T05:34:00', 'SAMPLE INTERNATIONAL MAIL OFFICE', 'Send item to destination country', 'in_transit'],
      ['2026-05-04T09:12:00', 'SAMPLE INTERNATIONAL MAIL OFFICE', 'Receive item at office of exchange in origin country', 'in_transit'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
    expect(result.events!.filter(event => event.stage).every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads an item from abroad held by customs in Pakistan', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const result = await carrier(fetcher).track({ number: INBOUND });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Send item to customs in destination country', last_update_local: '2026-06-03T11:20:00', destination_country: 'PK' });
    expect(result.events).toEqual([
      { local_time: '2026-06-03T11:20:00', location: 'SAMPLE INTERNATIONAL MAIL OFFICE', description: 'Send item to customs in destination country',
        stage: 'customs', stage_source: 'carrier_map' },
      { local_time: '2026-06-03T07:41:00', location: 'SAMPLE INTERNATIONAL MAIL OFFICE',
        description: 'Receive item at office of exchange in destination country', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-06-01T20:36:00', description: 'Send item to destination country', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('ArticleIDz')).toBe(INBOUND);
  });

  it('reads a domestic item without its bags, the person who took it, free-text reasons or phone numbers', () => {
    const result = parsePakistanPost(page('domestic'), DOMESTIC);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered at delivery office Sample Village PO',
      last_update_local: '2026-07-04T12:00:00' });
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-07-04T12:00:00', 'Sample Village PO', 'Delivered at delivery office Sample Village PO', 'delivered'],
      ['2026-07-04T10:20:00', 'Sample Village PO', 'Sent out for delivery', 'out_for_delivery'],
      ['2026-07-03T14:15:00', 'Sample Village PO', 'Undelivered', 'failed_attempt'],
      ['2026-07-03T10:30:00', 'Sample Village PO', 'Sent out for delivery', 'out_for_delivery'],
      ['2026-07-03T09:02:00', 'Sample Town GPO', 'Missent', 'in_transit'],
      ['2026-07-02T16:41:00', 'Sample Town GPO', 'Undelivered: Deposit', 'failed_attempt'],
      ['2026-07-02T10:16:00', 'Sample Town GPO', 'Sent out for delivery', 'out_for_delivery'],
      ['2026-07-02T06:10:00', 'Sample Town', 'Dispatch from DMO Sample Town to delivery office Sample Town GPO', 'in_transit'],
      ['2026-07-02T05:45:00', 'Sample Town', 'Received at Sample Town DMO', 'in_transit'],
      ['2026-07-01T23:58:00', 'Sample City', 'Dispatch from district mail office Sample City to district mail office Sample Town', 'in_transit'],
      ['2026-07-01T18:40:00', 'Sample City GPO', 'Dispatch from booking office Sample City GPO to district mail office Sample City', 'in_transit'],
      ['2026-07-01T11:05:00', 'Sample City GPO', 'Booked at Sample City GPO', 'accepted'],
    ]);
    // A domestic summary names offices, not a destination country.
    expect(result).not.toHaveProperty('destination_country');
    expect(result).not.toHaveProperty('destination_country_name');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|SAMPLE NEIGHBOUR|BagID|BAG0|0300|ADDRESSEE/i);
  });

  it('takes bags, people, free-text reasons and phone numbers out of the wording', () => {
    expect(pakistanPostWording('Delivered to A SAMPLE PERSON')).toBe('Delivered');
    expect(pakistanPostWording('Delivered at delivery office Sample PO to ADDRESSEE')).toBe('Delivered at delivery office Sample PO');
    expect(pakistanPostWording('Dispatch from DMO Sample to delivery office Sample PO (BagID:BAG00000000)'))
      .toBe('Dispatch from DMO Sample to delivery office Sample PO');
    expect(pakistanPostWording('Undelivered reason : Address not found')).toBe('Undelivered: Address not found');
    expect(pakistanPostWording('Undelivered reason : A SAMPLE PERSON asked to call')).toBe('Undelivered');
    expect(pakistanPostWording('Return to sender reason : Refused To Received')).toBe('Return to sender: Refused To Received');
    expect(pakistanPostWording('Return to sender reason : sample note')).toBe('Return to sender');
    expect(pakistanPostWording('MissSent : Miss Sent')).toBe('Missent');
    expect(pakistanPostWording('MissSent : sent on to A SAMPLE PERSON')).toBe('Missent');
    expect(pakistanPostWording('Sample note, call +92 300 0000000')).toBe('Sample note, call');
  });

  it('reads only a cash-on-delivery item\'s own history, not the money order back to its sender', () => {
    const result = parsePakistanPost(page('cod'), COD);
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-08-03T13:52:00' });
    expect(result.events!.map(event => event.description)).toEqual(['Delivered', 'Sent out for delivery',
      'Dispatch from DMO Sample Town to delivery office Sample Town GPO', 'Received at Sample Town DMO']);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|SAMPLE SENDER|UMO00000001/);
  });

  it('gives the destination as a country code, its name when it has none, and nothing for a placeholder', () => {
    const destination = (name: string) => {
      const result = parsePakistanPost(page('delivered').replace('>Thailand<', `>${name}<`), DELIVERED);
      return { code: result.destination_country, name: result.destination_country_name };
    };
    // ISO 3166 writes some names with a trailing "(the)".
    expect(destination('Netherlands (the)')).toEqual({ code: 'NL', name: undefined });
    expect(destination('Sample Country')).toEqual({ code: undefined, name: 'Sample Country' });
    expect(destination('N/A')).toEqual({ code: undefined, name: undefined });
    expect(destination('')).toEqual({ code: undefined, name: undefined });
  });

  it('reads noon and midnight on the twelve-hour clock', () => {
    const result = parsePakistanPost(withRows(day('July 01, 2026') + scan('12:10 AM', 'Sample City GPO', 'Booked at Sample City GPO')
      + scan('12:10 PM', 'Sample City GPO', 'Dispatch from booking office Sample City GPO to district mail office Sample City')), DOMESTIC);
    expect(result.events!.map(event => event.local_time)).toEqual(['2026-07-01T12:10:00', '2026-07-01T00:10:00']);
  });

  it('stages new wording through the shared rules and keeps the rest without a stage', () => {
    const stage = (wording: string) => parsePakistanPost(withRows(day('July 01, 2026') + scan('9:00 AM', 'Sample Town', wording)), DOMESTIC);
    expect(stage('Item returned to sender')).toMatchObject({ status: 'exception', current_stage: 'returned' });
    const unknown = stage('Sample counter scan');
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample counter scan' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ local_time: '2026-07-01T09:00:00', location: 'Sample Town', description: 'Sample counter scan' });
  });

  it('reads the tracker\'s "Route Not Found" as a missing item, and an empty page or history as inconclusive', async () => {
    expect(() => parsePakistanPost(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = page('not-found').replace('Route Not Found', 'Sample service notice');
    expect(() => parsePakistanPost(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The tracker's answer to an S10 code it holds nothing for: empty histories, without a notice.
    const empty = "<table width='90%' border='0' class='simple-table'><tr><td colspan='4' > <div class='row-heading'> Article Track Detail</div></td></tr></table> ";
    const unscanned = page('not-found').replace(/<table width='90%'[\s\S]*?<\/table>/, empty + empty);
    expect(() => parsePakistanPost(unscanned, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const blank = page('not-found').replace(/<table width='90%'[\s\S]*?<\/table>/, ' ');
    expect(() => parsePakistanPost(blank, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePakistanPost(withRows(day('July 01, 2026')), DOMESTIC))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const lookup = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number: UNKNOWN });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(BLOCKED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="g-recaptcha"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the page to the whole requested number and rejects a changed page', () => {
    expect(() => parsePakistanPost(page('delivered'), 'ZZ000000045PK'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Pakistan Post answered for a different item' }));
    expect(() => parsePakistanPost(page('domestic'), 'RGL00000002')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parsePakistanPost(page('delivered').replace(`>${DELIVERED}<`, `>${DELIVERED.toLowerCase()}<`), DELIVERED).events).toHaveLength(12);
    const delivered = page('delivered');
    for (const changed of [
      delivered.replace(`>${DELIVERED}<`, '><'),
      delivered.replace('id="TrackDetailDiv"', 'id="TrackDetails"'),
      delivered.replace('<span id="LblArticleTrackingNo"', `<span id="LblArticleTrackingNo">${DELIVERED}</span><span id="LblArticleTrackingNo"`),
      delivered.replace('Article Track Detail', 'Track Detail'),
      delivered.replace('May 08, 2026', '08/05/2026'),
      delivered.replace('May 08, 2026', 'February 30, 2026'),
      delivered.replace('>12:30 PM<', '>12:30<'),
      delivered.replace('>12:30 PM<', '>13:30 PM<'),
      delivered.replace("<td>&nbsp;&nbsp;&nbsp;&nbsp;</td> <td class='time'><div >12:30 PM</div>", "<td class='time'><div >12:30 PM</div>"),
      delivered.replace('Deliver item  in destination country <b></b>', ' <b></b>'),
    ]) {
      expect(() => parsePakistanPost(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const rows of [
      // A scan before any day's heading.
      scan('9:00 AM', 'Sample Town', 'Booked at Sample Town GPO'),
      day('July 01, 2026') + Array.from({ length: 1000 }, () => scan('9:00 AM', 'Sample Town', 'Sent out for delivery')).join(''),
    ]) {
      expect(() => parsePakistanPost(withRows(rows), DOMESTIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit and domestic article numbers, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015PK', 'ZZ00000001PK', 'ZZ000000014PKX', 'RGL0000001', 'RGL000000001', 'RG000000001', '12345678',
      'SAMPLETRACKING', `RGL${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePakistanPostNumber(' rgl-0000 0001 ')).toBe(DOMESTIC);
    expect(normalizePakistanPostNumber('zz 000 000 028 gb')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown number from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('domestic'))).mockResolvedValueOnce(reply(page('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DOMESTIC)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-07-04T12:00:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'indeterminate'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(2_000_001)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Pakistan Post to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'pakistan-post' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'pakistan-post', source: 'pakistan-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(PAKISTAN_POST_TRACKER))).toBe(true);
  });

  it('is asked about the domestic numbers detection suggests it for, and reads the tracker\'s address', () => {
    expect(detectCarrierMatch(DOMESTIC)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['pakistan-post']) });
    expect(recognitionAskedCarriers(DOMESTIC)).toContain('pakistan-post');
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(parseTrackingInput(`https://ep.gov.pk/emtts/EPTrack_Live.aspx?ArticleIDz=${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'pakistan-post', source: 'link' });
  });
});

describe('Pakistan Post status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and leaves an update out', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      if (!('stage' in entry)) {
        expect(statusMap.stage(null, wording), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'pakistan-post', description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        expect(pakistanPostStage(entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(pakistanPostScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'pakistan-post', description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(pakistanPostStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // The page's own spelling of a missent scan reads the same.
    expect(pakistanPostScanStage('MissSent')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Sample delivered note']) expect(pakistanPostScanStage(wording), wording).toBeUndefined();
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(pakistanPostStage('')).toBeNull();
  });
});

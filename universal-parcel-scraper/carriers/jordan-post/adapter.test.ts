import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JORDAN_POST_ITEM, JORDAN_POST_SEARCH, JordanPostTracker } from './adapter.js';
import { isJordanPostItemRedirect, jordanPostItemUrl, normalizeJordanPostNumber, parseJordanPostItem, parseJordanPostSearch } from './parser.js';
import { jordanPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Mail from abroad keeps the sending post's code.
const INBOUND = 'ZZ000000014NL';
const OUTBOUND = 'ZZ000000028JO';
const DOMESTIC = 'ZZ000000031JO';
const UNKNOWN = 'ZZ000000045JO';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const redirect = (location: string) => reply('<html><head><title>Object moved</title></head><body></body></html>', 302, { Location: location });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The form's answers for a code, after the IPS page had no information for it.
const searched = (answer: Response) => vi.fn<typeof fetch>()
  .mockResolvedValueOnce(reply(page('no-information'))).mockResolvedValueOnce(reply(page('search'))).mockResolvedValueOnce(answer);
// The form's answer for a code it found nothing for, with this code in its field.
const emptyFor = (number: string) => page('search-empty').replaceAll(DOMESTIC, number);
// One row of the IPS page's history, as the page writes it.
const row = (clock: string, country: string, office: string, event: string, extra = '') => `<tr class="tabl1">
<td align="center" width="10%">${clock}</td><td align="center" width="10%">${country}</td><td align="center" width="10%">${office}</td>
<td align="center" width="15%">${event}</td><td align="center" width="10%">A</td><td align="center" width="15%"> </td>
<td align="center" width="15%">${extra}</td><td align="center" width="10%"> </td></tr>`;
// The outbound item's page with these rows instead of its own.
const withRows = (rows: string) => page('outbound').replace(/(Extra Information<\/td>[\s\S]*?<\/tr>)[\s\S]*?(<\/tbody>)/, `$1${rows}$2`);
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';

describe('Jordan Post tracking adapter', () => {
  it('opens the IPS page for the whole code once, as the form\'s redirect does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('inbound-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JordanPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 nl ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JORDAN_POST_ITEM}?itemid=${INBOUND}&Submit=Submit`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jordan-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads mail from abroad newest first, Jordanian scans on Amman\'s clock and the sending post\'s on its own', () => {
    const result = parseJordanPostItem(page('inbound-delivered'), INBOUND)!;
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Deliver item (Inb)', last_update: '2026-03-09T12:31:07+03:00', expected_delivery: null,
      delivered_at: '2026-03-09T12:31:07+03:00', destination_country: 'JO', events: expect.any(Array) });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location, event.description, event.stage])).toEqual([
      // Who signed is dropped from the extra information.
      ['2026-03-09T12:31:07+03:00', 'SAMPLE OFFICE, Jordan', 'Deliver item (Inb)', 'delivered'],
      ['2026-03-09T08:15:00+03:00', 'SAMPLE OFFICE, Jordan', 'Handover item to delivery agent (Inb)', 'out_for_delivery'],
      ['2026-03-08T12:50:00+03:00', 'SAMPLE OFFICE, Jordan',
        'Unsuccessful item delivery attempt (Inb): Addressee absent; Scheduled for further action/processing today', 'failed_attempt'],
      // The office's postcode is dropped.
      ['2026-03-08T10:02:44+03:00', 'SAMPLE OFFICE, Jordan', 'Receive item at delivery office (Inb)', 'in_transit'],
      ['2026-03-05T04:50:59+03:00', 'AMMAN, Jordan', 'Send item to domestic location (Inb)', 'in_transit'],
      ['2026-03-05T04:43:23+03:00', 'AMMAN, Jordan', 'Return item from customs (Inb)', 'in_transit'],
      ['2026-03-05T04:41:02+03:00', 'AMMAN, Jordan',
        'Record item customs information (Inb): Handed over to customs authority for final delivery', 'customs'],
      ['2026-03-05T04:20:10+03:00', 'AMMAN, Jordan', 'Send item to customs (Inb)', 'customs'],
      // The scan the page lists twice is kept once.
      ['2026-03-05T04:12:30+03:00', 'AMMAN, Jordan', 'Receive item at office of exchange (Inb)', 'in_transit'],
      ['2026-03-02T21:05:00', 'SAMPLE SORTING CENTRE, Netherlands', 'Send item abroad (EDI-received)', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|showImagePopup|11000/);
  });

  it('reads an item posted in Jordan up to its bagging for abroad, without a destination', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page('outbound')))).track({ number: OUTBOUND });
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Insert item into bag (Otb)', last_update: '2026-02-20T12:47:43+03:00', expected_delivery: null, events: [
        { time: '2026-02-20T12:47:43+03:00', location: 'AMMAN, Jordan', description: 'Insert item into bag (Otb)', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-02-20T12:37:19+03:00', location: 'AMMAN, Jordan', description: 'Receive item at office of exchange (Otb)', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { time: '2026-02-19T11:31:00+03:00', location: 'AMMAN, Jordan', description: 'Receive item from customer (Otb)', stage: 'accepted',
          stage_source: 'carrier_map' },
      ] });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page('outbound')))).recognize!(OUTBOUND))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-02-20T09:47:43.000Z' });
  });

  it('keeps a clock Amman skipped as a wall clock, takes a repeated hour\'s first occurrence, and leaves new wording unstaged', () => {
    const result = parseJordanPostItem(withRows([
      row('3/26/2021 12:30:00 AM', 'Jordan', 'AMMAN', 'Receive item from customer (Otb)'),
      row('10/29/2021 12:30:00 AM', 'Jordan', 'AMMAN', 'Sample counter scan (Otb)'),
      row('10/30/2021 12:00:00 PM', 'Jordan', 'AMMAN', 'Sample counter scan (Otb)', 'Sample note : kept out'),
    ].join('')), OUTBOUND)!;
    expect(result.events).toEqual([
      { time: '2021-10-30T12:00:00+02:00', location: 'AMMAN, Jordan', description: 'Sample counter scan (Otb)' },
      { time: '2021-10-29T00:30:00+03:00', location: 'AMMAN, Jordan', description: 'Sample counter scan (Otb)' },
      { local_time: '2021-03-26T00:30:00', location: 'AMMAN, Jordan', description: 'Receive item from customer (Otb)', stage: 'accepted',
        stage_source: 'carrier_map' },
    ]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Sample counter scan (Otb)' });
    expect(parseJordanPostItem(withRows(row('5/2/2026 9:00:00 AM', 'Jordan', 'AMMAN', 'Item returned to sender')), OUTBOUND))
      .toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    // A country named alone, and one in ISO's style.
    expect(parseJordanPostItem(withRows(row('5/2/2026 9:00:00 AM', 'Jordan', 'JORDAN', 'Insert item into bag (Otb)')), OUTBOUND)!.events![0])
      .toMatchObject({ location: 'Jordan' });
    expect(parseJordanPostItem(withRows(row('5/2/2026 9:00:00 AM', 'Netherlands (the)', '-', 'Insert item into bag (Otb)')), OUTBOUND)!.events![0])
      .toEqual({ local_time: '2026-05-02T09:00:00', location: 'Netherlands', description: 'Insert item into bag (Otb)', stage: 'in_transit',
        stage_source: 'carrier_map' });
    expect(() => parseJordanPostItem(withRows(''), OUTBOUND)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('asks the form when the IPS page has no information, as the tracking page would, and reads its empty answer as not found', async () => {
    const fetcher = searched(reply(emptyFor(UNKNOWN)));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [jordanPostItemUrl(UNKNOWN), 'GET'], [JORDAN_POST_SEARCH, 'GET'], [JORDAN_POST_SEARCH, 'POST']]);
    const init = fetcher.mock.calls[2]![1]!;
    expect(init).toMatchObject({ redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: JORDAN_POST_SEARCH } });
    expect([...new URLSearchParams(String(init.body))]).toEqual([
      ['__EVENTTARGET', ''], ['__EVENTARGUMENT', ''], ['__LASTFOCUS', ''],
      ['__VIEWSTATE', '/wEPDwUKLTEwMDAwMDAwMA9kFgJmD2QWAgIDD2QWAgIBD2QWAgIZDzwrAA0AA=='], ['__VIEWSTATEGENERATOR', '00C42CBF'],
      ['__EVENTVALIDATION', '/wEWBwLSAMPLEVALIDATIONAA=='],
      ['ctl00$ContentPlaceHolder1$a', 'RdbByItem'], ['ctl00$ContentPlaceHolder1$txtItemNo', UNKNOWN], ['ctl00$ContentPlaceHolder1$btnSubmit', 'Search'],
    ]);
    await expect(carrier(searched(reply(emptyFor(UNKNOWN)))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(parseJordanPostItem(page('no-information'), UNKNOWN)).toBeNull();
  });

  it('reads the domestic records the form shows in its own table, without who signed', async () => {
    const result = await carrier(searched(reply(page('search-domestic')))).track({ number: DOMESTIC });
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Deliver item', last_update: '2026-04-07T11:48:19+03:00', expected_delivery: null,
      delivered_at: '2026-04-07T11:48:19+03:00', events: [
        { time: '2026-04-07T11:48:19+03:00', location: 'SAMPLE TOWN, Jordan', description: 'Deliver item', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-04-06T14:05:00+03:00', location: 'SAMPLE OFFICE, Jordan', description: 'Insert item into domestic bag', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { time: '2026-04-06T09:12:41+03:00', location: 'SAMPLE OFFICE, Jordan', description: 'Receive item from customer', stage: 'accepted',
          stage_source: 'carrier_map' },
      ] });
    expect(JSON.stringify(result)).not.toContain('SAMPLE PERSON');
  });

  it('leaves a form that sends the code to the IPS page, after that page had nothing, inconclusive', async () => {
    await expect(carrier(searched(redirect(`https://212.35.69.85/webtracking/IPSWeb_item_events.aspx?itemid=${UNKNOWN}&Submit=Submit`)))
      .track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(searched(redirect('https://212.35.69.84/NewWebTrack/Error.aspx'))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'transport' });
    expect(isJordanPostItemRedirect(`https://212.35.69.85/webtracking/IPSWeb_item_events.aspx?itemid=${UNKNOWN.toLowerCase()}`, UNKNOWN)).toBe(true);
    for (const location of [`https://212.35.69.85/webtracking/IPSWeb_item_events.aspx?itemid=${OUTBOUND}`,
      `https://212.35.69.84/webtracking/IPSWeb_item_events.aspx?itemid=${UNKNOWN}`, `http://212.35.69.85/webtracking/IPSWeb_item_events.aspx?itemid=${UNKNOWN}`]) {
      expect(isJordanPostItemRedirect(location, UNKNOWN), location).toBe(false);
    }
  });

  it('reads block pages as challenges and changed pages as schema failures, never as a missing item', async () => {
    const lookup = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number: OUTBOUND });
    await expect(lookup(BLOCKED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Bot Verification</title></head><body><form id="lsrecaptcha-form"></form></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(page('no-information').replace('No information', 'No data'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(searched(reply(BLOCKED))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    const form = (search: string, answer = emptyFor(UNKNOWN)) => carrier(vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('no-information')))
      .mockResolvedValueOnce(reply(search)).mockResolvedValueOnce(reply(answer))).track({ number: UNKNOWN });
    await expect(form(BLOCKED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(form(page('search').replace(/id="__EVENTVALIDATION" value="[^"]*"/, 'id="__EVENTVALIDATION" value=""')))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(form(page('search').replace('value="RdbByItem"', 'value="ByItem"'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(form(page('search'), '<html><body>Sample error</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds each page to the whole requested code and rejects a changed history', () => {
    expect(() => parseJordanPostItem(page('outbound'), 'ZZ000000059JO'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Jordan Post answered for a different item' }));
    expect(() => parseJordanPostSearch(page('search-domestic'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Jordan Post answered for a different item' }));
    expect(() => parseJordanPostSearch(page('search-domestic').replace(`value="${DOMESTIC}"`, `value="${UNKNOWN}"`), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Jordan Post answered for a different item' }));
    expect(() => parseJordanPostSearch(emptyFor(DOMESTIC), DOMESTIC)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const outbound = page('outbound');
    for (const changed of [
      outbound.replace('ITEM&nbsp;n&deg;', 'ITEM'),
      outbound.replace('<td class="tabmen" width="10%">Mail Category</td>', ''),
      outbound.replace('>Insert item into bag (Otb)<', '><'),
      outbound.replace('>2/20/2026 12:47:43 PM<', '>2026-02-20 12:47<'),
      outbound.replace('>2/20/2026 12:47:43 PM<', '>2/30/2026 12:47:43 PM<'),
      outbound.replace('>2/20/2026 12:47:43 PM<', '>2/20/2026 13:47:43 PM<'),
      outbound.replace('>2/20/2026 12:47:43 PM<', '>2/20/2026 0:47:43 AM<'),
      outbound.replace('<td align="center" width="10%">A</td>', ''),
      outbound.replace(/<table id="200"[\s\S]*?<\/table>/, (table) => `${table}${table}`),
    ]) {
      expect(() => parseJordanPostItem(changed, OUTBOUND)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const domestic = page('search-domestic');
    for (const changed of [
      domestic.replace('<th scope="col">SIGNATORY_NM</th>', ''),
      domestic.replace('<td>SAMPLE PERSON</td>', ''),
      domestic.replace('>4/6/2026 2:05:00 PM<', '>06/04/2026 14:05<'),
    ]) {
      expect(() => parseJordanPostSearch(changed, DOMESTIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const oversized = withRows(Array.from({ length: 501 }, () => row('5/2/2026 9:00:00 AM', 'Jordan', 'AMMAN', 'Insert item into bag (Otb)')).join(''));
    expect(() => parseJordanPostItem(oversized, OUTBOUND)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes S10 codes with a valid check digit, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015JO', 'ZZ00000001JO', 'ZZ000000014JOX', '00000000001', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}JO`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJordanPostNumber(' zz-000 000 014 nl ')).toBe(INBOUND);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [301, 'transport'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('no-information'), status, { Location: JORDAN_POST_SEARCH }));
      await expect(carrier(fetcher).track({ number: OUTBOUND })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(OUTBOUND)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const form = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('no-information'))).mockResolvedValueOnce(reply(page('search'), status));
      await expect(carrier(form).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(form).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('outbound')));
    await expect(carrier(flaky).track({ number: OUTBOUND })).resolves.toMatchObject({ status: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    // A failed connection to the form starts the attempt again from the IPS page.
    const form = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('no-information'))).mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(page('no-information'))).mockResolvedValueOnce(reply(page('search'))).mockResolvedValueOnce(reply(emptyFor(UNKNOWN)));
    await expect(carrier(form).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(form).toHaveBeenCalledTimes(5);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('outbound')));
    await expect(carrier(immediate).track({ number: OUTBOUND }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: OUTBOUND }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: OUTBOUND }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1)));
    await expect(carrier(large).track({ number: OUTBOUND })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Jordan Post to the adapter and reads the IPS page\'s address', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('inbound-delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INBOUND, carrier: 'jordan-post' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'jordan-post', source: 'jordan-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(JORDAN_POST_ITEM))).toBe(true);
    for (const link of [jordanPostItemUrl(OUTBOUND), `https://212.35.69.84/JordanWebTrack/Result.aspx?itemid=${OUTBOUND}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: OUTBOUND, carrier: 'jordan-post', source: 'link' });
    }
  });
});

describe('Jordan Post status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'jordan-post', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(jordanPostStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // A scan's details after its event name do not change its stage.
    expect(statusMap.stage(null, 'unsuccessful item delivery attempt (inb): addressee absent')).toBe('failed_attempt');
    for (const wording of ['constructor', 'toString', 'Sample counter scan']) expect(statusMap.stage(null, wording), wording).toBeUndefined();
    expect(statusMap.stage('A', 'deliver item')).toBeUndefined();
  });
});

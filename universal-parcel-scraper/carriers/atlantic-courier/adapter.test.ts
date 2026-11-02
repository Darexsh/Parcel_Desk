import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ATLANTIC_COURIER_ENDPOINT, AtlanticCourierTracker } from './adapter.js';
import { normalizeAtlanticCourierNumber, parseAtlanticCourier } from './parser.js';
import { atlanticCourierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '0000000001';
const OTHER = '0000000';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseAtlanticCourier>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The consignee, whoever signed and the partner's forwarding number.
const PRIVATE = /SAMPLE CONSIGNEE|SAMPLE RECEIVER|SAMPLE SIGNER|00000000000000/;
const ROW = (clock: string, activity: string, place: string) => `<tr><td>${clock}</td><td>${activity}</td><td>${place}</td></tr>`;
const HEADINGS = /(<td style="color:#dc291e;font-weight:600;">Location<\/td>\s*<\/tr>)[\s\S]*?(<\/table>)/;
const withRows = (html: string, ...lines: string[]) => html.replace(HEADINGS, (_, heading: string, end: string) => `${heading}${lines.join('')}${end}`);
const DELIVERY = /(Delivery Date<\/td>\s*<td>)\s*([^<]*?)\s*(<\/td>)/;
const deliveredOn = (html: string, text: string) => html.replace(DELIVERY, (_, open: string, _old: string, close: string) => `${open}${text}${close}`);
const signedBy = (html: string, signer: string) => html.replace(/Signing for: [^\n]*/, `Signing for: ${signer}`);
const destination = (html: string, country: string) => html.replace(/Destination: [^<]*/, `Destination: ${country}`);

describe('Atlantic International Express tracking adapter', () => {
  it('posts the whole air waybill once, as the tracking page does, through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AtlanticCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${NUMBER.slice(0, 4)} ${NUMBER.slice(4)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://atlanticcourier.net/action');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
    } });
    expect(JSON.parse(String(init!.body))).toEqual({ function: 'track', awbno: NUMBER, searchby: 'A' });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'atlantic-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery abroad: scans in India on India’s clock, the partner’s as wall clocks, and no names or forwarding number', () => {
    const result = parseAtlanticCourier(page('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Proof of Delivery', last_update: null, last_update_local: '2026-10-09T10:25:00',
      expected_delivery: null, destination_country: 'NZ' });
    expect(rows(result)).toEqual([
      ['2026-10-09T10:25:00', 'Sampleton', 'Proof of Delivery', 'delivered'],
      // The consignee's name after the wording is dropped.
      ['2026-10-09T07:40:00', 'Sampleton', 'Out for Delivery', 'out_for_delivery'],
      // A forecast is no scan.
      ['2026-10-08T15:55:00', 'NEW ZEALAND : NZ', 'Estimated delivery 09/10/2026', null],
      ['2026-10-07T17:44:00', 'Sample Gateway', 'In Transit to Destination', 'in_transit'],
      ['2026-10-07T17:41:00', 'Sample Gateway', 'Released From Customs', 'in_transit'],
      ['2026-10-07T09:00:00', 'NEW ZEALAND : NZ', 'UNDER CUSTOM PROCESS', 'customs'],
      ['2026-10-05T11:49:00', 'Sample Gateway', 'Expected Flight Arrival', 'in_transit'],
      ['2026-10-03T20:21:00+05:30', 'Mumbai', 'Shipment Finalised', 'in_transit'],
      ['2026-10-03T17:20:00+05:30', 'MUMBAI', 'HANDED OVER TO AIRLINE', 'in_transit'],
      ['2026-10-03T16:40:00+05:30', 'MUMBAI', 'ARRIVED AT EXPORT TERMINAL', 'in_transit'],
      ['2026-10-03T15:39:00+05:30', 'MUMBAI', 'PREPARED EXPORT DOCUMENTS', 'in_transit'],
      ['2026-10-02T18:10:00+05:30', 'MUMBAI', 'SHIPMENT SENT TO DESTINATION', 'in_transit'],
      // A repeated row appears once; a receipt after the first is a hub's.
      ['2026-10-01T19:47:00', null, 'SHIPMENT RECEIVED', 'in_transit'],
      // Hyderabad alone could be Pakistan's, so it keeps its wall clock.
      ['2026-09-30T23:47:00', 'HYDERABAD', 'SHIPMENT RECEIVED', 'accepted'],
    ]);
    expect(result.events!.filter(event => event.time).every(event => /^MUMBAI$/i.test(String(event.location)))).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('summary_only');
    for (const name of ['delivered', 'in-transit']) {
      expect(JSON.stringify(parseAtlanticCourier(page(name), NUMBER)), name).not.toMatch(PRIVATE);
    }
  });

  it('follows the newest staged scan of a shipment held in India, and stages Atlantic’s first receipt as its acceptance', () => {
    const result = parseAtlanticCourier(page('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'EXPECTED DEPARTURE 17/10/2026', last_update: null, last_update_local: '2026-10-16T11:20:00',
      destination_country: 'SE' });
    expect(rows(result)).toEqual([
      // Delhi alone could be Canada’s or the United States’, so it keeps its wall clock.
      ['2026-10-16T11:20:00', 'DELHI', 'EXPECTED DEPARTURE 17/10/2026', 'in_transit'],
      ['2026-10-14T18:05:00', 'DELHI', 'SHIPMENT OFFLOA D BY DELHI CUSTOM', 'customs'],
      ['2026-10-13T14:45:00', 'DELHI', 'This shipment has been hold up due to medicine paperwork', 'exception'],
      ['2026-10-12T09:30:00', 'DELHI', 'UNDER CUSTOM PROCESS', 'customs'],
      ['2026-10-10T16:10:00', 'DELHI', 'Atlantic Label Created', 'in_transit'],
      ['2026-10-10T15:02:00', 'DELHI', 'SHIPMENT RECEIVED', 'in_transit'],
      ['2026-10-08T19:15:00+05:30', 'MUMBAI', 'SHIPMENT SENT TO DELHI', 'in_transit'],
      ['2026-10-07T12:40:00+05:30', 'MUMBAI', 'SHIPMENT RECEIVED', 'in_transit'],
      ['2026-10-05T18:55:00+05:30', 'PUNE', 'SHIPMENT SENT TO Mumbai', 'in_transit'],
      ['2026-10-05T17:30:00+05:30', 'PUNE', 'SHIPMENT RECEIVED', 'accepted'],
    ]);
    // The page’s order is kept when it lists the oldest first.
    const body = page('in-transit');
    const listed = HEADINGS.exec(body)![0].match(/<tr>[\s\S]*?<\/tr>/g)!;
    expect(parseAtlanticCourier(withRows(body, ...[...listed].reverse()), NUMBER).events).toEqual(result.events);
    // A newest scan in India is the last update's instant.
    const newest = parseAtlanticCourier(withRows(body, ROW('17/10/2026 9:05 AM', 'SHIPMENT SENT TO DESTINATION', 'NEW DELHI'), ...listed), NUMBER);
    expect(newest).toMatchObject({ last_update: '2026-10-17T09:05:00+05:30', current_stage_source: 'carrier_map' });
    expect(newest).not.toHaveProperty('last_update_local');
    // Wording neither the map nor the shared rules know stays without a stage.
    const unknown = parseAtlanticCourier(withRows(body, ROW('17/10/2026 9:05 AM', 'SAMPLE REMARK', 'MUMBAI')), NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'SAMPLE REMARK', last_update: '2026-10-17T09:05:00+05:30' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('reads the tracker’s clocks, and only places in India on India’s clock', () => {
    const at = (clock: string, place = 'MUMBAI') =>
      rows(parseAtlanticCourier(withRows(page('in-transit'), ROW(clock, 'SHIPMENT SENT TO DESTINATION', place)), NUMBER))[0]![0];
    expect(at('09/10/2026 3:40 PM')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('9/10/2026 12:05 AM')).toBe('2026-10-09T00:05:00+05:30');
    expect(at('09/10/2026 12:05 PM')).toBe('2026-10-09T12:05:00+05:30');
    expect(at('09/10/2026 15:40')).toBe('2026-10-09T15:40:00+05:30');
    expect(at('09/10/2026')).toBe('2026-10-09');
    for (const place of ['NEW DELHI', 'Bengaluru', 'PUNE, INDIA', 'Sample hub (IN)']) expect(at('09/10/2026 3:40 PM', place), place).toBe('2026-10-09T15:40:00+05:30');
    for (const place of ['DELHI', 'HYDERABAD', 'Sampleton (DE)', 'GREAT BRITAIN', 'MUMBAI AIRPORT', '']) {
      expect(at('09/10/2026 3:40 PM', place), place).toBe('2026-10-09T15:40:00');
    }
    for (const clock of ['10-09-2026 3:40 PM', '2026-10-09 15:40', '32/10/2026 3:40 PM', '09/13/2026 3:40 PM', '30/02/2026 3:40 PM',
      '09/10/2026 13:40 PM', '09/10/2026 25:00', '09/10/2026 noon', '']) {
      expect(() => at(clock), clock).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('lets the summary’s delivery settle the shipment, as a wall clock when no scan has it yet', () => {
    const ahead = parseAtlanticCourier(deliveredOn(page('in-transit'), '1st November 2026 , 1:18 PM'), NUMBER);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-11-01T13:18:00' });
    expect(ahead.events![0]).toEqual({ local_time: '2026-11-01T13:18:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(ahead.events).toHaveLength(11);
    expect(ahead).not.toHaveProperty('delivered_at');
    // Midnight is a day without its time.
    const day = parseAtlanticCourier(deliveredOn(page('in-transit'), '22nd Sept 2026 , 12:00 AM'), NUMBER);
    expect(day.events![0]).toMatchObject({ local_time: '2026-09-22', description: 'Delivered' });
    // A delivery the parser cannot date still settles the shipment.
    const undated = parseAtlanticCourier(deliveredOn(page('in-transit'), '01/11/2026'), NUMBER);
    expect(undated).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-10-16T11:20:00' });
    expect(undated.events).toHaveLength(10);
    // A delivered scan stands for the summary's delivery.
    expect(parseAtlanticCourier(page('delivered'), NUMBER).events).toHaveLength(14);
    // Without scans, the summary's delivery is the history.
    const alone = parseAtlanticCourier(withRows(deliveredOn(page('in-transit'), '1st November 2026 , 1:18 PM')), NUMBER);
    expect(alone).toMatchObject({ status: 'delivered', summary_only: true, events: [{ local_time: '2026-11-01T13:18:00', stage: 'delivered' }] });
    expect(() => parseAtlanticCourier(withRows(page('in-transit')), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('drops the consignee, whoever signed and the forwarding number, and scrubs their names from the scans', () => {
    const named = (signer: string, activity: string) => rows(parseAtlanticCourier(
      withRows(signedBy(page('delivered'), signer), ROW('09/10/2026 10:25 AM', activity, 'Sampleton')), NUMBER)).at(-1)!.at(2);
    expect(named('SAMPLE RECEIVER', 'Delivered to SAMPLE RECEIVER at the door')).toBe('Delivered to at the door');
    expect(named('', 'Delivered - Signed for by: SAMPLE SIGNER')).toBe('Delivered');
    expect(named('', 'Delivered, received by SAMPLE SIGNER')).toBe('Delivered');
    expect(named('SAMPLE CONSIGNEE', 'Out for delivery: SAMPLE CONSIGNEE')).toBe('Out for delivery');
    // A line that names no one is not scrubbed from the scans.
    for (const signer of ['delivered', 'SIGN', 'We have delivered your item an']) {
      expect(named(signer, 'Delivered'), signer).toBe('Delivered');
    }
    expect(JSON.stringify(parseAtlanticCourier(signedBy(page('delivered'), 'SAMPLE SIGNER'), NUMBER))).not.toMatch(PRIVATE);
  });

  it('reads the destination country, by its code when the page gives one or its name reads as one', () => {
    const country = (text: string) => {
      const result = parseAtlanticCourier(destination(page('in-transit'), text), NUMBER);
      return [result.destination_country ?? null, result.destination_country_name ?? null];
    };
    expect(country('NEW ZEALAND : NZ')).toEqual(['NZ', null]);
    expect(country('GREAT BRITAIN')).toEqual(['GB', null]);
    expect(country('FRANCE')).toEqual(['FR', null]);
    expect(country('USA')).toEqual(['US', null]);
    expect(country('SAMPLE LAND')).toEqual([null, 'SAMPLE LAND']);
    expect(country('')).toEqual([null, null]);
  });

  it('binds the reply to the requested air waybill and rejects replies it cannot read', () => {
    expect(() => parseAtlanticCourier(page('delivered'), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAtlanticCourier(page('delivered').replace(`<em>${NUMBER}</em>`, `<em>${NUMBER}0</em>`), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Several shipments under the number are inconclusive.
    const twice = page('delivered').replace(/(<div class="atl-md-shipment-overview">[\s\S]*?<\/h2>)/, '$1$1');
    expect(() => parseAtlanticCourier(twice, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<html><body>Maintenance</body></html>', '{"status":"ok"}',
      page('delivered').replace(`<em>${NUMBER}</em>`, '<em></em>'),
      page('delivered').replace('Travel History for AWB No.:', 'Order Number:'),
      page('delivered').replace('table table-striped', 'table'),
      page('delivered').replace('Delivery Date', 'Delivered On'),
      page('delivered').replace('>Location</td>', '>Place</td>'),
      page('delivered').replace('<td>Sampleton</td>', ''),
      page('delivered').replace('<td>Proof of Delivery</td>', '<td> </td>'),
      `${page('delivered')}${page('not-found')}`]) {
      expect(() => parseAtlanticCourier(html, NUMBER), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = withRows(page('in-transit'), ...Array.from({ length: 301 }, () => ROW('12/10/2026 10:00 AM', 'In transit.', 'Sampleton')));
    expect(() => parseAtlanticCourier(many, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the tracker’s notice as a missing shipment, and a block page as a challenge', () => {
    expect(() => parseAtlanticCourier(page('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAtlanticCourier(page('not-found').replace('No Tracking Data Available.', 'Server busy.'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAtlanticCourier(page('not-found').replace('</table>', '<tr><td><table class="table table-striped"></table></td></tr></table>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseAtlanticCourier(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes digit runs of six to ten digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000', '00000000000', '000000000X', 'ABCDEFGH', `${NUMBER},${OTHER}`, '5'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAtlanticCourierNumber('0000-000-001')).toBe(NUMBER);
    expect(normalizeAtlanticCourierNumber('000000')).toBe('000000');
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/track/' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps empty, foreign and oversized replies apart from missing shipments', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  \n ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).track({ number: NUMBER }), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(reply('<html><head><title>Just a moment...</title></head></html>'));
    await expect(carrier(blocked).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: NUMBER })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    await expect(carrier(immediate).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: NUMBER }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: NUMBER }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an air waybill filed under Atlantic to the adapter, and asks no partner', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: NUMBER, carrier: 'atlantic-courier' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'atlantic-courier', source: 'atlantic-courier', result: { current_stage: 'delivered' },
      attempts: [{ source: 'atlantic-courier', kind: 'ok' }] });
    expect(answer.attempts).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([ATLANTIC_COURIER_ENDPOINT]);
  });
});

describe('Atlantic International Express numbers', () => {
  it('leaves bare digit runs unclaimed', () => {
    for (const number of [NUMBER, OTHER, '000000']) expect(detectCarrierMatch(number).carrier, number).not.toBe('atlantic-courier');
  });
});

describe('Atlantic International Express status vocabulary', () => {
  it('records every wording with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      // A receipt's stage depends on the receipts before it; the first is the acceptance.
      if (entry.wording === 'SHIPMENT RECEIVED') continue;
      expect(atlanticCourierStage(entry.wording)?.stage, entry.wording).toBe(stage);
    }
    expect(statusMap.stage(null, 'shipment received')).toBeUndefined();
    expect(statusMap.stage(null, 'shipment offloa d by delhi custom')).toBe('customs');
    expect(statusMap.stage(null, 'shipment sent to mumbai by air')).toBe('in_transit');
    expect(statusMap.stage('7', 'proof of delivery')).toBeUndefined();
    for (const wording of ['constructor', 'toString', 'Released From Customs', 'SHIPMENT SENT TO ']) {
      expect(statusMap.stage(null, wording.toLowerCase()), wording).toBeUndefined();
    }
    expect(statusMapAnswer({ carrier: 'atlantic-courier', description: 'Atlantic Label Created' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});

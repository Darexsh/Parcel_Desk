import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, EurodisTracker } from './adapter.js';
import { eurodisLookup, parseEurodis } from './parser.js';
import { eurodisQuiet, eurodisStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const BARCODE = '100000000000000000000001';
const SHIPMENT = '7000000000001';
const FIRST = '200000000000000000000001';
const SECOND = '200000000000000000000002';
const delivered = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const transit = readFileSync(new URL('./fixtures/in-transit.html', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => { const $ = load(body); change($); return $.html(); };
const scan = (wording: string, stamp: string) => `<li><span></span><div><h6>${wording}</h6>${stamp}</div></li>`;
const timeline = (...items: string[]) => edit($ => $('ul.delivery-status-list').html(items.join('')));
const reply = (body = delivered, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('EURODIS direct tracking', () => {
  it('reads a collo\'s timeline in the clocks of the countries its scans name', () => {
    const result = normalizeCarrierResult(parseEurodis(delivered, BARCODE));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'delivered', last_update: '2026-03-17T10:42:00+01:00', delivered_at: '2026-03-17T10:42:00+01:00',
      expected_delivery: null, destination_country: 'HU' });
    // The shipment's "delivered completely" and data record are the collo's own scans at the same minute and place.
    expect(result.events?.map(event => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-17T10:42:00+01:00', 'delivered', 'Mintaváros, HU', 'delivered'],
      ['2026-03-17T08:01:00+01:00', 'Out for delivery', 'Mintaváros, HU', 'out_for_delivery'],
      ['2026-03-17T06:16:00+01:00', 'delivery depot', 'Mintaváros, HU', 'in_transit'],
      ['2026-03-17T00:04:00+01:00', 'Inbound Gateway', 'Példafalu, HU', 'in_transit'],
      ['2026-03-16T19:30:00+01:00', 'Outbound Gateway', 'Beispielstadt, AT', 'in_transit'],
      ['2026-03-16T06:05:00+01:00', 'shipment data received', 'AT', 'registered'],
    ]);
    // The sender, the receiver and who took the parcel wait behind the recipient's ZIP code and stay out.
    expect(JSON.stringify(result)).not.toMatch(/Webshop|Példa\b|J\. |\+36|\+43|example\.com|ORDER/);
  });

  it('reads the scans without a place after the parcel reached the destination country in that country\'s clock', () => {
    const arrived = parseEurodis(timeline(scan('Out for delivery', '2026-10-19, 08:11'), scan('delivery depot', '2026-10-19, 06:52'),
      scan('Inbound Gateway', '2026-10-16, 19:55 / Példafalu / HU'), scan('in transit', '2026-10-15, 15:12 / Exemplu / RO'),
      scan('depot', '2026-10-15, 09:00'), scan('Outbound Gateway', '2026-10-14, 08:54 / Primer / BG')), BARCODE);
    expect(arrived).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-10-19T08:11:00+02:00', destination_country: 'HU' });
    expect(arrived.events?.slice(0, 6).map(event => [event.time ?? event.local_time, event.description])).toEqual([
      ['2026-10-19T08:11:00+02:00', 'Out for delivery'], ['2026-10-19T06:52:00+02:00', 'delivery depot'],
      ['2026-10-16T19:55:00+02:00', 'Inbound Gateway'], ['2026-10-15T15:12:00+03:00', 'in transit'],
      // A scan without a place on the way keeps its wall clock.
      ['2026-10-15T09:00:00', 'depot'], ['2026-10-14T08:54:00+03:00', 'Outbound Gateway'],
    ]);
    // Before a scan in the destination country, a scan without a place could be anywhere on the way.
    const onTheWay = parseEurodis(timeline(scan('delivery depot', '2026-10-19, 06:52'), scan('in transit', '2026-10-15, 15:12 / Exemplu / RO')), BARCODE);
    expect(onTheWay.events?.[0]).toMatchObject({ local_time: '2026-10-19T06:52:00', description: 'delivery depot' });
    expect(onTheWay.events?.[0]).not.toHaveProperty('time');
  });

  it('hands the parcel to the delivering member under that member\'s own number', () => {
    for (const number of [BARCODE, SHIPMENT]) {
      const result = parseEurodis(delivered, number);
      expect(result, number).toMatchObject({ delivery_carrier: 'express-one', delivery_tracking_number: BARCODE });
      expect(deliveryHandoff('eurodis', number, normalizeCarrierResult(result)), number)
        .toEqual({ carrier: 'express-one', number: BARCODE, basis: 'partner' });
    }
    const austrian = edit($ => {
      $('.receiver-results').last().find('div').html('<br /><span>&nbsp;</span>Österreichische Post<br /> <br />+43 000 000 000<br />');
      $('.coli-wrapper td').filter((_, node) => $(node).text() === BARCODE).last().text('1000000000000000000001');
    });
    expect(parseEurodis(austrian, BARCODE)).toMatchObject({ delivery_carrier: 'austrian-post', delivery_tracking_number: '1000000000000000000001' });
    const named = (member: string) => edit($ => $('.receiver-results').last().find('div').html(`<br /><span>&nbsp;</span>${member}<br />`));
    const withoutPartner = edit($ => $('td.ref-tit').filter((_, node) => /delivery partner/.test($(node).text())).parent().remove());
    const partnerNumber = (value: string) => edit($ => $('td.ref-tit').filter((_, node) => /delivery partner/.test($(node).text())).next().text(value));
    // No member named, a member without an adapter here, no partner number, or one its rules refuse: no hand-off.
    for (const body of [transit, named('trans-o-flex'), named('PostNL'), withoutPartner, partnerNumber('AB000000000000000000000C'), partnerNumber('12/345')]) {
      const result = parseEurodis(body, body === transit ? FIRST : BARCODE);
      expect(result).not.toHaveProperty('delivery_carrier');
      expect(result).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads one collo of a larger shipment on its own, and the whole shipment by its number', () => {
    const first = parseEurodis(transit, FIRST);
    expect(first).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'in transit',
      last_update: '2026-03-10T02:20:00+01:00', destination_country: 'DE' });
    expect(first).not.toHaveProperty('delivered_at');
    expect(first.events).toEqual([
      { time: '2026-03-10T02:20:00+01:00', description: 'in transit', location: 'Musterdorf, DE', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-09T11:21:00+01:00', description: 'Outbound Gateway', location: 'Ejemplo, ES', stage: 'in_transit', stage_source: 'carrier_map' },
      // A scan that names no country keeps its wall clock.
      { local_time: '2026-03-09T09:40:00', description: 'depot', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-08T18:20:00+01:00', description: 'depot', location: 'Ejemplo, ES', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(parseEurodis(transit, SECOND).events?.map(event => event.time)).toEqual(['2026-03-09T11:21:00+01:00', '2026-03-08T18:25:00+01:00']);
    const shipment = parseEurodis(transit, '7000000000002');
    expect(shipment.events?.map(event => [event.time ?? event.local_time, event.description])).toEqual([
      ['2026-03-10T02:20:00+01:00', 'in transit'], ['2026-03-09T11:21:00+01:00', 'Outbound Gateway'], ['2026-03-09T09:40:00', 'depot'],
      ['2026-03-08T18:25:00+01:00', 'depot'], ['2026-03-08T18:20:00+01:00', 'depot'],
    ]);
  });

  it('adds the shipment\'s own scans to its only collo', () => {
    const problem = edit($ => $('.ship-history ul').prepend('<li class="active"><span></span><div><h6>delivery problem</h6>2026-03-18, 09:00 / Mintaváros / HU</div></li>'));
    const result = parseEurodis(problem, BARCODE);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'delivery problem' });
    expect(result.events).toHaveLength(7);
    // A larger shipment's history may concern another collo, so a barcode does not take it.
    const larger = edit($ => $('.ship-history ul').html('<li><span></span><div><h6>delivery problem</h6>2026-03-11, 09:00 / Musterdorf / DE</div></li>'), transit);
    expect(parseEurodis(larger, FIRST).events).toHaveLength(4);
    expect(parseEurodis(larger, '7000000000002').events?.[0]).toMatchObject({ description: 'delivery problem', stage: 'exception' });
  });

  it('keeps the stage before a delivery arrangement and reads a clock the autumn change repeats as its first occurrence', () => {
    const arranged = parseEurodis(timeline(scan('special delivery agreement', '2026-10-25, 02:30 / Mintaváros / HU'),
      scan('Out for delivery', '2026-10-24, 08:00 / Mintaváros / HU')), BARCODE);
    expect(arranged).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'special delivery agreement',
      last_update: '2026-10-25T02:30:00+02:00' });
    expect(arranged.events?.[0]).not.toHaveProperty('stage');
    const unknown = parseEurodis(timeline(scan('teleported', '2026-03-18, 10:00 / HU')), BARCODE);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'teleported' });
  });

  it('answers with the status alone when nothing is scanned yet', () => {
    const empty = edit($ => { $('ul.delivery-status-list').empty(); $('.ship-history ul').html('<li>No history information available</li>'); });
    expect(parseEurodis(empty, BARCODE)).toMatchObject({ summary_only: true, events: [], status: 'delivered', last_status_text: 'delivered' });
    const silent = edit($ => $('.coli-wrapper td.ref-tit').filter((_, node) => $(node).text() === 'Status:').parent().remove(), empty);
    expect(parseEurodis(silent, BARCODE)).toMatchObject({ summary_only: true, last_status_text: 'delivered completely' });
    const bare = edit($ => $('td.ref-tit').filter((_, node) => $(node).text() === 'Status:').parent().remove(), empty);
    expect(() => parseEurodis(bare, BARCODE)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('bounds the history it returns', () => {
    const long = timeline(...Array.from({ length: 250 }, (_, index) => scan(`in transit ${index}`, `2026-03-0${1 + Math.floor(index / 60)}, ${String(index % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')} / DE`)));
    const result = parseEurodis(long, BARCODE);
    expect(result.events).toHaveLength(200);
    expect(result.history_truncated).toBe(true);
    expect(() => parseEurodis(timeline(...Array.from({ length: 1001 }, () => scan('depot', '2026-03-01, 10:00'))), BARCODE))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the page to the whole number asked', () => {
    expect(parseEurodis(delivered, ` ${BARCODE.slice(0, 12)} ${BARCODE.slice(12)} `).status).toBe('delivered');
    for (const [body, number] of [[delivered, '100000000000000000000002'], [delivered, '7000000000009'], [transit, BARCODE],
      [edit($ => $('.shipm-wrapper').clone().insertAfter('.shipm-wrapper')), BARCODE]] as const) {
      expect(() => parseEurodis(body, number), number).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('reports a shipment absent only on the page\'s own notice', () => {
    for (const number of [BARCODE, SHIPMENT]) expect(() => parseEurodis(absent, number)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [absent.replace('No shipment matching with the entered tracking criteria!', 'Please enter a valid Eurodis reference.'),
      absent.replace('No shipment matching with the entered tracking criteria!', ''), '<html><body>Wartungsarbeiten</body></html>', '']) {
      expect(() => parseEurodis(body, BARCODE)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(() => parseEurodis(challenge, BARCODE)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects malformed pages and scans', () => {
    for (const body of [
      timeline(scan('depot', '2026-02-30, 10:00 / DE')), timeline(scan('depot', '2026-03-01, 24:00 / DE')),
      timeline(scan('depot', '01.03.2026, 10:00 / DE')), timeline(scan('', '2026-03-01, 10:00 / DE')),
      timeline('<li><span></span><div>2026-03-01, 10:00 / DE</div></li>'),
      edit($ => $('td.ref-tit').filter((_, node) => $(node).text() === 'Shipment number EURODIS:').next().text('70000000001')),
      edit($ => $('td.ref-tit').filter((_, node) => $(node).text() === 'Shipment number EURODIS:').parent().remove()),
      edit($ => $('.coli-wrapper td.ref-tit').filter((_, node) => $(node).text() === 'Colli number:').parent().remove()),
      edit($ => $('.coli-wrapper .ship-reference').remove()),
      edit($ => $('.shipm-wrapper').before('<p class="errorMsg">No shipment matching with the entered tracking criteria!</p>')),
      edit($ => $('.ship-info table tr').first().clone().insertAfter($('.ship-info table tr').first())),
    ]) {
      expect(() => parseEurodis(body, BARCODE)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes 24-character barcodes and thirteen-digit shipment numbers, and nothing else', () => {
    expect(eurodisLookup(' 1000 0000 0000 0000 0000 0001 ')).toEqual({ number: BARCODE, kind: 'collo' });
    expect(eurodisLookup('abc000000000000000000001')).toEqual({ number: 'ABC000000000000000000001', kind: 'collo' });
    expect(eurodisLookup('7000-000-000001')).toEqual({ number: SHIPMENT, kind: 'shipment' });
    for (const number of ['', '12345', '700000000000', '70000000000001', '10000000000000000000001', '1000000000000000000000001',
      'ABCDEFGHIJKLMNOPQRSTUVWX', 'A00000000000']) {
      expect(() => eurodisLookup(number), number).toThrow(InvalidInputError);
    }
  });

  it('maps every recorded wording, and the status map answers by wording alone', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(eurodisStage(entry.wording)?.stage, entry.wording).toBe(stage);
      expect(eurodisQuiet(entry.wording), entry.wording).toBe(stage === undefined);
      expect(statusMapAnswer({ carrier: 'eurodis', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(statusMapAnswer({ carrier: 'eurodis', providerCode: null, description: 'Teleported' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString']) expect(eurodisStage(wording)?.source, wording).not.toBe('carrier_map');
  });

  it('opens the tracker from its link', () => {
    expect(parseTrackingInput(`https://eurodis.com/track-trace?track_and_trace_hidden_field=trackCollo&trackCollo-input-of=${BARCODE}`))
      .toMatchObject({ trackingNumber: BARCODE, carrier: 'eurodis', source: 'link' });
  });

  it('asks the page once for a barcode and posts its form for a shipment number, with no session', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.has('cookie')).toBe(false);
      if (init?.method === 'POST') {
        expect(String(url)).toBe('https://eurodis.com/track-trace');
        expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
        expect(String(init.body)).toBe(`track_and_trace_hidden_field=trackEurodis&trackEurodis-input=${SHIPMENT}`);
      } else {
        expect(String(url)).toBe(`https://eurodis.com/track-trace?${BARCODE}`);
        expect(init?.method).toBe('GET');
      }
      return reply();
    });
    const instance = adapter(environment(fetcher));
    expect(instance.recognize).toBeUndefined();
    expect(await instance.track({ number: ` ${BARCODE} ` })).toMatchObject({ status: 'delivered' });
    expect(await instance.track({ number: SHIPMENT })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(instance.track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the HTTP failure taxonomy, retries a failed connection once and bounds bodies', async () => {
    const absentOnce = vi.fn(async () => reply(absent));
    await expect(new EurodisTracker({ fetcher: absentOnce as unknown as typeof fetch }).fetch(BARCODE)).rejects.toMatchObject({ kind: 'not_found' });
    expect(absentOnce).toHaveBeenCalledTimes(1);
    for (const [body, status, kind] of [['', 302, 'indeterminate'], [absent, 403, 'challenge'], [absent, 429, 'rate_limited'],
      [absent, 503, 'maintenance'], [absent, 500, 'indeterminate'], [absent, 404, 'indeterminate'], [absent, 410, 'indeterminate'], [delivered, 203, 'indeterminate']] as const) {
      const fetcher = vi.fn(async () => reply(body, status, status === 302 ? { Location: '/' } : {})) as unknown as typeof fetch;
      await expect(new EurodisTracker({ fetcher }).fetch(BARCODE), String(status)).rejects.toMatchObject({ kind });
    }
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    expect(await new EurodisTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(BARCODE)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const large = vi.fn(async () => new Response(new Uint8Array(1_100_000))) as unknown as typeof fetch;
    await expect(new EurodisTracker({ fetcher: large }).fetch(BARCODE)).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:schema|indeterminate)$/) });
  });
});

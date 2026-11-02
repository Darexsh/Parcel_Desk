import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PFC_EXPRESS_API, PfcExpressTracker, pfcExpressLookupUrl } from './adapter.js';
import { normalizePfcExpressNumber, parsePfcExpress, pfcExpressText } from './parser.js';
import { pfcExpressScan, pfcExpressStage, pfcExpressSummaryStage, statusMap } from './status.js';
import carrierJson from './carrier.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic PFC order numbers dated in 2029: an account, the date and a serial.
const TRANSIT = 'R1000002912030001';
const DELIVERED = 'R1000002912130002';
// A five-digit account with an unpadded serial, thirteen characters long.
const RETURNED = 'R100002912132';
const UNKNOWN = 'R1000002912230003';

const fragment = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const raw = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
/** The tracker's reply: the fragment as a JSON string. */
const json = (html: string) => raw(JSON.stringify(html));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The transit fixture with its scan list replaced. */
const withScans = (scans: string) => fragment('transit').replace(/<ul>[\s\S]*<\/ul>/, `<ul>${scans}</ul>`);
const scan = (clock: string, message: string) => `<li class="mb5"><div class="vm pl20 rel"><span class="wd_message">${message}</span>`
  + `<div class="Tnode_dot_new"><span class="dib wd_count">1</span></div><span class="abs wd_time C">${clock}</span></div></li>`;
const summary = (result: ReturnType<typeof parsePfcExpress>) => result.events!.map((event) =>
  [event.local_time, event.description, event.location ?? null, event.stage ?? null]);

describe('PFC Express HTTP adapter', () => {
  it('asks the tracker\'s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fragment('transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PfcExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' r100 0002 9120 30001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PFC_EXPRESS_API}?handler=AccessRedirect&nos=${TRANSIT}%2C&language=cn`);
    expect(pfcExpressLookupUrl(TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pfc-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel in transit, with its channel, destination and delivering carrier\'s number', () => {
    const result = parsePfcExpress(fragment('transit'), TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment has been handed in at terminal and forwarded.', last_update: null,
      last_update_local: '2029-12-14T16:51:46', expected_delivery: null,
      service_name: 'EUEX-V', destination_country: 'NO', delivery_tracking_number: 'LM123456785NO',
    });
    expect(summary(result)).toEqual([
      ['2029-12-14T16:51:46', 'The shipment has been handed in at terminal and forwarded.', null, 'in_transit'],
      // A hand-over to the delivering carrier is not a delivery.
      ['2029-12-14T12:30:00', 'Delivered to local carrier', null, 'in_transit'],
      ['2029-12-13T11:03:41', 'Clearance processing completed - Import', null, 'in_transit'],
      ['2029-12-13T10:06:43', 'In clearance processing - Import', null, 'customs'],
      ['2029-12-13T06:21:00', 'International flight has arrived', null, 'in_transit'],
      ['2029-12-10T18:27:00', 'International flight has departed', null, 'in_transit'],
      ['2029-12-09T21:52:33', 'Arrived at the origin international airport', null, 'in_transit'],
      ['2029-12-09T11:52:38', 'Shipment is in transit to next facility', null, 'in_transit'],
      ['2029-12-06T06:41:59', 'Departed from sort facility', null, 'in_transit'],
      ['2029-12-06T01:40:20', 'Arrived at origin facility', null, 'in_transit'],
      ['2029-12-04T22:07:13', 'Shipment sent to destination', null, 'in_transit'],
      ['2029-12-04T19:37:16', 'Shipment picked up', null, 'accepted'],
      ['2029-12-03T22:42:50', 'Shipment information received', null, 'registered'],
    ]);
    // The clocks carry no zone and can be Beijing's for scans abroad: none becomes an instant.
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The merchant's reference is not kept.
    expect(JSON.stringify(result)).not.toContain('70001');
  });

  it('reads a delivery from the tracker\'s tab, without who signed, phone numbers or repeated scans', () => {
    const result = parsePfcExpress(fragment('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Left with Individual', last_update: null, last_update_local: '2029-12-20T14:46:00',
      service_name: 'USEX-P', destination_country: 'US', delivery_tracking_number: '9200190000000000000016',
    });
    // A delivery on a clock of unknown zone has no instant to give.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(summary(result)).toEqual([
      ['2029-12-20T14:46:00', 'Delivered, Left with Individual', 'SAMPLETOWN, ME', 'delivered'],
      ['2029-12-20T07:02:00', 'Out for Delivery, call for help', 'SAMPLETOWN, ME', 'out_for_delivery'],
      ['2029-12-17T03:10:00', 'Custom clearance completed', null, 'in_transit'],
      ['2029-12-16T19:12:00', 'Parcel arrives at Airport, Parcel Arrival', null, 'in_transit'],
      ['2029-12-16T02:34:00', 'Parcel is leaving Airport, Parcel Leaving Port', null, 'in_transit'],
      ['2029-12-14T23:00:00', 'Parcel processed at Shenzhen Sorting Centre.', null, 'in_transit'],
      ['2029-12-14T06:35:00', 'Departed Shipping Partner Facility, USPS Awaiting Item', 'SAMPLETON, CA', 'in_transit'],
      ['2029-12-14T03:05:00', 'Picked Up By Shipping Partner, USPS Awaiting Item', 'SAMPLETON, CA', 'in_transit'],
      // The older page's facility code before the wording is the scan's place.
      ['2029-12-13T23:33:00', 'Picked up shipment.', 'PFCSZ', 'accepted'],
      ['2029-12-13T14:29:00', 'Parcel Data Received', null, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE NAME|signed|0000 0000|70002/);
  });

  it('keeps a relayed Chinese post scan to the clauses before its contacts', () => {
    const result = parsePfcExpress(fragment('returned'), RETURNED);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Export cancelled by Customs', last_update_local: '2029-12-23T22:37:00',
      service_name: 'SZEUB-BA', destination_country: 'IN', delivery_tracking_number: 'LM123456799CN',
    });
    expect(summary(result).slice(0, 5)).toEqual([
      ['2029-12-23T22:37:00', 'Export cancelled by Customs', null, 'exception'],
      ['2029-12-23T20:07:08', '您的邮件已代签收，成功退回至寄件人', null, 'returned'],
      ['2029-12-23T20:06:13', '邮件正在派送中，请耐心等待', null, 'out_for_delivery'],
      ['2029-12-23T20:06:12', '邮件到达【深圳市示例营业部】', null, 'in_transit'],
      ['2029-12-23T10:57:53', '邮件离开【广东省深圳市国际互换局】，正在发往下一站', null, 'in_transit'],
    ]);
    expect(summary(result).map(([, , , stage]) => stage)).not.toContain(null);
    expect(JSON.stringify(result)).not.toMatch(/王小明|1[3-9]0{9}|0755|11183|寄件人签收|电话|投诉/);
  });

  it('drops contacts, signers, phones and e-mail addresses from a scan\'s text', () => {
    expect(pfcExpressText('Delivered, signed by SAMPLE NAME')).toBe('Delivered');
    expect(pfcExpressText('Delivered. Received by: SAMPLE NAME')).toBe('Delivered');
    expect(pfcExpressText('Courier +1 (555) 000-0000 or sample@example.com')).toBe('Courier or');
    expect(pfcExpressText('已签收，签收人：示例')).toBe('已签收');
    expect(pfcExpressText('邮件离开【深圳市示例营业部】，正在发往【深圳国际】')).toBe('邮件离开【深圳市示例营业部】，正在发往【深圳国际】');
    expect(pfcExpressText('请联系【示例】')).toBe('');
    expect(pfcExpressText('2029-12-13 arrived')).toBe('2029-12-13 arrived');
  });

  it('reads either order of the tracker\'s clocks, and a scan with only contacts as none', () => {
    const result = parsePfcExpress(withScans(scan('2029/12/5 7:02:09', 'Shipment sent to destination') + scan('2029-12-04 19:37', 'Shipment picked up')
      + scan('12/4/2029 08:00:00', '请联系快递员【电话：13800000000】')), TRANSIT);
    expect(summary(result)).toEqual([
      ['2029-12-05T07:02:09', 'Shipment sent to destination', null, 'in_transit'],
      ['2029-12-04T19:37:00', 'Shipment picked up', null, 'accepted'],
    ]);
  });

  it('settles a held parcel by its tab, and a scan without a stage by the tab', () => {
    expect(parsePfcExpress(fragment('transit').replace('date="Transit"', 'date="Alert"'), TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    expect(parsePfcExpress(withScans(scan('12/04/2029 08:00:00', 'Synthetic scan')), TRANSIT))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    const processing = parsePfcExpress(withScans(scan('12/04/2029 08:00:00', 'Synthetic scan'))
      .replace('date="Transit"', 'date="Processing"'), TRANSIT);
    expect(processing).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic scan' });
    expect(processing).not.toHaveProperty('current_stage');
    // A tab that is not a delivery leaves the stage to the newest staged scan.
    expect(parsePfcExpress(fragment('transit').replace('date="Transit"', 'date="Processing"'), TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('names the delivering carrier\'s number only when the column has one other number', () => {
    const tracking = (value: string) => parsePfcExpress(fragment('transit').replace('LM123456785NO', value), TRANSIT).delivery_tracking_number;
    expect(tracking('LM123456785NO/')).toBe('LM123456785NO');
    expect(tracking('')).toBeUndefined();
    expect(tracking(TRANSIT)).toBeUndefined();
    expect(tracking('70001')).toBeUndefined();
    expect(tracking('LM123456785NO/LM123456799CN')).toBeUndefined();
    expect(tracking('SAMPLE')).toBeUndefined();
    // A route without an origin still names the destination; one that is no route names none.
    expect(parsePfcExpress(fragment('transit').replace('CN/NO', '/NO'), TRANSIT).destination_country).toBe('NO');
    expect(parsePfcExpress(fragment('transit').replace('CN/NO', 'Norway'), TRANSIT)).not.toHaveProperty('destination_country');
  });

  it('reads the tracker\'s not-found item as not found, and nothing else', () => {
    expect(() => parsePfcExpress(fragment('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePfcExpress(fragment('not-found').replace('Not Found', 'Processing'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // Another number's not-found item says nothing about this one.
    expect(() => parsePfcExpress(fragment('not-found'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the reply to the whole number', () => {
    expect(() => parsePfcExpress(fragment('transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePfcExpress(fragment('transit').replace(TRANSIT, `${TRANSIT}9`), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parsePfcExpress(fragment('not-found') + fragment('transit'), TRANSIT)).toMatchObject({ service_name: 'EUEX-V' });
    expect(() => parsePfcExpress(fragment('transit') + fragment('transit'), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads an empty answer as inconclusive and an item without scans as no history', () => {
    expect(() => parsePfcExpress('', TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePfcExpress(withScans(''), TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const body of [
      { html: fragment('transit') },
      null,
      '<div class="result">Not Found</div>',
      fragment('transit').replace('date="Transit"', 'date="Returned"'),
      fragment('transit').replace('<td width="8%" align="center"><span class="lhh">EUEX-V</span></td>', ''),
      fragment('transit').replace('<div class="cell_bk lh14">70001</div>', '70001'),
      withScans(scan('12/04/2029', 'Shipment picked up')),
      withScans(scan('13/04/2029 08:00:00', 'Shipment picked up')),
      withScans(scan('02/30/2029 08:00:00', 'Shipment picked up')),
      withScans(scan('12/04/2029 24:00:00', 'Shipment picked up')),
      withScans(scan('12/04/2029 08:00:00', ' ')),
      withScans(scan('12/04/2029 08:00:00', '----SAMPLETOWN')),
      withScans('<li><span class="wd_message">Shipment picked up</span></li>'),
      withScans(scan('12/04/2029 08:00:00', 'Shipment picked up').repeat(301)),
      fragment('not-found').repeat(51),
    ]) {
      expect(() => parsePfcExpress(body, TRANSIT), JSON.stringify(body)?.slice(-200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a bot check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(raw(body, init))).track({ number: UNKNOWN });
    await expect(lookup(JSON.stringify(fragment('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.pfctrack.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>PFC</title><body>Index</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('{"items":[]}')).rejects.toMatchObject({ kind: 'schema' });
    // The answer to a request without a number.
    await expect(lookup('""')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the not-found answer, and asks nothing for a number PFC does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fragment('transit')))
      .mockResolvedValueOnce(json(fragment('not-found')));
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('LM123456785NO')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failure to reach PFC, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(fragment('transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PfcExpressTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pfc-express', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers PFC does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['LM123456785NO', 'R12345', 'R1000002913030001', 'R1000002912320001', 'R1000001912030001', 'R10000029120300012', `R${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePfcExpressNumber(' r100000-2912030001 ')).toBe(TRANSIT);
    expect(normalizePfcExpressNumber(RETURNED)).toBe(RETURNED);
  });

  it('routes a number filed under PFC Express, or its tracking link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(PFC_EXPRESS_API)
      ? json(fragment('transit')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: TRANSIT, carrier: 'pfc-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pfc-express', source: 'pfc-express', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === pfcExpressLookupUrl(TRANSIT))).toBe(true);
    expect(parseTrackingInput(`https://www.pfctrack.com/?nums=${TRANSIT}`)).toMatchObject({ trackingNumber: TRANSIT, carrier: 'pfc-express' });
  });
});

describe('PFC Express numbers', () => {
  it('suggests PFC for its order numbers from fourteen characters, as the adapter reads them', () => {
    const [rule] = carrierJson.detection;
    for (const number of [TRANSIT, DELIVERED, UNKNOWN, 'R10000291203001', 'R100002912031']) {
      expect(new RegExp(rule!.pattern).test(number), number).toBe(number.length >= 14);
      expect(normalizePfcExpressNumber(number)).toBe(number);
      expect((detectCarrierMatch(number).candidates as string[]).includes('pfc-express'), number).toBe(number.length >= 14);
    }
  });
});

describe('PFC Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (entry.code) {
        expect(pfcExpressSummaryStage(entry.code), entry.code).toBe(entry.stage ?? null);
        continue;
      }
      expect(pfcExpressScan(entry.wording), entry.wording).toMatchObject({ wording: entry.wording, stage: { stage: entry.stage, source: 'carrier_map' } });
      expect(statusMapAnswer({ carrier: 'pfc-express', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('reads a relayed China Post scan at any office, either casing, and leaves an unknown scan to the shared rules', () => {
    expect(pfcExpressStage('邮件到达【示例处理中心】')).toBe('in_transit');
    expect(pfcExpressStage('邮件已在【示例营业部】完成分拣，准备发出')).toBe('in_transit');
    expect(pfcExpressStage('SHIPMENT PICKED UP')).toBe('accepted');
    expect(pfcExpressScan('PFCGZ,picked up shipment.')).toEqual({ wording: 'picked up shipment.', facility: 'PFCGZ', stage: { stage: 'accepted', source: 'carrier_map' } });
    expect(pfcExpressScan('Synthetic scan')).toEqual({ wording: 'Synthetic scan', facility: '' });
    expect(pfcExpressSummaryStage('Returned')).toBeUndefined();
    expect(statusMap.stage(null, 'synthetic scan')).toBeUndefined();
    expect(statusMap.stage('Transit', 'shipment picked up')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'pfc-express', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});

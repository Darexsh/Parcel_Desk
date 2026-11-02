import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { ACS_PAGE, ACS_SEARCH, AcsCourierTracker, adapter } from './adapter.js';
import { parseAcs } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9000000015';
const ATTEMPTED = '9000000026';
const COMPACT = '9000000030';
const UNKNOWN = '9000000041';
const KEY = `CfDJ8${'A1b2_C3d4-'.repeat(8)}`;
const NEW_KEY = `CfDJ8${'Z9y8_X7w6-'.repeat(8)}`;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Item = { trackingNumber: string; shipmentStatusId: number; statusHistory: Record<string, unknown>[]; notes: string; expectedDeliveryDate?: string };
const fixture = (name: string) => JSON.parse(text(name)) as { count: number; items: Item[] };
const page = (key = KEY) => new Response(`<html><body><div class="card"><div id="app-root" class="updates"
  apiBaseUrl="https://api.acscourier.net" recaptchaPublicKey="6LeSynthetic" lang="en-US"
  publicToken="${key}" country="CY" name="app-root" module="search-parcels"></div></div></body></html>`,
{ headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const reply = (name: string) => new Response(text(name), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const problem = (status: number) => new Response(`{"type":"https://httpstatuses.io/${status}","status":${status}}`,
  { status, headers: { 'Content-Type': 'application/problem+json; charset=utf-8', 'Retry-After': '120' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A transport that serves the tracking page, then the given API replies in turn. */
const site = (...answers: (() => Response)[]) => vi.fn<typeof fetch>(async input => {
  if (String(input) === ACS_PAGE) return page();
  const next = answers.length > 1 ? answers.shift()! : answers[0]!;
  return next();
});
const urls = (fetcher: ReturnType<typeof site>) => fetcher.mock.calls.map(([url]) => String(url));

afterEach(() => vi.restoreAllMocks());

describe('ACS Courier HTTP adapter', () => {
  it("takes the key from the Cypriot tracker's page, then asks the search API for the whole number", async () => {
    const fetcher = site(() => reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AcsCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 900 000 0015 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(urls(fetcher)).toEqual([ACS_PAGE, `${ACS_SEARCH}${DELIVERED}`]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ signal: expect.any(AbortSignal), redirect: 'error', headers: {
      Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0', Origin: 'https://cyp.acscourier.net',
      'X-Encrypted-Key': KEY, 'X-Country': 'CY', 'Accept-Language': 'en-US' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'acs-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reuses the key for a few minutes, then loads the page again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    const fetcher = site(() => reply('delivered'));
    const tracker = new AcsCourierTracker({ fetcher });
    await tracker.fetch(DELIVERED);
    await tracker.fetch(DELIVERED);
    expect(urls(fetcher).filter(url => url === ACS_PAGE)).toHaveLength(1);
    now.mockReturnValue(1_900_000_000_000 + 5 * 60_000);
    await tracker.fetch(DELIVERED);
    expect(urls(fetcher)).toEqual([ACS_PAGE, `${ACS_SEARCH}${DELIVERED}`, `${ACS_SEARCH}${DELIVERED}`, ACS_PAGE, `${ACS_SEARCH}${DELIVERED}`]);
  });

  it('refreshes a kept key the API refuses as expired, once', async () => {
    const keys = [KEY, NEW_KEY];
    let valid = KEY;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === ACS_PAGE) return page(keys.shift() ?? 'CfDJ8SyntheticLaterKeyCfDJ8SyntheticLaterKey');
      return new Headers(init?.headers).get('X-Encrypted-Key') === valid ? reply('delivered') : problem(406);
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new AcsCourierTracker({ fetcher, recorder });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(urls(fetcher)).toEqual([ACS_PAGE, `${ACS_SEARCH}${DELIVERED}`, `${ACS_SEARCH}${DELIVERED}`]);
    valid = NEW_KEY;
    fetcher.mockClear();
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(urls(fetcher)).toEqual([`${ACS_SEARCH}${DELIVERED}`, ACS_PAGE, `${ACS_SEARCH}${DELIVERED}`]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'refresh', outcome: 'ok', fallbackFrom: 'direct',
      fallbackReason: 'indeterminate' }));
    // A fresh key the API refuses is no expiry: the page or the gate changed.
    valid = 'none';
    fetcher.mockClear();
    await expect(tracker.fetch(DELIVERED)).rejects.toMatchObject({ kind: 'transport' });
    expect(urls(fetcher)).toEqual([`${ACS_SEARCH}${DELIVERED}`, ACS_PAGE, `${ACS_SEARCH}${DELIVERED}`]);
    fetcher.mockClear();
    await expect(tracker.fetch(DELIVERED)).rejects.toMatchObject({ kind: 'transport' });
    expect(urls(fetcher)).toEqual([ACS_PAGE, `${ACS_SEARCH}${DELIVERED}`]);
  });

  it('reads a parcel collected from a SmartPoint newest first, without names, notes, reasons or phones', () => {
    const result = parseAcs(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery via SmartPoint', last_update: null, last_update_local: '2030-03-07T15:55:24',
      expected_delivery: null, pickup_point: 'SMARTPOINT LOCKER SAMPLEVILLE' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map(event => [event.local_time, event.stage, event.stage_source, event.description, event.location])).toEqual([
      ['2030-03-07T15:55:24', 'delivered', 'carrier_map', 'Delivery via SmartPoint', 'SMARTPOINT LOCKER SAMPLEVILLE'],
      ['2030-03-07T15:55:24', 'delivered', 'carrier_map', 'Delivery to consignee', 'SMARTPOINT LOCKER SAMPLEVILLE'],
      ['2030-03-05T17:57:57', 'ready_for_pickup', 'none', 'SENT NOTIFICATION', 'SAMPLEVILLE'],
      ['2030-03-05T17:56:40', 'ready_for_pickup', 'none', 'SENT EMAIL NOTIFICATION', 'SAMPLEVILLE'],
      ['2030-03-05T17:46:39', 'ready_for_pickup', 'carrier_map', 'Shipment placed in SmartPoint', 'SMARTPOINT LOCKER SAMPLEVILLE'],
      ['2030-03-05T13:31:34', 'out_for_delivery', 'carrier_map', 'On delivery', 'SAMPLEVILLE'],
      ['2030-03-05T07:35:42', 'in_transit', 'carrier_map', 'Arrival to', 'SAMPLEVILLE'],
      ['2030-03-04T21:55:46', 'in_transit', 'carrier_map', 'Arrival-departure from HUB', 'HUB EXAMPLE'],
      ['2030-03-04T21:55:46', 'in_transit', 'carrier_map', 'Transit from HUB', 'HUB EXAMPLE'],
      ['2030-03-04T17:37:37', 'in_transit', 'carrier_map', 'Departure to destination SAMPLEVILLE', 'EXAMPLE NORTH'],
      ['2030-03-04T14:37:51', 'accepted', 'carrier_map', 'Pick-up from sender', 'EXAMPLE NORTH'],
      ['2030-03-04T14:35:00', 'registered', 'carrier_map', 'Print take delivery status', 'EXAMPLE NORTH'],
      ['2030-03-04T10:30:41', 'registered', 'carrier_map', 'Print ACSConnect/WebTools label', 'EXAMPLE NORTH'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.provider_code === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/J\*\*\*|D\*\*|Recipient|EXAMPLE SHOP|S\*\*\*|2100000000|2600000000|EX-\d|PICK UP/);
  });

  it('keeps a failed attempt current through the notice after it, with its reason', () => {
    const result = parseAcs(fixture('failed-attempt'), ATTEMPTED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      last_status_text: 'Not delivered (DIFFICULT TO ACCESS AREA)', last_update_local: '2030-03-05T15:21:00', expected_delivery: null });
    expect(result.events![0]).toEqual({ local_time: '2030-03-05T15:21:00', description: 'SENT NOTIFICATION', location: 'SAMPLEVILLE',
      stage: 'failed_attempt', stage_source: 'none' });
    expect(result.events![1]).toMatchObject({ local_time: '2030-03-05T15:20:10', description: 'Not delivered (DIFFICULT TO ACCESS AREA)',
      stage: 'failed_attempt', stage_source: 'carrier_map' });
    expect(result.pickup_point).toBeUndefined();
    // The sender's name on the pickup scan and the masked recipient stay out.
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE SHOP|J\*\*\*/);
  });

  it('reads no masked name, phone or address as a failed delivery\'s reason', () => {
    for (const info of ['J*** D**', 'CALL 6900000000', 'example@example.com', '-', '']) {
      const payload = fixture('failed-attempt');
      payload.items[0]!.statusHistory[5]!.info = info;
      expect(parseAcs(payload, ATTEMPTED).events![1], info).toMatchObject({ description: 'Not delivered', stage: 'failed_attempt' });
    }
  });

  it('keeps the estimated day only while the parcel moves and the day is still ahead', () => {
    const moving = fixture('failed-attempt');
    moving.items[0]!.statusHistory = moving.items[0]!.statusHistory.slice(0, 4);
    expect(parseAcs(moving, ATTEMPTED)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Arrival to', expected_delivery: '2030-03-06' });
    moving.items[0]!.expectedDeliveryDate = '2030-03-04T00:00:00';
    expect(parseAcs(moving, ATTEMPTED)).toMatchObject({ expected_delivery: null });
  });

  it("lets a delivery problem or return in the summary outrank the parcel's scans", () => {
    const returned = fixture('failed-attempt');
    returned.items[0]!.shipmentStatusId = 7;
    expect(parseAcs(returned, ATTEMPTED)).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to sender' });
    const refused = fixture('failed-attempt');
    refused.items[0]!.shipmentStatusId = 1;
    refused.items[0]!.statusHistory = refused.items[0]!.statusHistory.slice(0, 5);
    expect(parseAcs(refused, ATTEMPTED)).toMatchObject({ current_stage: 'exception', last_status_text: 'Denial of delivery' });
  });

  it('keeps a scan it cannot stage visible without moving the parcel', () => {
    const payload = fixture('failed-attempt');
    payload.items[0]!.statusHistory = [...payload.items[0]!.statusHistory.slice(0, 4),
      { controlPointDate: '2030-03-05T10:00:00', controlPoint: 'SAMPLEVILLE', description: 'Synthetic new scan', info: '-' }];
    const result = parseAcs(payload, ATTEMPTED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Synthetic new scan' });
    expect(result.events![0]).toEqual({ local_time: '2030-03-05T10:00:00', description: 'Synthetic new scan', location: 'SAMPLEVILLE' });
  });

  it("reads the Greek site's shortened history by milestone, without the steps still to come", () => {
    const result = parseAcs(fixture('compact'), COMPACT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'At the ACS point',
      last_update_local: '2030-03-06T09:09:32', expected_delivery: '2030-03-06' });
    expect(result.events).toEqual([
      { local_time: '2030-03-06T09:09:32', description: 'At the ACS point', provider_code: '300', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2030-03-04T19:23:00', description: 'At the ACS hub', provider_code: '200', stage: 'in_transit', stage_source: 'carrier_map' },
      // A pickup the history dates by day only.
      { local_time: '2030-03-04', description: 'Pick up', provider_code: '100', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
  });

  it('answers a summary without scans, and reads an empty unknown reply as not found only with its note', () => {
    const summary = fixture('delivered');
    summary.items[0]!.statusHistory = [];
    expect(parseAcs(summary, DELIVERED)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      provider_code: '4', summary_only: true, last_update_local: null, events: [] });
    expect(() => parseAcs(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const greek = fixture('not-found');
    greek.items[0]!.notes = 'Η αποστολή δεν βρέθηκε';
    expect(() => parseAcs(greek, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const silent = fixture('not-found');
    silent.items[0]!.notes = '-';
    expect(() => parseAcs(silent, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the reply to the whole requested number', () => {
    expect(() => parseAcs(fixture('delivered'), '9000000052')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = fixture('delivered');
    twice.items.push(twice.items[0]!);
    expect(() => parseAcs(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const undated = fixture('delivered');
    undated.items[0]!.statusHistory[3]!.controlPointDate = '04/03/2030 17:37';
    expect(() => parseAcs(undated, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const unstated = fixture('delivered');
    delete (unstated.items[0] as Partial<Item>).shipmentStatusId;
    expect(() => parseAcs(unstated, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAcs({ items: {} }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('recognizes a known parcel and the explicit unknown reply with one lookup each', async () => {
    const fetcher = site(() => reply('delivered'), () => reply('not-found'));
    const instance = carrier(fetcher);
    await expect(instance.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2030-03-07T15:55:24' });
    await expect(instance.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(instance.recognize!('900000001')).resolves.toEqual({ known: false });
    expect(urls(fetcher)).toEqual([ACS_PAGE, `${ACS_SEARCH}${DELIVERED}`, `${ACS_SEARCH}${UNKNOWN}`]);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [400, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the search API as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = site(() => problem(status));
      const instance = carrier(fetcher);
      await expect(instance.track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(instance.recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('keeps a refused or changed tracking page apart from a missing parcel', async () => {
    const denied = '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference&#32;&#35;18&#46;0 https&#58;&#47;&#47;errors&#46;edgesuite&#46;net</BODY></HTML>';
    for (const [answer, kind] of [[() => new Response(denied, { status: 403 }), 'challenge'], [() => new Response(denied), 'challenge'],
      [() => new Response('<html><div id="app-root" publicToken=""></div></html>'), 'schema'], [() => problem(404), 'transport']] as const) {
      const fetcher = vi.fn<typeof fetch>(async () => answer());
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps blocked HTTP 200 replies and malformed JSON apart from missing parcels', async () => {
    for (const [body, kind] of [['<html><title>Access Denied</title></html>', 'challenge'], ['<html>Maintenance</html>', 'schema'],
      ['{"count":0,"items":[]}', 'schema']]) {
      const fetcher = site(() => new Response(body));
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects numbers ACS does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['900000001', '90000000155', 'AB90000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a parcel filed under ACS Courier to the adapter and keeps its wall clocks', async () => {
    const fetcher = site(() => reply('delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'acs-courier' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'acs-courier', source: 'acs-courier', result: { current_stage: 'delivered' } });
    expect(answer.result.events[0]).toMatchObject({ local_time: '2030-03-07T15:55:24' });
    expect(urls(fetcher).every(url => url === ACS_PAGE || url.startsWith(ACS_SEARCH))).toBe(true);
  });
});

describe('ACS Courier status vocabulary', () => {
  it('records every wording and code the map knows with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && entry.code ? entry.code : null;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(statusMapAnswer({ carrier: 'acs-courier', providerCode: null, description: 'Departure to destination EXAMPLE 2' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'acs-courier', providerCode: null, description: 'Pick-up' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'acs-courier', providerCode: null, description: 'SENT NOTIFICATION' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'acs-courier', providerCode: '400', description: 'Out for delivery' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'acs-courier', providerCode: '8', description: 'In Transit' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'acs-courier', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});

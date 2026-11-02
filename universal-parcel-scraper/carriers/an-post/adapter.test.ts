// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { AN_POST_APP_API } from './app.js';
import { normalizeAnPostNumber, parseAnPostEvents, parseAnPostSummary } from './parser.js';
import { ATTEMPT_DELIVERED, ATTEMPT_MADE, anPostScanStage, anPostSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'CP000000005IE';
const OTHER = 'CP000000014IE';
const REFERENCE = 'PSS00000001';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string): unknown => JSON.parse(fixture(name));
const PRIVATE = /SYNTHETIC (?:RECIPIENT|SIGNATORY|OFFICE|SUMMARY REASON|SCAN REASON)|PSS000000SYNTHETIC|IRELAND/;
const instance = (fetcher: typeof fetch) => adapter({
  fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, userAgent: 'Host/1.0',
});
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
/** The service: a summary, then the history, each replaceable. */
const service = (summary: () => Response = () => reply(json('summary.json')), events: () => Response = () => reply(json('events.json'))) =>
  vi.fn<typeof fetch>(async (input) => (String(input).endsWith('/GetItemSummary') ? summary() : events()));
const summaryOf = (items: unknown[]) => ({ getItemSummaryResponse: { GetItemSummaryResult: items } });
const eventsOf = (rows: unknown[]) => ({ getEventsResponse: { GetEventsResult: rows } });
const summaryItem = () => (json('summary.json') as { getItemSummaryResponse: { GetItemSummaryResult: Record<string, unknown>[] } })
  .getItemSummaryResponse.GetItemSummaryResult[0]!;
const eventRows = () => (json('events.json') as { getEventsResponse: { GetEventsResult: Record<string, unknown>[] } })
  .getEventsResponse.GetEventsResult;
/** The summary as the service gives it, naming the row as the current scan. */
const summaryFor = (row: Record<string, unknown>, status = row.activity) => parseAnPostSummary(summaryOf([{ ...summaryItem(),
  status, reason: row.reason, date: row.date }]), NUMBER);
const scan = (traceCode: number, activity: string, date: string) => ({ activity, date, location: '', reason: '', traceCode });

describe('An Post numbers', () => {
  it('takes S10 numbers with a valid check digit, its own and those of mail from abroad, and senders\' references', () => {
    expect(normalizeAnPostNumber(' cp 000 000 005 ie ')).toBe(NUMBER);
    expect(normalizeAnPostNumber('CP000000005GB')).toBe('CP000000005GB');
    expect(normalizeAnPostNumber(' pss 0000 0001 ')).toBe(REFERENCE);
    expect(normalizeAnPostNumber('000000005IE')).toBe('000000005IE');
    // An S10 number that fails its check digit is no reference.
    for (const number of ['CP000000006IE', 'CP000000006GB', 'CP000000005I"E', 'PSSABCDEFGH', 'PSS01', `PSS${'0'.repeat(33)}`]) {
      expect(() => normalizeAnPostNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it.each(['item', 'barcode'])('reads the number out of a pasted An Post history link with %s', param => {
    expect(parseTrackingInput(`https://www.anpost.com/Post-Parcels/Track/History?${param}=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'an-post', source: 'link' });
  });
});

describe('An Post guest history', () => {
  it('binds the summary to the number and keeps newest-first clocks without people or references', async () => {
    const fetcher = service();
    const result = normalizeCarrierResult(await instance(fetcher).track({ number: NUMBER }, { budgetMs: 5_000 }));
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Your item is now available for collection', last_update: null, last_update_local: '2026-03-12T11:56:00',
      expected_delivery: null });
    expect(result.summary_only).toBeUndefined();
    expect(result.events?.map(event => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-03-12T11:56:00', '70', 'ready_for_pickup'],
      ['2026-03-12T07:08:00', '4', 'out_for_delivery'],
      ['2026-03-12T05:30:00', '4', 'out_for_delivery'],
      ['2026-03-11T14:01:00', '67', 'in_transit'],
      ['2026-03-09T07:49:00', '49', 'in_transit'],
      ['2026-03-05T16:03:38', '48', 'accepted'],
      ['2026-03-04T14:37:34', '15', 'accepted'],
      ['2026-03-02T20:12:39', '35', 'registered'],
    ]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
    // An Post's own scans are on Irish time, GMT in March; the partner's relayed ones keep their wall clocks.
    expect(result.events?.map(event => event.time)).toEqual([undefined, undefined, undefined, undefined, undefined,
      '2026-03-05T16:03:38+00:00', '2026-03-04T14:37:34+00:00', '2026-03-02T20:12:39+00:00']);
    expect(result.events?.filter(event => event.location)).toEqual([expect.objectContaining({ provider_code: '48', location: 'SYNTHETIC MAIL CENTRE' })]);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[summaryUrl, summaryInit], [eventsUrl, eventsInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(summaryUrl).toBe(`${AN_POST_APP_API}/GetItemSummary`);
    expect(eventsUrl).toBe(`${AN_POST_APP_API}/GetEvents`);
    expect(JSON.parse(String(summaryInit.body))).toEqual({ getItemSummary: { trackingItems: [NUMBER] } });
    expect(JSON.parse(String(eventsInit.body))).toEqual({ getEvents: { barcodeItem: NUMBER } });
    for (const init of [summaryInit, eventsInit]) {
      expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), cache: 'no-store', redirect: 'error' });
      const headers = new Headers(init.headers);
      expect(headers.get('ocp-apim-subscription-key')).toMatch(/^[a-f\d]{32}$/);
      expect(headers.get('user-agent')).toBe('Host/1.0');
      expect(headers.get('content-type')).toBe('application/json; charset=UTF-8');
      expect(headers.get('cookie')).toBeNull();
    }
  });

  it('sends the canonical number however the summary spells it', async () => {
    const item = { ...summaryItem(), anPostNo: ' cp000000005ie ' };
    const fetcher = service(() => reply(summaryOf([item])));
    await instance(fetcher).track({ number: NUMBER });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ getEvents: { barcodeItem: NUMBER } });
  });

  it('answers an empty summary as not found after one request', async () => {
    const fetcher = service(() => reply(fixture('unknown.json')));
    await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  /** The service asked by a sender's reference: no item by that number, then the item the reference opens. */
  const byReference = (items: () => unknown = () => json('reference-summary.json')) => vi.fn<typeof fetch>(async (input) => {
    const operation = String(input).split('/').pop();
    return reply(operation === 'GetItemSummary' ? json('unknown.json') : operation === 'GetCustItemSummary' ? items() : json('events.json'));
  });
  const referenceOf = (items: unknown[]) => ({ getCustItemSummaryResponse: { GetCustItemSummaryResult: items } });
  const referenceItem = () => (json('reference-summary.json') as ReturnType<typeof referenceOf>)
    .getCustItemSummaryResponse.GetCustItemSummaryResult[0] as Record<string, unknown>;

  it("finds the item a sender's reference opens, as the website does, and names its own number", async () => {
    const fetcher = byReference();
    const result = normalizeCarrierResult(await instance(fetcher).track({ number: ' pss 0000 0001 ' }));
    expect(fetcher.mock.calls.map(([input, init]) => [String(input).slice(AN_POST_APP_API.length), JSON.parse(String(init?.body))])).toEqual([
      ['/GetItemSummary', { getItemSummary: { trackingItems: [REFERENCE] } }],
      ['/GetCustItemSummary', { getCustItemSummary: { customerNumbers: [REFERENCE] } }],
      ['/GetEvents', { getEvents: { barcodeItem: NUMBER } }],
    ]);
    expect(result).toMatchObject({ canonical_tracking_number: NUMBER, current_stage: 'ready_for_pickup',
      last_status_text: 'Your item is now available for collection' });
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    expect(JSON.stringify(result)).not.toContain(REFERENCE);
    // Asked by its own number, the item names no other.
    expect(normalizeCarrierResult(await instance(service()).track({ number: NUMBER }))).not.toHaveProperty('canonical_tracking_number');
  });

  it("asks an S10 number only as an item, and a reference no item has as not found", async () => {
    const fetcher = byReference();
    fetcher.mockImplementationOnce(async () => reply(json('unknown.json')));
    await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const unknown = byReference(() => referenceOf([]));
    await expect(instance(unknown).track({ number: REFERENCE })).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another reference', () => referenceOf([{ ...referenceItem(), senderNo: 'PSS00000002' }]), 'schema'],
    ['no reference', () => referenceOf([{ ...referenceItem(), senderNo: undefined }]), 'schema'],
    ['an item number that fails its check digit', () => referenceOf([{ ...referenceItem(), anPostNo: 'CP000000006IE' }]), 'schema'],
    ['no item number', () => referenceOf([{ ...referenceItem(), anPostNo: undefined }]), 'schema'],
    ['a wrong envelope', () => ({ getItemSummaryResponse: { GetItemSummaryResult: [] } }), 'schema'],
    ['two items', () => referenceOf([referenceItem(), { ...referenceItem(), anPostNo: OTHER }]), 'indeterminate'],
  ])("refuses a reference's summary with %s before reading a history", async (_, items, kind) => {
    const fetcher = byReference(items);
    await expect(instance(fetcher).track({ number: REFERENCE })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another item', () => summaryOf([{ ...summaryItem(), anPostNo: OTHER }]), 'schema'],
    ['another item beside it', () => summaryOf([summaryItem(), { ...summaryItem(), anPostNo: OTHER }]), 'schema'],
    ['no identity', () => summaryOf([{ ...summaryItem(), anPostNo: undefined }]), 'schema'],
    ['a numeric identity', () => summaryOf([{ ...summaryItem(), anPostNo: 5 }]), 'schema'],
    ['an item that is not an object', () => summaryOf([NUMBER]), 'schema'],
    ['the item twice', () => summaryOf([summaryItem(), summaryItem()]), 'indeterminate'],
  ])('refuses a summary with %s before reading it', async (_, summary, kind) => {
    const fetcher = service(() => reply(summary()));
    await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a wrong envelope', { x: 1 }],
    ['a result that is not a list', { getItemSummaryResponse: { GetItemSummaryResult: {} } }],
    ['an invalid summary clock', summaryOf([{ ...summaryItem(), date: '2026-02-30T10:00:00' }])],
    ['a status that is not text', summaryOf([{ ...summaryItem(), status: 14 }])],
  ])('treats a summary with %s as malformed, never as not found', async (_, summary) => {
    await expect(instance(service(() => reply(summary))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([
    ['a wrong envelope', () => ({ getEvents: [] })],
    ['an impossible date', () => eventsOf([{ ...eventRows()[0], date: '2026-02-30T10:00:00' }])],
    ['an offset clock', () => eventsOf([{ ...eventRows()[0], date: '2026-03-12T11:56:00Z' }])],
    ['a text trace code', () => eventsOf([{ ...eventRows()[0], traceCode: '70' }])],
    ['no activity', () => eventsOf([{ ...eventRows()[0], activity: undefined }])],
    ['a null activity', () => eventsOf([{ ...eventRows()[0], activity: null }])],
    ['an empty activity', () => eventsOf([{ ...eventRows()[0], activity: ' ' }])],
    ['a numeric activity', () => eventsOf([{ ...eventRows()[0], activity: 70 }])],
    ['a delivery attempt whose activity is not text', () => eventsOf([{ ...eventRows()[0], traceCode: 16, activity: 16, reason: 'DELIVERED' }])],
    ['an empty delivery attempt without a reason', () => eventsOf([{ ...eventRows()[0], traceCode: 16, activity: '', reason: ' ' }])],
    ['a location that is not text', () => eventsOf([{ ...eventRows()[0], location: {} }])],
    ['a row that is not an object', () => eventsOf([null])],
  ])('treats a history with %s as malformed', async (_, events) => {
    await expect(instance(service(undefined, () => reply(events()))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('treats an empty history beside a bound summary as inconclusive, so richer sources are asked', async () => {
    // The summary repeats the newest scan, and a wrong request also gets the empty list.
    for (const summary of [summaryOf([summaryItem()]), summaryOf([{ ...summaryItem(), status: '', reason: '' }])]) {
      const fetcher = service(() => reply(summary), () => reply(eventsOf([])));
      await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it("words a delivery attempt as the website does and never shows the attempt's reason", () => {
    const attempt = (reason: string) => {
      const row = { ...eventRows()[0], traceCode: 16, activity: 'SYNTHETIC ACTIVITY', reason };
      // A summary without a status shows the attempt's outcome, and is bound by its clock.
      return parseAnPostEvents(eventsOf([row, ...eventRows().slice(1)]), summaryFor(row, ''));
    };
    const delivered = attempt('DELIVERED TO SYNTHETIC NEIGHBOUR');
    expect(delivered.events?.[0]).toEqual({ description: ATTEMPT_DELIVERED, local_time: '2026-03-12T11:56:00', provider_code: '16',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: ATTEMPT_DELIVERED });
    expect(attempt('DELIVERED - NO SIGNATURE SYNTHETIC').current_stage).toBe('delivered');
    for (const reason of ['NO ACCESS SYNTHETIC', 'UNDELIVERED SYNTHETIC', 'NOT DELIVERED - NO ACCESS', 'COULD NOT BE DELIVERED', 'NON-DELIVERED']) {
      const missed = attempt(reason);
      expect(missed.events?.[0], reason).toMatchObject({ description: ATTEMPT_MADE, stage: 'failed_attempt', stage_source: 'carrier_map' });
      expect(missed, reason).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: ATTEMPT_MADE });
    }
    expect(attempt('').events?.[0]).toMatchObject({ description: 'SYNTHETIC ACTIVITY', stage: 'failed_attempt' });
    expect(JSON.stringify([delivered, attempt('NO ACCESS SYNTHETIC')])).not.toMatch(/NEIGHBOUR|NO ACCESS|SIGNATURE/);

    const summary = (reason: string) => parseAnPostSummary(summaryOf([{ ...summaryItem(), status: '', reason }]), NUMBER);
    expect(summary('DELIVERED SYNTHETIC').status).toBe(ATTEMPT_DELIVERED);
    for (const reason of ['UNDELIVERED SYNTHETIC', 'NOT DELIVERED - NO ACCESS']) expect(summary(reason).status, reason).toBe(ATTEMPT_MADE);
  });

  it.each([
    ['DELIVERED TO SYNTHETIC SAFE PLACE', ATTEMPT_DELIVERED, 'delivered', 'delivered'],
    ['NO ACCESS SYNTHETIC', ATTEMPT_MADE, 'failed_attempt', 'exception'],
  ])('words a delivery attempt with no activity from its reason "%s", as the website does', async (reason, description, stage, status) => {
    // The website takes the reason's outcome first, whether the activity is empty, null or missing.
    for (const activity of ['', null, undefined]) {
      const row: Record<string, unknown> = { ...eventRows()[0], traceCode: 16, activity, reason };
      const summary = summaryOf([{ ...summaryItem(), status: '', reason, date: row.date }]);
      const result = await instance(service(() => reply(summary), () => reply(eventsOf([row, ...eventRows().slice(1)])))).track({ number: NUMBER });
      expect(result.events?.[0], String(activity)).toEqual({ description, local_time: '2026-03-12T11:56:00', provider_code: '16', stage,
        stage_source: 'carrier_map' });
      expect(result, String(activity)).toMatchObject({ status, current_stage: stage, current_stage_source: 'carrier_map',
        last_status_text: description, last_update_local: '2026-03-12T11:56:00' });
      expect(result.events).toHaveLength(8);
      expect(JSON.stringify(result)).not.toMatch(/SAFE PLACE|NO ACCESS/);
    }
  });

  it.each([
    [13, 'Synthetic scan', 'failed_attempt', 'carrier_map'],
    [42, 'Synthetic scan', 'delivered', 'carrier_map'],
    [83, 'Synthetic scan', 'customs', 'carrier_map'],
    [37, 'Synthetic scan', 'accepted', 'carrier_map'],
    [75, 'Synthetic scan', 'returned', 'carrier_map'],
    [75, 'Your item is being returned to the sender', 'exception', 'wording:language'],
    [68, 'Synthetic scan', 'in_transit', 'carrier_map'],
    [68, 'Your item is out for delivery today', 'out_for_delivery', 'wording:language'],
    [68, 'Your item will be delivered tomorrow', 'in_transit', 'carrier_map'],
    [9999, 'Your item could not be delivered', 'failed_attempt', 'wording:language'],
    [9999, 'Synthetic scan', undefined, undefined],
  ])('takes the current stage of a code %i scan "%s" from the app or the wording', (traceCode, activity, stage, source) => {
    const row = { ...eventRows()[0], traceCode, activity };
    const result = parseAnPostEvents(eventsOf([row, ...eventRows().slice(1)]), summaryFor(row));
    expect(result.events?.[0]).toEqual({ description: activity, local_time: '2026-03-12T11:56:00', provider_code: String(traceCode),
      ...(stage ? { stage, stage_source: source } : {}) });
    expect(result).toMatchObject({ last_status_text: activity, last_update_local: '2026-03-12T11:56:00' });
    expect([result.status, result.current_stage, result.current_stage_source])
      .toEqual(stage ? [languageStageStatus(stage as Stage), stage, source] : ['unknown', undefined, undefined]);
  });

  it('takes the current scan the summary names when the service lists another first', () => {
    const [current, previous, ...rest] = eventRows();
    const result = parseAnPostEvents(eventsOf([previous, current, ...rest]), summaryFor(current!));
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Your item is now available for collection', last_update_local: '2026-03-12T11:56:00' });
    expect(result.events?.slice(0, 2).map(event => event.provider_code)).toEqual(['4', '70']);
    // A summary with no status of its own is bound by its clock alone.
    expect(parseAnPostEvents(eventsOf([previous, current, ...rest]), summaryFor(current!, '')).current_stage).toBe('ready_for_pickup');
  });

  it('lets the service order decide between the scan the summary names and the first listed one at the same clock', () => {
    // Relayed partner scans share a minute, and a scan may arrive between the summary and the history.
    const sorting = scan(68, 'Your item is in the sorting office of the local delivery provider', '2026-03-12T11:46:00');
    const prepared = scan(73, 'Your item is being prepared for delivery', '2026-03-12T11:46:00');
    const partner = parseAnPostEvents(eventsOf([prepared, sorting, ...eventRows().slice(1)]), summaryFor(sorting));
    expect(partner).toMatchObject({ current_stage: 'in_transit', last_status_text: prepared.activity, last_update_local: '2026-03-12T11:46:00' });
    expect(partner.events?.slice(0, 2).map(event => event.provider_code)).toEqual(['73', '68']);
    const out = scan(4, 'Your item is out for delivery', '2026-03-12T11:46:00');
    const delivered = scan(14, 'Your item has been delivered', '2026-03-12T11:46:00');
    expect(parseAnPostEvents(eventsOf([delivered, out, ...eventRows().slice(1)]), summaryFor(out))).toMatchObject({ status: 'delivered',
      current_stage: 'delivered', last_status_text: 'Your item has been delivered', last_update_local: '2026-03-12T11:46:00' });
  });

  it('takes the newer scan when one arrived between the summary and the history', () => {
    // The summary names the out-for-delivery scan; the history already holds the collection notice after it.
    const result = parseAnPostEvents(json('events.json'), summaryFor(eventRows()[1]!));
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Your item is now available for collection',
      last_update_local: '2026-03-12T11:56:00' });
    expect(result.events).toHaveLength(8);
  });

  it('takes the summary as current when it is ahead of the history, keeping every scan', () => {
    const ahead = (change: Record<string, unknown>) => parseAnPostEvents(json('events.json'),
      parseAnPostSummary(summaryOf([{ ...summaryItem(), date: '2026-03-13T09:00:00', ...change }]), NUMBER));
    const delivered = ahead({ status: 'Your item has been delivered' });
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your item has been delivered', last_update: null, last_update_local: '2026-03-13T09:00:00' });
    expect(delivered.summary_only).toBeUndefined();
    expect(delivered.events?.map(event => event.provider_code)).toEqual(['70', '4', '4', '67', '49', '48', '15', '35']);
    // A summary without a status of its own shows its attempt's outcome, never the reason.
    const missed = ahead({ status: '', reason: 'UNDELIVERED SYNTHETIC' });
    expect(missed).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: ATTEMPT_MADE,
      last_update_local: '2026-03-13T09:00:00' });
    expect(JSON.stringify(missed)).not.toMatch(/UNDELIVERED/);
    expect(ahead({ status: 'Synthetic status' })).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic status' });
    expect(ahead({ status: 'Synthetic status' }).current_stage).toBeUndefined();
  });

  it("dates An Post's own scans on Irish time and keeps the clocks of the partner's relayed scans", () => {
    // As live: An Post's scans carry seconds, the partner's arrive in whole minutes.
    const sent = scan(5, 'Your item is being sent internationally.', '2026-09-22T18:46:48');
    const accepted = scan(37, 'We have your item and will process it for delivery', '2026-09-22T16:46:48');
    const informed = scan(35, 'We have received information about your incoming item from the sender', '2026-09-09T20:41:19');
    const partner = [scan(14, 'Your item has been delivered', '2026-09-29T18:29:00'),
      scan(4, 'Your item is out for delivery', '2026-09-28T07:35:00'),
      scan(40, 'Your item arrived abroad.', '2026-09-25T08:19:00')];
    const outbound = parseAnPostEvents(eventsOf([...partner, sent, accepted, informed]), summaryFor(partner[0]!));
    expect(outbound.events?.map(event => [event.provider_code, event.time])).toEqual([['14', undefined], ['4', undefined],
      ['40', undefined], ['5', '2026-09-22T18:46:48+01:00'], ['37', '2026-09-22T16:46:48+01:00'], ['35', '2026-09-09T20:41:19+01:00']]);
    expect(outbound).toMatchObject({ last_update: null, last_update_local: '2026-09-29T18:29:00' });
    // While the item is still with An Post, its current scan is the update's instant.
    const leaving = parseAnPostEvents(eventsOf([sent, accepted, informed]), summaryFor(sent));
    expect(leaving).toMatchObject({ last_update: '2026-09-22T18:46:48+01:00', last_update_local: '2026-09-22T18:46:48' });
    // An Post's scans after the partner's stay on the wall clock too: the return of an item abroad.
    const back = scan(53, 'Your item is being returned to the sender', '2026-10-02T10:12:31');
    expect(parseAnPostEvents(eventsOf([back, ...partner, sent]), summaryFor(back)).events?.[0]).not.toHaveProperty('time');
    // A domestic item is An Post's alone; a summary ahead of the history is no scan and keeps its wall clock.
    const delivered = scan(14, 'Your item has been delivered', '2026-09-24T11:01:30');
    expect(parseAnPostEvents(eventsOf([delivered, informed]), summaryFor(delivered))).toMatchObject({
      last_update: '2026-09-24T11:01:30+01:00', last_update_local: '2026-09-24T11:01:30' });
    const ahead = parseAnPostSummary(summaryOf([{ ...summaryItem(), status: delivered.activity, date: delivered.date }]), NUMBER);
    expect(parseAnPostEvents(eventsOf([informed]), ahead)).toMatchObject({ last_update: null, last_update_local: delivered.date });
    // Mail from abroad shows only An Post's scans, from the sending post's pre-advice on.
    const inbound = [delivered, scan(6, 'We have received your item', '2026-09-20T18:15:54'),
      scan(35, informed.activity, '2026-09-18T23:35:51')];
    const arrived = parseAnPostEvents(eventsOf(inbound), parseAnPostSummary(summaryOf([{ ...summaryItem(),
      anPostNo: 'CP000000005GB', status: delivered.activity, date: delivered.date }]), 'CP000000005GB'));
    expect(arrived.events?.map(event => event.time)).toEqual(['2026-09-24T11:01:30+01:00', '2026-09-20T18:15:54+01:00',
      '2026-09-18T23:35:51+01:00']);
    // A wall time the clocks skip names no instant.
    const skipped = scan(4, 'Your item is out for delivery', '2026-03-29T01:30:00');
    const before = parseAnPostEvents(eventsOf([skipped, scan(48, accepted.activity, '2026-03-28T23:30:12')]), summaryFor(skipped));
    expect(before.events?.map(event => event.time)).toEqual([undefined, '2026-03-28T23:30:12+00:00']);
    expect(before).toMatchObject({ last_update: null, last_update_local: skipped.date });
  });

  it.each([
    [5, 'Your item is being sent internationally. We will aim to show tracking\r\nupdates as they become available, or visit the local delivery provider website for updates.'],
    [13, 'Your item was not collected within the specified timeframe. This item will now be returned to sender.'],
    [40, 'Your item arrived abroad. We will aim to show tracking information from the receiving post, but would recommend tracking the item further on their site'],
    [52, 'Your delivery is in SYNTHETIC TOWN, POST OFFICE'],
    [68, 'Your item is in the sorting office of the local delivery provider'],
    [73, 'Your item is being prepared for delivery'],
  ])('stages a summary ahead of the history as the code %i scan whose wording it repeats', (code, status) => {
    const result = parseAnPostEvents(json('events.json'),
      parseAnPostSummary(summaryOf([{ ...summaryItem(), date: '2026-03-13T09:00:00', status }]), NUMBER));
    const own = anPostScanStage(code, status.replace(/\s+/g, ' '));
    expect(own?.source).toBe('carrier_map');
    expect(result).toMatchObject({ status: languageStageStatus(own!.stage), current_stage: own!.stage, current_stage_source: 'carrier_map',
      last_update_local: '2026-03-13T09:00:00' });
  });

  it('stages a post office scan as waiting there, and keeps the office as the pickup point once collected there', () => {
    // As live: delivered to the post office, held there, then collected with a delivery record.
    const office = scan(52, 'Your delivery is in SYNTHETIC TOWN, POST OFFICE', '2026-03-13T08:53:14');
    const history = [office, scan(14, 'Your item has been delivered', '2026-03-13T08:31:28'),
      scan(4, 'Your item is out for delivery', '2026-03-13T08:30:08'), ...eventRows().slice(1)];
    const waiting = parseAnPostEvents(eventsOf(history), summaryFor(office));
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: office.activity, pickup_point: 'SYNTHETIC TOWN, POST OFFICE' });
    expect(waiting.events?.[0]).toEqual({ description: office.activity, local_time: office.date, location: 'SYNTHETIC TOWN, POST OFFICE',
      provider_code: '52', stage: 'ready_for_pickup', stage_source: 'carrier_map' });
    expect(waiting.events?.[1]).not.toHaveProperty('location');
    // A summary ahead of the history names the office too.
    expect(parseAnPostEvents(eventsOf(history.slice(1)), summaryFor(office))).toMatchObject({ current_stage: 'ready_for_pickup',
      last_update_local: office.date, pickup_point: 'SYNTHETIC TOWN, POST OFFICE' });

    const collected = scan(14, 'Your item has been delivered', '2026-03-13T09:07:49');
    expect(parseAnPostEvents(eventsOf([collected, ...history]), summaryFor(collected))).toMatchObject({ current_stage: 'delivered',
      pickup_point: 'SYNTHETIC TOWN, POST OFFICE' });
    expect(parseAnPostEvents(eventsOf(history), summaryFor(collected))).toMatchObject({ current_stage: 'delivered',
      last_update_local: collected.date, pickup_point: 'SYNTHETIC TOWN, POST OFFICE' });
    // Taken back out for delivery, the item is no longer collected there.
    const outAgain = scan(4, 'Your item is out for delivery', '2026-03-13T09:00:00');
    expect(parseAnPostEvents(eventsOf([collected, outAgain, ...history]), summaryFor(collected))).not.toHaveProperty('pickup_point');
  });

  it('gives no pickup point for an office that is no post office, a collection notice or a delivery to the door', () => {
    const sorting = scan(52, 'Your delivery is in SYNTHETIC MAIL CENTRE', '2026-03-13T08:53:14');
    const elsewhere = parseAnPostEvents(eventsOf([sorting, ...eventRows().slice(1)]), summaryFor(sorting));
    expect(elsewhere).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(elsewhere).not.toHaveProperty('pickup_point');
    expect(elsewhere.events?.[0]).not.toHaveProperty('location');
    expect(statusMap.stage('52', normalizeStatusWording(sorting.activity))).toBe('in_transit');
    // The collection notice names no office.
    expect(parseAnPostEvents(json('events.json'), summaryFor(eventRows()[0]!))).not.toHaveProperty('pickup_point');
    const door = scan(14, 'Your item has been delivered', '2026-03-13T09:07:49');
    expect(parseAnPostEvents(eventsOf([door, ...eventRows().slice(1)]), summaryFor(door))).not.toHaveProperty('pickup_point');
  });

  it.each([
    ['a clock before every scan', { date: '2026-03-01T09:00:00' }],
    ['a placeholder clock', { date: '0001-01-01T00:00:00' }],
    ['no clock', { date: null }],
    ['neither status nor reason and a later clock', { status: '', reason: '', date: '2026-03-13T09:00:00' }],
  ])('keeps the first listed scan as current beside a summary with %s', (_, change) => {
    const result = parseAnPostEvents(json('events.json'), parseAnPostSummary(summaryOf([{ ...summaryItem(), ...change }]), NUMBER));
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Your item is now available for collection',
      last_update_local: '2026-03-12T11:56:00' });
    expect(result.events).toHaveLength(8);
  });

  it("takes the scan at the summary's clock when the summary words it differently", () => {
    const row: Record<string, unknown> = { ...eventRows()[0], traceCode: 16, activity: 'SYNTHETIC ACTIVITY', reason: '' };
    const summary = parseAnPostSummary(summaryOf([{ ...summaryItem(), status: 'We tried to deliver your post', date: row.date }]), NUMBER);
    expect(parseAnPostEvents(eventsOf([row, ...eventRows().slice(1)]), summary)).toMatchObject({ status: 'exception',
      current_stage: 'failed_attempt', current_stage_source: 'carrier_map', last_status_text: 'SYNTHETIC ACTIVITY',
      last_update_local: '2026-03-12T11:56:00' });
  });

  it('keeps at most the newest hundred scans', () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({ ...eventRows()[1],
      date: `2026-03-${String(28 - Math.floor(index / 24)).padStart(2, '0')}T${String(23 - (index % 24)).padStart(2, '0')}:00:00` }));
    const result = parseAnPostEvents(eventsOf(rows), summaryFor(rows[0]!));
    expect(result.events).toHaveLength(100);
    expect(result.events?.[0]?.local_time).toBe('2026-03-28T23:00:00');
  });

  it('records each status under the stage its code and wording map to, as the status map answers the app', () => {
    for (const entry of statuses.entries as { code: string; wording?: string; stage: string }[]) {
      expect(anPostScanStage(Number(entry.code), entry.wording ?? 'Synthetic scan')?.stage, entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording ?? 'Synthetic scan')), entry.code).toBe(entry.stage);
      // The summary repeats a scan's wording without its code, and is staged as that scan.
      if (entry.wording) expect(anPostSummaryStage(entry.wording), entry.wording).toEqual(anPostScanStage(Number(entry.code), entry.wording));
    }
  });
});

describe('An Post guest API transport', () => {
  it('sends the included key with each request', async () => {
    const fetcher = service();
    await instance(fetcher).track({ number: NUMBER });
    const keys = fetcher.mock.calls.map(call => new Headers(call[1]?.headers).get('ocp-apim-subscription-key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[a-f\d]{32}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([
    ['a refused key', () => reply(fixture('key-refused.json'), { status: 401, headers: { 'WWW-Authenticate': 'AzureApiManagementKey realm="synthetic"' } })],
    ['the gateway firewall', () => new Response(fixture('firewall.html'), { status: 403, headers: { 'Content-Type': 'text/html' } })],
    ['a web page with HTTP 200', () => new Response(fixture('firewall.html'), { headers: { 'Content-Type': 'text/html' } })],
    ['a web page labelled as JSON', () => reply('<html><title>Validate</title></html>')],
  ])('answers %s as a challenge, never as not found', async (_, response) => {
    await expect(instance(service(response)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(instance(service(undefined, response)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers a spent API Management quota as a rate limit with its window, and any other JSON 403 as a challenge', async () => {
    const spent = (headers: Record<string, string> = {}) => () => reply(fixture('quota-spent.json'), { status: 403, headers });
    for (const fetcher of [service(spent({ 'Retry-After': '30' })), service(undefined, spent({ 'Retry-After': '30' }))]) {
      await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', status: 403, retryAfterMs: 30_000 });
    }
    const unbounded: unknown = await instance(service(spent())).track({ number: NUMBER }).catch((caught: unknown) => caught);
    expect(unbounded).toMatchObject({ kind: 'rate_limited', status: 403 });
    expect((unbounded as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    const refused = () => reply({ statusCode: 403, message: 'Forbidden' }, { status: 403 });
    await expect(instance(service(refused)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    const firewall = () => new Response(fixture('firewall.html'), { status: 403, headers: { 'Content-Type': 'text/html', 'Retry-After': '30' } });
    await expect(instance(service(firewall)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([
    [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'],
    [503, 'maintenance'], [504, 'indeterminate'],
  ])('keeps HTTP %s distinct from an unknown item', async (status, kind) => {
    const response = () => (status === 404 ? reply(fixture('route-missing.json'), { status }) : reply('', { status }));
    await expect(instance(service(response)).track({ number: NUMBER })).rejects.toMatchObject({ kind, status });
    await expect(instance(service(undefined, response)).track({ number: NUMBER })).rejects.toMatchObject({ kind, status });
  });

  it('treats a reply that is not JSON as malformed and bounds an oversized one', async () => {
    await expect(instance(service(() => reply('{"getItemSummaryResponse":'))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(instance(service(() => reply(''))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(instance(service(() => reply(`"${'x'.repeat(300_000)}"`))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each(['network', 'bare network', 'rate limit', 'server error', 'body read', 'bare body read'])('drops the key, number and body from a %s failure', async mode => {
    let key = '';
    // A failure without a reason leaves the transport error without a cause.
    const bare: unknown = undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      key = new Headers(init?.headers).get('ocp-apim-subscription-key') ?? '';
      const privateData = `SYNTHETIC RECIPIENT ${NUMBER} ${key}`;
      if (mode === 'network') throw new Error(privateData);
      if (mode === 'bare network') return Promise.reject(bare);
      if (mode === 'rate limit') return reply(privateData, { status: 429, headers: { 'Retry-After': '30' } });
      if (mode === 'server error') return reply(privateData, { status: 500 });
      if (mode === 'bare body read') return new Response(new ReadableStream({ start(controller) { controller.error(); } }));
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateData)); } }));
    };
    const error: unknown = await instance(fetcher).track({ number: NUMBER }).catch((caught: unknown) => caught);
    expect(error).toMatchObject(mode === 'rate limit' ? { kind: 'rate_limited', status: 429, retryAfterMs: 30_000 }
      : mode === 'server error' ? { kind: 'indeterminate', status: 500 } : { kind: 'transport' });
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('diagnostics');
    expect((error as Error).cause).toBeUndefined();
    expect(key).not.toBe('');
    expect(`${JSON.stringify(error)} ${String(error)}`).not.toMatch(/SYNTHETIC|CP000000005IE/);
    expect(`${JSON.stringify(error)} ${String(error)}`).not.toContain(key);
  });

  it('starts no request for an invalid number or an aborted lookup', async () => {
    const fetcher = service();
    expect(() => instance(fetcher).track({ number: 'CP000000006IE' })).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    await expect(instance(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('caller cancelled')) })).rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts the request in flight with the caller and ends with the budget', async () => {
    const hanging = vi.fn<typeof fetch>((_, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = instance(hanging).track({ number: NUMBER }, { signal: controller.signal });
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    await expect(instance(hanging).track({ number: NUMBER }, { budgetMs: 20 })).rejects.toMatchObject({ kind: 'budget' });
    expect(hanging).toHaveBeenCalledTimes(2);
  });

  it('spends one budget across both requests', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        now += 1_500;
        return String(input).endsWith('/GetItemSummary') ? reply(json('summary.json')) : reply(json('events.json'));
      });
      await expect(instance(fetcher).track({ number: NUMBER }, { budgetMs: 1_000 })).rejects.toMatchObject({ kind: 'budget' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
});

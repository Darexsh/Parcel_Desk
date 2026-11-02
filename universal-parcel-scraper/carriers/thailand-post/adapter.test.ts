// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { classifyWording } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { DEFAULT_USER_AGENT } from '../../core/transport/index.js';
import { adapter, THAILAND_POST_ENDPOINTS, ThailandPostTracker } from './adapter.js';
import { encodeThailandPostRequest, normalizeThailandPostNumber, parseThailandPostReply, thailandPostRequestBody } from './parser.js';
import { thailandPostStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DOMESTIC = 'WB000000045TH';
const INTERNATIONAL = 'EE000000014TH';
const OTHER = 'EE900000005TH';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered.json');
const ABROAD = fixture('international.json');
type Scan = Record<string, unknown>;
const scans = (text: string, number: string) => (JSON.parse(text) as Record<string, Scan[]>)[number]!;
const reply = (number: string, rows: unknown) => JSON.stringify({ [number]: rows });
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const instance = (fetcher: typeof fetch, userAgent?: string) => adapter({ fetcher, userAgent, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });
/** A transport that answers each call with the next reply, then fails the test. */
const replies = (...answers: (Response | Error)[]) => vi.fn<typeof fetch>(async () => {
  const answer = answers.shift();
  if (!answer) throw new Error('No further request expected');
  if (answer instanceof Error) throw answer;
  return answer;
});
const rows = (result: ReturnType<typeof parseThailandPostReply>) => result.events?.map(({ time, local_time, description, location, provider_code, stage, stage_source }) =>
  [time ?? local_time, description, location, provider_code, stage, stage_source]);

describe('Thailand Post request', () => {
  it('takes only a checked S10 number issued by Thailand Post', () => {
    expect(normalizeThailandPostNumber(' wb 000 000 045 th ')).toBe(DOMESTIC);
    for (const number of ['WB000000046TH', 'WB000000045FR', 'W0000000045TH', 'WB00000045TH', '', `${DOMESTIC}0`]) {
      expect(() => normalizeThailandPostNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('encodes the site payload as nine indexed base64 parts', () => {
    const body = thailandPostRequestBody(DOMESTIC);
    const [joined, index] = body.split(',') as [string, string];
    const lengths = Buffer.from(index, 'base64').toString('utf8').split(':')
      .map((part, position) => { expect(part.startsWith(String(position))).toBe(true); return Number(part.slice(1)); });
    expect(lengths).toHaveLength(9);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(joined.length);
    const envelope = JSON.parse(Buffer.from(joined, 'base64').toString('utf8')) as { data: string; d: null };
    expect(envelope.d).toBeNull();
    expect(JSON.parse(envelope.data)).toEqual({ trackingNo: DOMESTIC, flagOS: '1', flagBill: '', checkBot: '1', check: 'AA', tnt: '', turnstileToken: null });
    // A short payload still yields nine positions; the trailing ones may be empty.
    expect(Buffer.from(encodeThailandPostRequest({}).split(',')[1]!, 'base64').toString('utf8').split(':')).toHaveLength(9);
  });
});

describe('Thailand Post history', () => {
  it('reads a domestic history on Bangkok time, keeping the contact scan under the stage before it', () => {
    const result = normalizeCarrierResult(parseThailandPostReply(DELIVERED, DOMESTIC));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Successful delivery [ BAN EXAMPLE Post Office ]', last_update: '2026-03-12T11:58:38+07:00',
      delivered_at: '2026-03-12T11:58:38+07:00', expected_delivery: null });
    expect(result.last_update_local).toBeUndefined();
    expect(result.timezone).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-03-12T11:58:38+07:00', 'Successful delivery [ BAN EXAMPLE Post Office ]', 'BAN EXAMPLE', '35', 'delivered', 'carrier_map'],
      ['2026-03-12T11:58:29+07:00', 'Contact recipient', 'BAN EXAMPLE', '57', 'out_for_delivery', 'none'],
      ['2026-03-12T10:15:10+07:00', 'Out for delivery [ BAN EXAMPLE Post Office ]', 'BAN EXAMPLE', '31', 'out_for_delivery', 'carrier_map'],
      ['2026-03-12T05:47:51+07:00', 'Departure from [ NAKHON EXAMPLE Mail Center ] to [ BAN EXAMPLE Post Office ]', 'NAKHON EXAMPLE', '25', 'in_transit', 'carrier_map'],
      ['2026-03-11T14:40:38+07:00', 'Arrival at Mail center [ NAKHON EXAMPLE Mail Center ]', 'NAKHON EXAMPLE', '24', 'in_transit', 'carrier_map'],
      ['2026-03-11T02:38:56+07:00', 'Departure from [ SAMPLE EMS Mail Center ] to [ NAKHON EXAMPLE Mail Center ]', 'SAMPLE EMS', '25', 'in_transit', 'carrier_map'],
      ['2026-03-10T13:01:34+07:00', 'Departure from [ EXAMPLE BULK Posting Center ] to [ SAMPLE EMS Mail Center ]', 'EXAMPLE BULK', '27', 'in_transit', 'carrier_map'],
      ['2026-03-10T11:24:00+07:00', 'Posting/Collection [ EXAMPLE BULK Posting Center ]', 'EXAMPLE BULK', '3', 'accepted', 'carrier_map'],
    ]);
  });

  it('projects no recipient, officer, signature, proof of delivery or phone field', () => {
    for (const [text, number] of [[DELIVERED, DOMESTIC], [ABROAD, INTERNATIONAL]] as const) {
      const serialized = JSON.stringify(parseThailandPostReply(text, number));
      expect(serialized).not.toMatch(/PRIVATE-SYNTHETIC|SYNTHETIC-USER|example\.invalid|\*{3}|1545|Successful"|call 30/);
    }
    // A contact scan stays its label even when it is the newest scan.
    const contactLast = scans(DELIVERED, DOMESTIC).slice(1);
    const result = parseThailandPostReply(reply(DOMESTIC, contactLast), DOMESTIC);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Contact recipient' });
    // A masked or unknown detail never replaces the label.
    const masked = scans(DELIVERED, DOMESTIC).map((scan, index) => index === 2
      ? { ...scan, statusDetail: { 1: 'Out for delivery [ *******000 ]' } } : index === 3 ? { ...scan, statusID: 77, statusGroup: 2 } : scan);
    expect(parseThailandPostReply(reply(DOMESTIC, masked), DOMESTIC).events?.slice(2, 4).map((event) => event.description))
      .toEqual(['Item out for physical delivery', 'In transit']);
  });

  it('orders comparable instants newest first and drops repeated scans', () => {
    const shuffled = [...scans(DELIVERED, DOMESTIC)].reverse();
    shuffled.push(shuffled[0]!);
    const result = parseThailandPostReply(reply(DOMESTIC, shuffled), DOMESTIC);
    expect(rows(result)).toEqual(rows(parseThailandPostReply(DELIVERED, DOMESTIC)));
  });

  it('keeps scans of one instant in the site’s order, reversed when it lists them oldest first', () => {
    const tied = scans(DELIVERED, DOMESTIC).slice(2).map((scan, index, all) => index === 0 ? { ...scan, createDate: all[1]!.createDate } : scan);
    for (const listed of [tied, [...tied].reverse()]) {
      expect(parseThailandPostReply(reply(DOMESTIC, listed), DOMESTIC).events?.map((event) => event.provider_code))
        .toEqual(['31', '25', '24', '25', '27', '3']);
    }
  });

  it("keeps a foreign post's EDI wall clocks without an offset, in the server's order", () => {
    const result = normalizeCarrierResult(parseThailandPostReply(ABROAD, INTERNATIONAL));
    // The delivery abroad has only the destination post's wall clock: no instant, no delivery time.
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-04-17T13:31:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-04-17T13:31:00', 'Successful delivery [ (France) International ]', 'International (France)', '35', 'delivered', 'carrier_map'],
      ['2026-04-17T08:05:00', 'Out for delivery [ (France) International ]', 'International (France)', '31', 'out_for_delivery', 'carrier_map'],
      ['2026-04-16T11:30:00', 'Unsuccessful delivery (Item held,addressee notified due to Payment of charges) [ (France) International ]', 'International (France)', '34', 'failed_attempt', 'carrier_map'],
      ['2026-04-14T07:12:00', 'Arrival at Inward Office of Exchange [ (France) International ]', 'International (France)', '18', 'in_transit', 'carrier_map'],
      ['2026-04-12T22:41:50+07:00', 'Departure from Outward Office of Exchange [ SAMPLE OUTWARD Mail Center ] to [ (France) International ]', 'SAMPLE OUTWARD', '15', 'in_transit', 'carrier_map'],
      ['2026-04-11T08:14:05+07:00', 'Arrival at Outward Office of Exchange [ SAMPLE OUTWARD Mail Center ]', 'SAMPLE OUTWARD', '9', 'in_transit', 'carrier_map'],
      ['2026-04-10T16:20:30+07:00', 'Departure from [ BAN EXAMPLE Post Office ] to [ SAMPLE OUTWARD Mail Center ]', 'BAN EXAMPLE', '27', 'in_transit', 'carrier_map'],
      ['2026-04-10T10:05:12+07:00', 'Posting/Collection [ BAN EXAMPLE Post Office ]', 'BAN EXAMPLE', '3', 'accepted', 'carrier_map'],
    ]);
    expect(result.events?.slice(0, 4).every((event) => event.time === undefined)).toBe(true);
    // Mixed clocks cannot be compared, so even an odd server order stays as sent.
    const swapped = scans(ABROAD, INTERNATIONAL);
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(parseThailandPostReply(reply(INTERNATIONAL, swapped), INTERNATIONAL).events?.map((event) => event.provider_code))
      .toEqual(['35', '34', '31', '18', '15', '9', '27', '3']);
    // Until the destination post reports, every clock is a Thai instant.
    const home = parseThailandPostReply(reply(INTERNATIONAL, scans(ABROAD, INTERNATIONAL).slice(4)), INTERNATIONAL);
    expect(home).toMatchObject({ status: 'in_transit', last_update: '2026-04-12T22:41:50+07:00' });
    expect(home.last_update_local).toBeUndefined();
    // Any one of the site's foreign markers is enough.
    for (const marker of [{ outletType: 25 }, { portalCode: '99999' }, { itemTypeFlag: 'EDI' }]) {
      const marked = scans(DELIVERED, DOMESTIC).map((scan, index) => index === 7 ? { ...scan, ...marker } : scan);
      const event = parseThailandPostReply(reply(DOMESTIC, marked), DOMESTIC).events?.[7];
      expect(event, JSON.stringify(marker)).toMatchObject({ local_time: '2026-03-10T11:24:00' });
      expect(event?.time).toBeUndefined();
    }
  });

  it("reads a final delivery to the sender as a return, without a delivery time", () => {
    const returned = scans(DELIVERED, DOMESTIC).map((scan, index) => index === 0 ? { ...scan, dStatusCode: 'L' } : scan);
    const result = parseThailandPostReply(reply(DOMESTIC, returned), DOMESTIC);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_code: '35', stage: 'returned', stage_source: 'carrier_map' });
  });

  it('dates the delivery by its final delivery scan, not by activity after it', () => {
    const delivery = '2026-03-12T11:58:38+07:00';
    const history = scans(DELIVERED, DOMESTIC);
    const final = history[0]!;
    const later = (minutes: number) => (final.createDate as number) + minutes * 60_000;
    // A call logged after the delivery, and the COD payment to the seller.
    const callAfter = history.map((scan, index) => index === 1 ? { ...scan, createDate: later(10) } : scan);
    const remittance = { ...final, statusID: 36, statusGroup: 5, dStatusCode: null, createDate: later(2 * 24 * 60),
      statusName: { 1: 'Successfully transfer money to seller' }, statusDetail: { 1: 'Successfully transfer money to seller' } };
    const unknown = { ...remittance, statusID: 91, createDate: later(24 * 60) };
    for (const [label, rows, newest] of [
      ['call', callAfter, ['57', 'Contact recipient']],
      ['remittance', [remittance, ...history], ['36', 'Successfully transfer money to seller']],
    ] as const) {
      const result = parseThailandPostReply(reply(DOMESTIC, rows), DOMESTIC);
      expect(result, label).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
        delivered_at: delivery, last_status_text: newest[1] });
      expect(result.events?.[0], label).toMatchObject({ provider_code: newest[0] });
      expect(result.events?.find((event) => event.provider_code === '35')?.time, label).toBe(delivery);
    }
    // The call and the payment keep the delivered stage, unmapped.
    const [paid] = parseThailandPostReply(reply(DOMESTIC, [remittance, ...history]), DOMESTIC).events!;
    expect(paid).toMatchObject({ stage: 'delivered', stage_source: 'none' });
    // The payment's office is the seller's account, not the parcel's place.
    expect(paid?.location).toBeUndefined();
    expect(parseThailandPostReply(reply(DOMESTIC, callAfter), DOMESTIC).events?.[0]).toMatchObject({ stage: 'delivered', stage_source: 'none' });
    // An unknown scan in group 5 is no delivery: it stays unstaged and dates nothing.
    const unexplained = parseThailandPostReply(reply(DOMESTIC, [unknown, ...history]), DOMESTIC);
    expect(unexplained).toMatchObject({ status: 'unknown', last_status_text: 'Successfully transfer money to seller' });
    expect(unexplained.delivered_at).toBeUndefined();
    expect(unexplained.events?.[0]?.stage).toBeUndefined();
  });

  it('reads a utility row by its group and a return to the origin office as an exception', () => {
    const history = scans(DELIVERED, DOMESTIC).slice(2);
    const at = (history[0]!.createDate as number) + 60_000;
    const estimate = { ...history[0]!, statusID: 34, statusGroup: 2, dStatusCode: 'A1', createDate: at,
      statusName: { 1: 'Arrived at destination post office. Estimated delivery in a few days.' } };
    expect(parseThailandPostReply(reply(DOMESTIC, [estimate, ...history]), DOMESTIC))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language' });
    const back = { ...estimate, statusID: 28, dStatusCode: 'K', statusName: { 1: 'Return to the origin post office' } };
    expect(parseThailandPostReply(reply(DOMESTIC, [back, ...history]), DOMESTIC))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
  });

  it('maps every recorded scan code, then the shared wording, then the status group', () => {
    // The call and the COD payment are activity, staged by the scans before them.
    for (const entry of statuses.entries.filter((status) => !['57', '36'].includes(status.code))) {
      const [code, result] = entry.code.split('/') as [string, string?];
      // A utility row was seen in group 4, an unsuccessful delivery.
      expect(thailandPostStage(code, entry.wording, code === '34' ? 4 : null, result), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // A final delivery without a known delivery result is left to its wording.
    expect(thailandPostStage('35', 'Final delivery', 5)).toEqual(classifyWording('Final delivery'));
    expect(thailandPostStage('35', 'Final delivery', 5, 'toString')).toEqual(classifyWording('Final delivery'));
    // Outside group 4, a utility row's delivery result is news, not a failure.
    const estimate = 'Arrived at destination post office. Estimated delivery in a few days.';
    expect(thailandPostStage('34', estimate, 2)).toEqual(classifyWording(estimate));
    expect(thailandPostStage('34', 'Preparing', 3)).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(thailandPostStage('34', 'COD Information Updating', 2)).toBeNull();
    expect(thailandPostStage('34', 'COD Information Updating', 4)).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(thailandPostStage('28', 'Delivery Status', 2)).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(thailandPostStage('88', 'Return to sender')).toEqual(classifyWording('Return to sender'));
    expect(thailandPostStage('88', 'Return to sender', 5)?.source).toMatch(/^wording:/);
    expect(thailandPostStage('88', 'Unusual scan', 3)).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(thailandPostStage('88', 'Unusual scan', 4)).toEqual({ stage: 'exception', source: 'carrier_map' });
    // Group 5 also holds the COD payment to the seller, so it settles nothing.
    expect(thailandPostStage('88', 'Successfully transfer money to seller', 5)).toBeNull();
    expect(thailandPostStage('88', 'Unusual scan', 2)).toBeNull();
    const unknown = scans(DELIVERED, DOMESTIC).map((scan, index) => index === 0
      ? { ...scan, statusID: 88, statusGroup: 2, statusName: { 1: 'Unusual scan' } } : scan);
    const result = parseThailandPostReply(reply(DOMESTIC, unknown), DOMESTIC);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Unusual scan' });
    expect(result.current_stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('binds the reply and every scan to the whole number', () => {
    const history = scans(DELIVERED, DOMESTIC);
    for (const text of [
      reply(OTHER, history),
      JSON.stringify({ [DOMESTIC]: history, [OTHER]: null }),
      reply(DOMESTIC.toLowerCase(), history),
      reply(DOMESTIC, history.map((scan, index) => index === 4 ? { ...scan, mailingNo: OTHER } : scan)),
      reply(DOMESTIC, history.map((scan, index) => index === 4 ? { ...scan, mailingNo: undefined } : scan)),
      reply(DOMESTIC, history.map((scan, index) => index === 4 ? { ...scan, prefix: 'EE' } : scan)),
      reply(DOMESTIC, history.map((scan, index) => index === 4 ? { ...scan, suffix: 'JP' } : scan)),
    ]) expect(() => parseThailandPostReply(text, DOMESTIC)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it("reads the site's null as not found and its rejections as errors", () => {
    expect(() => parseThailandPostReply(reply(OTHER, null), OTHER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const [text, kind] of [
      ['<!DOCTYPE html><html><title>Just a moment...</title></html>', 'challenge'],
      ['\uFEFF  <html><body>Maintenance</body></html>', 'challenge'],
      [JSON.stringify({ '': 'Please complete the captcha verification' }), 'challenge'],
      [JSON.stringify({ '': 'Data format incorrect,Please register API' }), 'challenge'],
      [JSON.stringify({ message: 'Please complete the captcha verification' }), 'challenge'],
      [JSON.stringify({ status: false, message: 'Turnstile verification required' }), 'challenge'],
      [JSON.stringify({ returnData: { '': 'Data format incorrect,Please register API' }, tokenMode: 'K' }), 'challenge'],
      [JSON.stringify({ errors: ['Please complete the captcha'] }), 'challenge'],
      [reply(OTHER, 'turnstile verification required'), 'challenge'],
      [reply(OTHER, { message: 'Please complete the captcha verification' }), 'challenge'],
      ['Access denied', 'challenge'],
      [JSON.stringify({ error: 'Too Many Requests' }), 'rate_limited'],
      ['Too Many Requests', 'rate_limited'],
      [JSON.stringify({ message: 'unavailable' }), 'schema'],
      [JSON.stringify({ status: false, data: null }), 'schema'],
      [JSON.stringify({ '': null }), 'schema'],
      ['{}', 'schema'],
      ['[]', 'schema'],
      ['null', 'schema'],
      ['not json', 'schema'],
      [reply(OTHER, 'unavailable'), 'schema'],
      [reply(OTHER, {}), 'schema'],
      [reply(OTHER, []), 'schema'],
      [reply(OTHER, [null]), 'schema'],
      [reply(OTHER, Array.from({ length: 501 }, () => scans(DELIVERED, DOMESTIC)[0])), 'schema'],
    ] as const) expect(() => parseThailandPostReply(text, OTHER), text.slice(0, 60)).toThrowError(expect.objectContaining({ kind }));
  });

  it('rejects scans without a clock, code or label', () => {
    const history = scans(DELIVERED, DOMESTIC);
    for (const change of [
      { createDate: undefined }, { createDate: '2026-03-12 11:58:38' }, { createDate: 1773291518.5 }, { createDate: 1_773_291_518 },
      { statusID: null }, { statusID: 'A1' }, { statusID: 12345 }, { statusName: null }, { statusName: { 1: ' ' } },
    ]) {
      const text = reply(DOMESTIC, history.map((scan, index) => index === 1 ? { ...scan, ...change } : scan));
      expect(() => parseThailandPostReply(text, DOMESTIC), JSON.stringify(change)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Thailand Post lookup', () => {
  it("asks the site's tracking service with the host's User-Agent, signal and budget", async () => {
    const steps: unknown[] = [];
    const lookups: unknown[] = [];
    const fetcher = replies(json(DELIVERED));
    const tracker = new ThailandPostTracker({ fetcher, userAgent: 'Synthetic host/1.0',
      recorder: { step: (step) => steps.push(step), lookup: (lookup) => lookups.push(lookup) } });
    await expect(tracker.fetch('wb000000045th', { signal: new AbortController().signal, budgetMs: 5_000 }))
      .resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(THAILAND_POST_ENDPOINTS[0]);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
      body: thailandPostRequestBody(DOMESTIC), headers: { 'User-Agent': 'Synthetic host/1.0', 'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json' } });
    expect(steps).toHaveLength(1);
    expect(lookups).toHaveLength(1);
    const anonymous = replies(json(DELIVERED));
    await instance(anonymous).track({ number: DOMESTIC });
    expect(anonymous.mock.calls[0]![1]).toMatchObject({ headers: { 'User-Agent': DEFAULT_USER_AGENT } });
  });

  it('answers not found for an unknown number', async () => {
    const fetcher = replies(json(reply(OTHER, null)));
    await expect(instance(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects an invalid number before any request', async () => {
    const fetcher = replies();
    for (const number of ['WB000000046TH', 'WB000000045JP', '1234']) {
      await expect(instance(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'transport'], [410, 'transport'], [400, 'transport'], [401, 'challenge'], [403, 'challenge'],
  ] as const)('ends at HTTP %i as %s without the other host', async (status, kind) => {
    const fetcher = replies(new Response('{"message":"unavailable"}', { status }));
    await expect(instance(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reads a block page on an error status, or HTTP 200, as a challenge', async () => {
    const page = '<!DOCTYPE html><html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b"></script></html>';
    for (const status of [200, 500, 503]) {
      const fetcher = replies(new Response(page, { status, headers: { 'Content-Type': 'text/html' } }));
      await expect(instance(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind: 'challenge' });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('keeps a rate limit whose page denies access', async () => {
    const page = '<!DOCTYPE html><html><title>Access denied | example used Cloudflare to restrict access</title>'
      + '<body>Error 1015: You are being rate limited.</body></html>';
    const paused = replies(new Response(page, { status: 429, headers: { 'Content-Type': 'text/html', 'Retry-After': '60' } }));
    await expect(instance(paused).track({ number: DOMESTIC })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    expect(paused).toHaveBeenCalledOnce();
    const json429 = replies(json('{"message":"access denied: too many requests"}', { status: 429 }), json(DELIVERED));
    await expect(instance(json429).track({ number: DOMESTIC })).resolves.toMatchObject({ status: 'delivered' });
    expect(json429).toHaveBeenCalledTimes(2);
    // Without an interactive check, a denial on another status is that status.
    const denied = replies(new Response('<html>Access denied</html>', { status: 500 }), new Response('', { status: 502 }));
    await expect(instance(denied).track({ number: DOMESTIC })).rejects.toMatchObject({ kind: 'indeterminate', status: 502 });
  });

  it.each([
    [429, 'rate_limited'], [503, 'maintenance'], [500, 'indeterminate'],
  ] as const)('keeps a pause requested with HTTP %i as %s without asking the other host', async (status, kind) => {
    const fetcher = replies(new Response('', { status, headers: { 'Retry-After': '30' } }));
    await expect(instance(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind, retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['a network failure', new TypeError('fetch failed')],
    ['HTTP 500', new Response('', { status: 500 })],
    ['HTTP 502', new Response('<html>Bad gateway</html>', { status: 502 })],
    ['HTTP 405', new Response('', { status: 405 })],
    ['HTTP 408', new Response('', { status: 408 })],
    ['HTTP 429 without a pause', new Response('', { status: 429 })],
  ])('tries the second host once after %s', async (_, first) => {
    const fetcher = replies(first, json(DELIVERED));
    await expect(instance(fetcher).track({ number: DOMESTIC })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([...THAILAND_POST_ENDPOINTS]);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ body: thailandPostRequestBody(DOMESTIC), signal: expect.any(AbortSignal) });
  });

  it("records the other host as a recovery step, keeping each host's failure", async () => {
    const steps: { step: string; outcome: string; fallbackFrom: string | null; fallbackReason: string | null }[] = [];
    const recorder = { step: (step: (typeof steps)[number]) => steps.push(step), lookup: () => {} };
    const recovered = new ThailandPostTracker({ fetcher: replies(new Response('', { status: 502 }), json(DELIVERED)), recorder });
    await expect(recovered.fetch(DOMESTIC)).resolves.toMatchObject({ status: 'delivered' });
    expect(steps.map(({ step, outcome, fallbackFrom, fallbackReason }) => [step, outcome, fallbackFrom, fallbackReason])).toEqual([
      ['direct', 'indeterminate', null, null], ['mirror', 'ok', 'direct', 'indeterminate'],
    ]);
    steps.length = 0;
    const failed = new ThailandPostTracker({ fetcher: replies(new Response('', { status: 429 }), new TypeError('fetch failed')), recorder });
    await expect(failed.fetch(DOMESTIC)).rejects.toMatchObject({ kind: 'transport' });
    expect(steps.map(({ step, outcome, fallbackFrom, fallbackReason }) => [step, outcome, fallbackFrom, fallbackReason])).toEqual([
      ['direct', 'rate_limited', null, null], ['mirror', 'transport', 'direct', 'rate_limited'],
    ]);
  });

  it.each([
    [503, 'maintenance'], [500, 'indeterminate'], [429, 'rate_limited'],
  ] as const)('reports the second host failing with HTTP %i as %s', async (status, kind) => {
    const fetcher = replies(new Response('', { status: 500 }), new Response('', { status }));
    await expect(instance(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind, status });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("takes the second host's not-found or rejection as the answer", async () => {
    const fetcher = replies(new Response('', { status: 502 }), json(reply(DOMESTIC, null)));
    await expect(instance(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind: 'not_found' });
    const schema = replies(new Response('', { status: 502 }), json('{}'));
    await expect(instance(schema).track({ number: DOMESTIC })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('does not try the second host without a second of budget left', async () => {
    const fetcher = replies(new Response('', { status: 500 }), json(DELIVERED));
    await expect(instance(fetcher).track({ number: DOMESTIC }, { budgetMs: 900 })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('starts no request after cancellation and none after an abort in flight', async () => {
    const idle = replies();
    const reason = new Error('cancelled');
    await expect(instance(idle).track({ number: DOMESTIC }, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(idle).not.toHaveBeenCalled();

    const controller = new AbortController();
    const hanging = vi.fn<typeof fetch>((_, init) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = instance(hanging).track({ number: DOMESTIC }, { signal: controller.signal });
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledOnce());
    controller.abort(reason);
    await expect(pending).rejects.toBeDefined();
    expect(hanging).toHaveBeenCalledOnce();
  });

  it('ends a lookup whose budget runs out, without the second host', async () => {
    const hanging = vi.fn<typeof fetch>((_, init) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    await expect(instance(hanging).track({ number: DOMESTIC }, { budgetMs: 50 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:budget|transport)$/) });
    expect(hanging).toHaveBeenCalledOnce();
  });

  it('bounds the reply size', async () => {
    const fetcher = replies(json(`${' '.repeat(1_000_001)}{}`));
    await expect(instance(fetcher).track({ number: DOMESTIC })).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

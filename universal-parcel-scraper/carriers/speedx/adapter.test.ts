// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { DEFAULT_USER_AGENT } from '../../core/transport/index.js';
import { SpeedxTracker, adapter } from './adapter.js';
import { normalizeSpeedxNumber, parseSpeedx } from './parser.js';
import { speedxStatus } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'SPXAAA000000000000000001';
const OTHER = 'SPXAAA000000000000000002';
const RSC = 'text/x-component';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered.rsc');
const ABSENT = fixture('not-found.rsc');
const CHALLENGE = fixture('challenge.html');
const ABSENT_ROW: unknown = JSON.parse(ABSENT.split('\n').find((line) => line.startsWith('e:'))!.slice(2));

type Scan = Record<string, unknown>;
type Data = Record<string, unknown> & { events: unknown };

/** The delivered reply with the shipment view's data object changed in place. */
function withData(change: (data: Data, events: Scan[]) => void, body = DELIVERED): string {
  return body.split('\n').map((line) => {
    if (!line.startsWith('e:')) return line;
    const row: unknown = JSON.parse(line.slice(2));
    const stack = [row];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...(node as unknown[]));
      else if (node && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        const data = record.data as Data | undefined;
        if (data && typeof data === 'object' && 'events' in data) change(data, data.events as Scan[]);
        else stack.push(...Object.values(record));
      }
    }
    return `e:${JSON.stringify(row)}`;
  }).join('\n');
}

/** A reply with one more row, as the page would stream another component. */
const withRow = (body: string, row: unknown) => `${body}f:${JSON.stringify(row)}\n`;
const shipmentElement = (data: unknown) => ['$', '$Ld', null, { data }];
const dataOf = (body: string) => {
  let found: Data | undefined;
  withData((data) => { found = data; }, body);
  return found!;
};
const parse = (body: string, number = NUMBER, type: string | null = RSC) => parseSpeedx(body, type, number);
const rsc = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': RSC, ...init.headers } });
const environment = (fetcher: typeof fetch, userAgent?: string) =>
  ({ fetcher, userAgent, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

describe('SpeedX tracking page', () => {
  it('takes SPX, a three-letter hub and 12 or 18 digits', () => {
    expect(normalizeSpeedxNumber(' spxaaa 000000 000000 000001 ')).toBe(NUMBER);
    expect(normalizeSpeedxNumber('SPXAAA-0000-0000-0001')).toBe('SPXAAA000000000001');
    for (const number of ['SPXAAA00000000001', 'SPXAAA0000000000001', `${NUMBER}1`, 'SPXAA0000000000000000001',
      'SPXPH000000000001', 'SPX000000000000000000001', 'SPXAAA000000000001/X', `${NUMBER}?x=1`, `SPXAAA${'0'.repeat(60)}`]) {
      expect(() => normalizeSpeedxNumber(number)).toThrow(InvalidInputError);
    }
  });

  it('reads the shipment view as instants in each scan\'s zone, newest first, without recipient details', () => {
    const result = normalizeCarrierResult(parse(DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-19T13:14:05-07:00', delivered_at: '2026-03-19T13:14:05-07:00',
      expected_delivery: null, destination_country: 'US' });
    expect(result.events?.map(({ time, description, location, provider_code, stage }) => [time, description, location, provider_code, stage])).toEqual([
      ['2026-03-19T13:14:05-07:00', 'Delivered', 'Example City, EX', '57201', 'delivered'],
      ['2026-03-19T08:02:40-07:00', 'Out for Delivery', 'Example City, EX', '57104', 'out_for_delivery'],
      ['2026-03-18T19:45:11-07:00', 'Processing at Designated Facility', 'Sample Hub, EX', '57102', 'in_transit'],
      ['2026-03-18T18:10:30-07:00', 'Arrival at Destination Facility', 'Sample Hub, EX', '57101', 'in_transit'],
      ['2026-03-17T17:20:08-05:00', 'Processing at Transit Facility', 'Transit Town, EX', '57113', 'in_transit'],
      ['2026-03-16T09:05:15-04:00', 'Processing at Origin Facility', 'Origin Town, EX', '52002', 'in_transit'],
      ['2026-03-16T00:41:45-04:00', 'Shipping Label Created', 'Origin Town, EX', '50001', 'registered'],
    ]);
    expect(result.events?.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    // Recipient, merchant, references, coordinates, masked postcodes and the delivery spot stay out.
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|12\.345678|98\.765432|\*\*\*\*\*|Position|America\//);
    for (const entry of statuses.entries) expect(speedxStatus(entry.code)?.stage).toBe(entry.stage);
  });

  it('maps unseen codes by category and leaves the rest to the shared wording rules', () => {
    expect(speedxStatus('59999', 'LAST_MILE_RETURNS')).toEqual({ status: 'exception', stage: 'returned' });
    expect(speedxStatus('59999', 'LAST_MILE_ATTEMPTED')).toEqual({ status: 'exception', stage: 'failed_attempt' });
    expect(speedxStatus('50002', 'PICKUP')).toBeUndefined();
    const result = parse(withData((_data, events) => {
      Object.assign(events[0]!, { eventCode: '59999', category: 'CLEARANCE', eventDescription: 'Held for review', eventSupplementalInfo: null });
    }));
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Held for review', last_update: '2026-03-19T13:14:05-07:00' });
    expect(result.current_stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toEqual({ time: '2026-03-19T13:14:05-07:00', description: 'Held for review', location: 'Example City, EX', provider_code: '59999' });
  });

  it('prints the wording and its note as the page does, except where a delivery was left', () => {
    const attempted = parse(withData((_data, events) => {
      Object.assign(events[1]!, { eventCode: '57614', category: 'LAST_MILE_ATTEMPTED', description: 'Ignored',
        eventDescription: 'Attempted Delivery: No access', eventSupplementalInfo: 'Back to the facility' });
    }));
    expect(attempted.events?.[1]).toMatchObject({ description: 'Attempted Delivery: No access. Back to the facility', stage: 'failed_attempt' });
    const bare = parse(withData((_data, events) => {
      Object.assign(events[0]!, { eventDescription: null });
      Object.assign(events[1]!, { eventDescription: '$undefined', description: 'Out for Delivery today' });
    }));
    expect(bare.events?.slice(0, 2).map((event) => event.description)).toEqual(['Delivered', 'Out for Delivery today']);
    expect(JSON.stringify(bare)).not.toMatch(/PRIVATE|Position/);
  });

  it('keeps the UTC instant when the scan\'s zone is missing or unknown, and never reads the local clock', () => {
    const result = parse(withData((_data, events) => {
      Object.assign(events[0]!, { timeZone: 'Example/Nowhere' });
      Object.assign(events[1]!, { timeZone: null, localTs: '2026-03-19T23:59:59-07:00' });
      Object.assign(events[2]!, { localTs: '2001-01-01T00:00:00+14:00' });
    }));
    expect(result.events?.slice(0, 3).map((event) => event.time)).toEqual(['2026-03-19T20:14:05Z', '2026-03-19T15:02:40Z', '2026-03-18T19:45:11-07:00']);
    expect(result).toMatchObject({ last_update: '2026-03-19T20:14:05Z', delivered_at: '2026-03-19T20:14:05Z' });
  });

  it('orders scans by instant, keeps equal ones in the carrier\'s order and drops repeated event ids', () => {
    const result = parse(withData((data, events) => {
      const [delivered, out, ...rest] = events;
      const returned = { ...delivered!, eventId: 'b0000000000000000000000000000001', eventCode: '59999', category: 'LAST_MILE_RETURNS',
        description: '$undefined', eventDescription: 'Returned to sender', eventSupplementalInfo: 'At the depot', location: null };
      const twin = { ...rest[0]!, eventId: 'b0000000000000000000000000000002', eventDescription: 'Second scan' };
      data.events = [out, { ...out!, description: 'Repeated' }, ...rest.reverse(), returned, twin];
    }));
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to sender. At the depot' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.map(({ time, description, location }) => [time, description, location])).toEqual([
      ['2026-03-19T13:14:05-07:00', 'Returned to sender. At the depot', 'Example City, EX'],
      ['2026-03-19T08:02:40-07:00', 'Out for Delivery', 'Example City, EX'],
      ['2026-03-18T19:45:11-07:00', 'Second scan', 'Sample Hub, EX'],
      ['2026-03-18T19:45:11-07:00', 'Processing at Designated Facility', 'Sample Hub, EX'],
      ['2026-03-18T18:10:30-07:00', 'Arrival at Destination Facility', 'Sample Hub, EX'],
      ['2026-03-17T17:20:08-05:00', 'Processing at Transit Facility', 'Transit Town, EX'],
      ['2026-03-16T09:05:15-04:00', 'Processing at Origin Facility', 'Origin Town, EX'],
      ['2026-03-16T00:41:45-04:00', 'Shipping Label Created', 'Origin Town, EX'],
    ]);
    const placeless = parse(withData((_data, events) => {
      Object.assign(events[0]!, { location: null, city: null, state: null });
    }));
    expect(placeless.events?.[0]).not.toHaveProperty('location');
  });

  it('reads only the sentence naming the number as an unknown number, never the 404 template', () => {
    expect(() => parse(ABSENT)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    // Every page carries Next's generic not-found template; without the view it proves nothing.
    expect(DELIVERED).toContain('404: This page could not be found.');
    const templateOnly = DELIVERED.split('\n').filter((line) => !line.startsWith('e:')).join('\n');
    expect(() => parse(templateOnly)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const page of [
      ABSENT.replace('is available at this time', 'is unavailable'),
      ABSENT.replace(`"children":"${NUMBER}"`, '"children":"$undefined"'),
    ]) expect(() => parse(page)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the shipment and the absence sentence to the requested number', () => {
    expect(() => parse(DELIVERED, OTHER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(ABSENT, OTHER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const page of [
      withData((data) => { data.trackingNumber = OTHER; }),
      withData((data) => { data.trackingNumber = NUMBER.toLowerCase(); }),
      withData((data) => { delete data.trackingNumber; }),
      // Two different shipments, or a shipment next to an absence, are not one answer.
      withRow(DELIVERED, shipmentElement(dataOf(withData((data) => { data.trackingNumber = OTHER; })))),
      withRow(DELIVERED, shipmentElement({ ...dataOf(DELIVERED), events: [] })),
      withRow(DELIVERED, ABSENT_ROW),
    ]) expect(() => parse(page)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // The same object streamed twice is still one shipment.
    expect(parse(withRow(DELIVERED, shipmentElement(dataOf(DELIVERED)))).events).toHaveLength(7);
  });

  it('keeps a row whole when its strings hold the line separators Flight leaves raw', () => {
    const page = withData((data, events) => {
      Object.assign(data, { recipientAddress: 'Apt 4\u{2028}Main St', customerName: 'Shop\u{2029}Name' });
      events[1]!.eventSupplementalInfo = 'On the van\u{2028}today';
    });
    expect(page).toMatch(/\u{2028}Main St.*\u{2029}Name/u);
    const result = parse(page);
    expect(result.events).toHaveLength(7);
    expect(result.events?.[1]?.description).toBe('Out for Delivery. On the van today');
  });

  it('reads an empty reply or a server render failure as proving nothing', () => {
    const pageRow = /^e:.*$/m;
    for (const [body, type] of [['', RSC], [' \n', RSC], ['', null], ['', 'text/html'],
      [DELIVERED.replace(pageRow, 'e:E{"digest":"1234567890"}'), RSC], [DELIVERED.replace(pageRow, 'e:E{}'), RSC]] as const) {
      expect(() => parse(body, NUMBER, type)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // Next's notFound() and redirect() travel as error rows too: a changed page, not an outage.
    for (const digest of ['NEXT_NOT_FOUND', 'NEXT_HTTP_ERROR_FALLBACK;404', 'NEXT_REDIRECT;replace;/;307;']) {
      const page = DELIVERED.replace(pageRow, `e:E${JSON.stringify({ digest })}`);
      expect(() => parse(page)).toThrowError(expect.objectContaining({ kind: 'schema' }));
      expect(() => parse(`${page}f:E{"digest":"1"}\n`)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // A failed side component does not hide the shipment or the absence sentence.
    expect(parse(`${DELIVERED}f:E{"digest":"1"}\n`).events).toHaveLength(7);
    expect(() => parse(`${ABSENT}f:E{"digest":"1"}\n`)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
  });

  it('rejects web pages and changed replies', () => {
    for (const [body, type] of [[CHALLENGE, 'text/html; charset=utf-8'], [DELIVERED, 'text/html'], [CHALLENGE, RSC], [CHALLENGE, null]] as const) {
      expect(() => parse(body, NUMBER, type)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    for (const [body, type] of [[DELIVERED, 'application/json'], [DELIVERED, null], ['0:"x"\n', RSC]] as const) {
      expect(() => parse(body, NUMBER, type)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (_data: Data, events: Scan[]) => { events[0]!.ts = '2026-03-19T13:14:05-07:00'; },
      (_data: Data, events: Scan[]) => { events[0]!.ts = '2026-02-30T12:00:00.000Z'; },
      (_data: Data, events: Scan[]) => { events[0]!.ts = null; },
      (_data: Data, events: Scan[]) => { events[0]!.ts = 1_776_369_115_000; },
      (_data: Data, events: Scan[]) => { Object.assign(events[0]!, { description: null, eventDescription: null, eventSupplementalInfo: null, eventCode: '57104' }); },
      (_data: Data, events: Scan[]) => { events[1]!.eventDescription = '$1:props:data'; },
      (_data: Data, events: Scan[]) => { events[1]!.timeZone = { name: 'America/Chicago' }; },
      (_data: Data, events: Scan[]) => { events[1]!.eventCode = { code: '57104' }; },
      (data: Data) => { data.events = 'none'; },
      (data: Data, events: Scan[]) => { data.events = Array.from({ length: 501 }, () => events[0]); },
      (data: Data) => { data.events = [null]; },
    ]) expect(() => parse(withData(change))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withData((data) => { data.events = []; }))).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });
});

describe('SpeedX adapter', () => {
  it('asks the tracking page once for its server components, with the host User-Agent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => rsc(DELIVERED));
    const result = await adapter(environment(fetcher, 'ExampleHost/1.0')).track({ number: ' spxaaa-000000 000000-000001 ' });
    expect(result.events).toHaveLength(7);
    await adapter(environment(fetcher)).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const agents: (string | null)[] = [];
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe(`https://tracking.speedx.io/${NUMBER}`);
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('RSC')).toBe('1');
      expect(headers.has('Cookie')).toBe(false);
      expect(headers.has('Authorization')).toBe(false);
      agents.push(headers.get('User-Agent'));
    }
    expect(agents).toEqual(['ExampleHost/1.0', DEFAULT_USER_AGENT]);
  });

  it('answers an unknown number as not found, a web page as a challenge and an empty reply as inconclusive, even with HTTP 200', async () => {
    await expect(adapter(environment(vi.fn<typeof fetch>(async () => rsc(ABSENT)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'not_found' });
    const page = vi.fn<typeof fetch>(async () => new Response(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }));
    await expect(adapter(environment(page)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>(async () => rsc('')))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']])(
    'keeps HTTP %s distinct from an unknown number', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response('Failure', { status }));
      await expect(new SpeedxTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('reports a rate limit with its Retry-After', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('Slow down', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(new SpeedxTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
  });

  it('rejects invalid input before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['SPXAAA0000000000001', `${NUMBER}/../x`, 'SPX'.repeat(30)]) {
      await expect(new SpeedxTracker({ fetcher: unused }).fetch(number)).rejects.toThrow(InvalidInputError);
    }
    await expect(new SpeedxTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const controller = new AbortController();
    const cancelled = vi.fn<typeof fetch>(async (_url, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return rsc(DELIVERED);
    });
    await expect(new SpeedxTracker({ fetcher: cancelled }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    const slow = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted();
      return rsc(DELIVERED);
    });
    await expect(new SpeedxTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    expect(slow).toHaveBeenCalledOnce();
    const huge = vi.fn<typeof fetch>(async () => rsc('x'.repeat(1_000_001)));
    await expect(new SpeedxTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});

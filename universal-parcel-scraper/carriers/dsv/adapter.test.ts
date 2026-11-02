import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DSV_SCHENKER_ENDPOINT, DSV_SEARCH_ENDPOINT, DSV_SHIPMENT_ENDPOINT, DSV_STATUSES_ENDPOINT, DsvTracker } from './adapter.js';
import { confirmDsvShipment, parseDsvStatuses, pickDsvShipment, type DsvShipment } from './parser.js';
import { parseDsvPuzzles } from './puzzle.js';
import { dsvSchenkerRoute, parseDsvSchenkerShipment, pickDsvSchenkerShipment } from './schenker.js';
import { dsvCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const HOUSE_BILL = 'ZZX0000017';
const BOOKING = '990000001';
const UNKNOWN = 'ZZ99999999';
const AIR_KEY = '00000000-0000-4000-8000-00000000a001';
const ROAD_KEY = '00000000-0000-4000-8000-00000000b002';
const AIR: DsvShipment = { key: AIR_KEY, mode: 'AIR', own: false };
const ROAD: DsvShipment = { key: ROAD_KEY, mode: 'ROAD', own: true };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(text(name)) as Record<string, unknown>;
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** Answers each myDSV route from the named fixtures. */
const routes = (search: string, details: string | null, history: string) => vi.fn<typeof fetch>().mockImplementation(async (input) => {
  const url = String(input);
  if (url.startsWith(DSV_SEARCH_ENDPOINT)) return reply(text(search));
  if (url.startsWith(DSV_STATUSES_ENDPOINT)) return reply(text(history));
  if (details && url.startsWith(DSV_SHIPMENT_ENDPOINT)) return reply(text(details));
  return reply('{}', 404);
});
const rows = (result: ReturnType<typeof parseDsvStatuses>) =>
  result.events!.map(event => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);
type Row = Record<string, unknown> & { children?: Row[] };
type Group = Row & { children: Row[] };
const editedHistory = (name: string, change: (payload: { events: Group[]; legData: null | Record<string, unknown> }) => void) => {
  const payload = JSON.parse(text(name)) as { events: Group[]; legData: null | Record<string, unknown> };
  change(payload);
  return payload;
};

// The former DB Schenker tracker: a road shipment's STT, its booking STT, its package's SSCC and its id.
const STT = 'ZZX0000042';
const BOOKED_STT = 'ZZX0000041';
const SSCC = '999999990000000426';
const LAND_ID = `LandStt:${STT}:CTTS,OSM:LAND`;
// The id an STT's details are asked by, without the data sources the tracker adds.
const STT_ID = `LandStt:${STT}:LAND`;
const SCHENKER_SEARCH = `${DSV_SCHENKER_ENDPOINT}/shipments?query=`;
const SCHENKER_LAND = `${DSV_SCHENKER_ENDPOINT}/shipments/land/`;
/** A signed token holding a 64-byte puzzle; its signature is not checked here. */
const token = (exponent = 33, mantissa = 10, fill = 7, length = 64) => {
  const puzzle = Buffer.alloc(length, fill);
  puzzle.writeInt8(exponent, 13);
  puzzle.writeInt8(mantissa, 14);
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ puzzle: puzzle.toString('base64'), iat: 1, exp: 61 })).toString('base64url')}.c2lnbmF0dXJl`;
};
const puzzleHeader = (...tokens: string[]) => Buffer.from(tokens.join(',')).toString('base64');
const PUZZLES = puzzleHeader(token(33, 10, 7), token(33, 10, 9));
/** Whether every nonce gives its puzzle a double SHA-256 under the target, checked apart from the adapter's solver. */
const solved = (header: string): boolean => {
  const entries = JSON.parse(Buffer.from(header, 'base64').toString()) as { jwt: string; solution: string }[];
  return entries.length > 0 && entries.every(({ jwt, solution }) => {
    const puzzle = Buffer.from((JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as { puzzle: string }).puzzle, 'base64');
    const nonce = Buffer.from(solution, 'base64');
    const hash = createHash('sha256').update(createHash('sha256').update(Buffer.concat([puzzle.subarray(0, 32), nonce])).digest()).digest();
    const value = BigInt(`0x${Buffer.from(hash).reverse().toString('hex')}`);
    return nonce.length === 8 && value < BigInt(puzzle.readInt8(14)) << BigInt(8 * (puzzle.readInt8(13) - 3));
  });
};
type Answer = string | (() => Response);
const answer = (value: Answer) => typeof value === 'string' ? reply(text(value)) : value();
/**
 * myDSV's search does not know the number; the former DB Schenker tracker
 * asks for a puzzle, then answers a solved request from the named fixtures.
 */
const former = (search: Answer, details: Answer = 'schenker-land', puzzles: string | null = PUZZLES) =>
  vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith(DSV_SEARCH_ENDPOINT)) return reply(text('search-empty'));
    if (!url.startsWith(DSV_SCHENKER_ENDPOINT)) return reply('{}', 404);
    const solution = new Headers(init?.headers).get('captcha-solution');
    if (!solution) return new Response('', { status: 429, headers: puzzles ? { 'Captcha-Puzzle': puzzles } : {} });
    if (!solved(solution)) return new Response('', { status: 422 });
    return answer(url.startsWith(SCHENKER_LAND) ? details : search);
  });
const land = (change: (payload: Record<string, unknown> & { events: Record<string, unknown>[] }) => void) => () => {
  const payload = json('schenker-land') as Record<string, unknown> & { events: Record<string, unknown>[] };
  change(payload);
  return reply(JSON.stringify(payload));
};

describe('DSV tracking adapter', () => {
  it('searches myDSV for the whole number, confirms a house bill in the details and reads the history by the shipment key', async () => {
    const fetcher = routes('search-air', 'details-air', 'statuses-air');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DsvTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzx 000-0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://mydsv.com/app/search/publicShipmentList?q=${HOUSE_BILL}`,
      `https://mydsv.com/app/search/shipment/${AIR_KEY}?detailedMilestones=true`,
      `https://mydsv.com/app/search/shipment/new-statuses/${AIR_KEY}`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(new Headers(init!.headers).has('cookie')).toBe(false);
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dsv', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('skips the details when the search names the number as the shipment’s own id', async () => {
    const fetcher = routes('search-road', null, 'statuses-road');
    await expect(carrier(fetcher).track({ number: BOOKING })).resolves.toMatchObject({ current_stage: 'accepted' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${DSV_SEARCH_ENDPOINT}?q=${BOOKING}`, `${DSV_STATUSES_ENDPOINT}${ROAD_KEY}`,
    ]);
    await expect(carrier(routes('search-road', null, 'statuses-road')).track({ number: 'ZZR0000000042' }))
      .resolves.toMatchObject({ current_stage: 'accepted' });
  });

  it('reads an air shipment as the page lists it: the groups around the main carriage and each port’s own rows, as wall clocks', () => {
    const result = parseDsvStatuses(json('statuses-air'), AIR);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Handover responsibilty of cargo', last_update: null, last_update_local: '2026-03-07T10:45:00',
      expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-03-07T10:45:00', 'Z70', 'delivered', null],
      ['2026-03-06T18:10:00', 'ARV', 'in_transit', 'Receivertown Apt, XC'],
      ['2026-03-05T21:15:00', 'DEP', 'in_transit', 'Transit Hub, XB'],
      ['2026-03-05T06:40:00', 'ARV', 'in_transit', 'Transit Hub, XB'],
      ['2026-03-04T11:20:00', 'DEP', 'in_transit', 'Example Airport, XA'],
      ['2026-03-03T15:05:00', 'IRP', 'accepted', 'XA'],
      // A booking comes with its day alone.
      ['2026-03-02', 'BOOKING', 'registered', null],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.description)).toBe(true);
    // Earlier values of a row are its history, not rows of their own.
    expect(result.events!.some(event => event.local_time === '2026-03-05T22:05:00')).toBe(false);
  });

  it('reads the history groups without port data, drops postcodes and keeps the delivery estimate until delivery', () => {
    const result = parseDsvStatuses(json('statuses-road'), ROAD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Actual pickup',
      last_update_local: '2026-05-12T16:40:00', expected_delivery: '2026-05-15', expected_delivery_from: '2026-05-14' });
    expect(rows(result)).toEqual([
      ['2026-05-12T16:40:00', 'ACTUAL_PICKUP', 'accepted', 'SENDERTOWN, XA'],
      ['2026-05-11T14:25:00', 'CREATION', 'registered', null],
    ]);
    const delivered = editedHistory('statuses-road', payload => {
      payload.events[0]!.children.unshift({ ...payload.events[0]!.children[0]!, eventCode: 'ACTUAL_DELIVERY', description: 'Actual delivery',
        eventDate: '2026-05-13T10:05:00', eventDateTo: null });
    });
    expect(parseDsvStatuses(delivered, ROAD)).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    expect(parseDsvStatuses(delivered, ROAD).expected_delivery_from).toBeUndefined();
    // One day of estimate has no window.
    const day = editedHistory('statuses-road', payload => { payload.events[0]!.children[0]!.eventDateTo = null; });
    expect(parseDsvStatuses(day, ROAD)).toMatchObject({ expected_delivery: '2026-05-14' });
    expect(parseDsvStatuses(day, ROAD).expected_delivery_from).toBeUndefined();
  });

  it('never reads the parties, references, contacts or the shipment key', async () => {
    const result = await carrier(routes('search-road', null, 'statuses-road')).track({ number: BOOKING });
    const air = await carrier(routes('search-air', 'details-air', 'statuses-air')).track({ number: HOUSE_BILL });
    for (const answer of [result, air]) {
      expect(JSON.stringify(answer)).not.toMatch(/Example (?:Sender|Receiver|Signer)|Sample (?:Street|Road)|RECEIVERTOWN|00000(?!-)|11111|99999-000|PO-EXAMPLE|example@|\+00|00000000-0000|123\.4/);
    }
  });

  it('flattens an XPRESS shipment’s earlier rows as its page does, and counts a repeated row once', () => {
    const xpress = editedHistory('statuses-air', payload => { payload.legData = null; });
    expect(parseDsvStatuses(xpress, { ...AIR, mode: 'XPRESS' }).events!.map(event => event.local_time))
      .toContain('2026-03-05T21:15:00');
    expect(parseDsvStatuses(xpress, AIR).events!.map(event => event.local_time)).not.toContain('2026-03-05T21:15:00');
    const repeated = editedHistory('statuses-road', payload => {
      payload.events[1]!.children.push({ ...payload.events[1]!.children[0]! });
      payload.events.reverse();
    });
    expect(rows(parseDsvStatuses(repeated, ROAD))).toEqual(rows(parseDsvStatuses(json('statuses-road'), ROAD)));
  });

  it('leaves cancelled rows and estimates out, and stages new codes through the shared wording rules', () => {
    const cancelled = editedHistory('statuses-road', payload => { payload.events[1]!.children[0]!.cancelled = true; });
    expect(parseDsvStatuses(cancelled, ROAD)).toMatchObject({ current_stage: 'registered', last_status_text: 'Creation' });
    const worded = editedHistory('statuses-road', payload => {
      payload.events[1]!.children.unshift({ ...payload.events[1]!.children[0]!, eventCode: 'POD_RECEIVED', description: 'Shipment delivered',
        eventDate: '2026-05-13T09:00:00' },
      { ...payload.events[1]!.children[0]!, eventCode: 'PLANNED_X', description: 'Planned delivery', eventDate: '2026-05-20T09:00:00' });
    });
    expect(parseDsvStatuses(worded, ROAD)).toMatchObject({ current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = editedHistory('statuses-road', payload => {
      payload.events[1]!.children.unshift({ ...payload.events[1]!.children[0]!, eventCode: 'ZZZ', description: 'Documents checked',
        eventDate: '2026-05-13T09:00:00', location: { place: '-', countryCode: 'XA' } });
    });
    const result = parseDsvStatuses(unknown, ROAD);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Documents checked' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ local_time: '2026-05-13T09:00:00', description: 'Documents checked', provider_code: 'ZZZ', location: 'XA' });
    const estimates = editedHistory('statuses-road', payload => { payload.events.splice(1); });
    expect(() => parseDsvStatuses(estimates, ROAD)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'no_history' }));
  });

  it('leaves a number the search does not know, or knows only by references, open', async () => {
    expect(() => pickDsvShipment(json('search-empty'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    const fetcher = former('schenker-empty');
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A match on another id or the master bill only, such as a customer's or an airline's number.
    const master = { ...json('details-air'), houseBillNumber: 'ZZX0000099' };
    expect(() => confirmDsvShipment(master, '99900000011')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'reference_only' }));
    expect(() => confirmDsvShipment(json('details-air'), HOUSE_BILL)).not.toThrow();
    expect(() => confirmDsvShipment(json('details-air'), 'SZZX0000017')).not.toThrow();
    const reference = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(DSV_SEARCH_ENDPOINT)
      ? reply(text('search-air')) : reply(JSON.stringify(master)));
    await expect(carrier(reference).track({ number: 'ZZX0000099A' })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'reference_only' });
    expect(reference).toHaveBeenCalledTimes(2);
    const air = json('search-air').data as Record<string, unknown>[];
    const road = json('search-road').data as Record<string, unknown>[];
    expect(() => pickDsvShipment({ data: [...air, ...road] }, 'POEXAMPLE1')).toThrow(expect.objectContaining({ reason: 'reference_only' }));
    expect(() => pickDsvShipment({ data: [...road, { ...road[0], randomIdentifier: AIR_KEY }] }, BOOKING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(pickDsvShipment({ data: [...air, ...road] }, BOOKING)).toEqual(ROAD);
  });

  it('takes letters and digits myDSV searches, without a request for anything else', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('search-empty')));
    for (const number of ['ABCDEFGH', '1234', 'Z'.repeat(40) + '1', 'ZZ0000/01', 'ZZ_000001']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed replies', () => {
    for (const payload of [null, [], {}, { data: {} }, { data: [1] }, { data: Array.from({ length: 101 }, () => ({})) },
      { data: [{ ...(json('search-road').data as object[])[0], randomIdentifier: '../x' }] }]) {
      expect(() => pickDsvShipment(payload, BOOKING), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => confirmDsvShipment([], HOUSE_BILL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [null, [], {}, { events: {} }, { events: [], legData: [] },
      editedHistory('statuses-road', reply => { reply.events[1]!.children[0]!.eventDate = '12/05/2026 16:40'; }),
      editedHistory('statuses-road', reply => { reply.events[1]!.children[0]!.eventDate = '2026-02-30T16:40:00'; }),
      editedHistory('statuses-road', reply => { reply.events[1]!.children[0]!.eventCode = 'A B'; }),
      editedHistory('statuses-road', reply => { reply.events[1]!.children = 'none' as unknown as Row[]; }),
      editedHistory('statuses-road', reply => { (reply.events as unknown[])[1] = 'group'; }),
      editedHistory('statuses-air', reply => { (reply.legData!.legs as Record<string, unknown>[])[0]!.legEvents = [7]; })]) {
      expect(() => parseDsvStatuses(payload, ROAD), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s on every request, without a retry and without the shipment key on the error', async (status, kind) => {
      const search = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"error":"failure"}', status));
      await expect(carrier(search).track({ number: BOOKING })).rejects.toMatchObject({ kind });
      expect(search).toHaveBeenCalledTimes(1);
      const history = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(DSV_SEARCH_ENDPOINT)
        ? reply(text('search-road')) : reply(`{"error":"failure ${ROAD_KEY}"}`, status));
      const error = await carrier(history).track({ number: BOOKING }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      expect(history).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(error)).not.toContain(ROAD_KEY);
      expect((error as { request?: unknown }).request).toBeUndefined();
      expect((error as { diagnostics?: unknown }).diagnostics).toBeUndefined();
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    });

  it('keeps block pages and malformed replies apart from missing shipments', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Access Denied</title></head><body>You don\'t have permission to access this server.</body></html>', 'challenge'],
      ['<html><head><title>Just a moment...</title></head><body></body></html>', 'challenge'],
      ['<!doctype html><html><head><title>myDSV</title></head><body><app-root></app-root></body></html>', 'schema'], ['', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).track({ number: BOOKING }), body).rejects.toMatchObject({ kind });
      const later = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(DSV_SEARCH_ENDPOINT)
        ? reply(text('search-road')) : reply(body));
      await expect(carrier(later).track({ number: BOOKING }), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: BOOKING })).rejects.toThrow('unexpectedly large');
  });

  it('tries the lookup once more after a failed connection, inside the caller’s budget', async () => {
    const answers = routes('search-road', null, 'statuses-road');
    const flaky = vi.fn<typeof fetch>().mockImplementationOnce(async (input) => answers(input))
      .mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(async (input) => answers(input));
    await expect(carrier(flaky).track({ number: BOOKING })).resolves.toMatchObject({ current_stage: 'accepted' });
    expect(flaky).toHaveBeenCalledTimes(4);
    const failed = await carrier(vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(DSV_SEARCH_ENDPOINT)
      ? reply(text('search-road')) : Promise.reject(new TypeError('fetch failed')))).track({ number: BOOKING }).catch((caught: unknown) => caught);
    expect(failed).toMatchObject({ kind: 'transport' });
    expect(JSON.stringify(failed)).not.toContain(ROAD_KEY);
    const immediate = routes('search-road', null, 'statuses-road');
    await expect(carrier(immediate).track({ number: BOOKING }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: BOOKING }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: BOOKING }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a shipment filed under DSV to the adapter, which detection never names nor recognition asks about', async () => {
    const fetcher = routes('search-road', null, 'statuses-road');
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: BOOKING, carrier: 'dsv' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dsv', source: 'dsv', result: { current_stage: 'accepted' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://mydsv.com/app/search/'))).toBe(true);
    for (const number of [HOUSE_BILL, BOOKING, 'ZZR0000000042']) {
      expect(detectCarrierMatch(number)?.carrier).not.toBe('dsv');
      expect(recognitionAskedCarriers(number)).not.toContain('dsv');
    }
    // DSV's own links: myDSV's search, and the former DB Schenker tracker its header form and Self-services open.
    for (const link of [`https://mydsv.com/new/tracking/track-shipment?query=${HOUSE_BILL}`,
      `https://www.dsv.com/mydsv/tracking-public?refNumber=${HOUSE_BILL}`, `https://mydsv.dsv.com/app/tracking-public?refNumber=${HOUSE_BILL}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: HOUSE_BILL, carrier: 'dsv', source: 'link' });
    }
  });
});

describe('DSV former DB Schenker tracker', () => {
  it('sends a number myDSV does not know to the former DB Schenker tracker, solves its puzzle and reads the road shipment', async () => {
    const fetcher = former('schenker-search');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new DsvTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzx 000-0042 ', { budgetMs: 10_000 });
    // An STT's details straight away, by the id without its data sources.
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${DSV_SEARCH_ENDPOINT}?q=${STT}`, `${SCHENKER_LAND}${STT_ID}`, `${SCHENKER_LAND}${STT_ID}`,
    ]);
    const headers = fetcher.mock.calls.slice(1).map(([, init]) => new Headers(init!.headers));
    expect(headers.map(header => header.has('captcha-solution'))).toEqual([false, true]);
    for (const header of headers) {
      expect(header.get('user-agent')).toBe('SyntheticHost/1.0');
      expect(header.get('accept')).toBe('application/json');
      expect(header.has('cookie')).toBe(false);
    }
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Not delivered: Closed/holiday', last_update: null, last_update_local: '2026-05-13T15:10:00',
      expected_delivery: '2026-05-14' });
    // Wall clocks as the page prints them, whether the reply labels them Z or with an offset.
    expect(rows(result)).toEqual([
      ['2026-05-13T15:10:00', 'NDL', 'failed_attempt', 'Receivertown, XC'],
      ['2026-05-13T07:25:50', 'DOT', 'out_for_delivery', 'Transit Terminal, XB'],
      ['2026-05-12T06:29:34', 'ENM', 'in_transit', 'Transit Terminal, XB'],
      ['2026-05-12T02:34:00', 'MAN', 'in_transit', 'Origin Terminal, XA'],
      ['2026-05-11T16:36:17', 'ENM', 'in_transit', 'Origin Terminal, XA'],
      ['2026-05-11T16:36:17', 'COL', 'accepted', 'Sendertown, XA'],
      ['2026-05-11T09:28:19', 'ENT', 'registered', 'Origin Terminal, XA'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.description)).toBe(true);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dsv', step: 'direct', outcome: 'indeterminate' }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dsv', step: 'schenker', outcome: 'ok', fallbackFrom: 'direct' }));
    // A package's SSCC goes through the search, then the details of the shipment it finds.
    const package_ = former('schenker-search');
    await expect(carrier(package_).track({ number: `00${SSCC}` })).resolves.toMatchObject({ current_stage: 'failed_attempt' });
    expect(package_.mock.calls.map(([url]) => String(url))).toEqual([
      `${DSV_SEARCH_ENDPOINT}?q=00${SSCC}`, `${SCHENKER_SEARCH}00${SSCC}`, `${SCHENKER_SEARCH}00${SSCC}`,
      // The id goes as the page sends it, colons and commas included.
      `${SCHENKER_LAND}${LAND_ID}`, `${SCHENKER_LAND}${LAND_ID}`,
    ]);
    // The facade leaves the step its time.
    const routed = former('schenker-search');
    await expect(createTracker({ fetcher: routed, providers: [], env: {} }).track({ number: STT, carrier: 'dsv' }))
      .resolves.toMatchObject({ carrier: 'dsv', source: 'dsv', result: { current_stage: 'failed_attempt' } });
    expect(routed).toHaveBeenCalledTimes(3);
  });

  it('is offered with low confidence for a long STT under a European country code, and for no other layout', () => {
    for (const number of ['FRABC123456789', 'DEXYZ000000001']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dsv'] });
      expect(dsvSchenkerRoute(number)).toBe('stt');
    }
    for (const number of ['CNABC123456789', 'FRABC12345678', 'FRABC1234567890', 'FRAB1123456789']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('dsv');
    }
  });

  it('recognizes a long STT through the former tracker alone, puzzle included', async () => {
    const long = 'DEXYZ000000001';
    const details = land((payload) => { payload.sttNumber = long; payload.shipmentId = `LandStt:${long}:CTTS,OSM:LAND`; });
    const fetcher = former('schenker-search', details);
    expect(recognitionAskedCarriers(long)).toEqual(['dsv']);
    await expect(carrier(fetcher).recognize!(` ${long.toLowerCase()} `, { budgetMs: 60_000 }))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-13T15:10:00' });
    // myDSV's search does not know former DB Schenker STTs, so it is not asked.
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${SCHENKER_LAND}LandStt:${long}:LAND`, `${SCHENKER_LAND}LandStt:${long}:LAND`]);
    vi.useFakeTimers({ now: new Date('2026-05-14T12:00:00Z'), toFake: ['Date'] });
    try {
      await expect(createTracker({ fetcher: former('schenker-search', details), providers: [], env: {} }).recognize(long))
        .resolves.toMatchObject({ carrier: 'dsv', asked: ['dsv'], unanswered: [] });
    } finally {
      vi.useRealTimers();
    }
    // Any other number takes the ordinary lookup.
    const booking = routes('search-road', null, 'statuses-road');
    await expect(carrier(booking).recognize!(BOOKING)).resolves.toMatchObject({ known: true });
    expect(booking.mock.calls.every(([url]) => String(url).startsWith('https://mydsv.com/app/search/'))).toBe(true);
  });

  it('leaves DSV offered by its rule alone when the former tracker does not know an STT or answers late', async () => {
    const long = 'DEXYZ000000001';
    for (const details of [() => reply('{"code":"TRACKING-BADREQ-SHIPMENT_NOT_FOUND"}', 400), () => reply('{"code":"TRACKING-NOTFOUND"}', 404)]) {
      const fetcher = former('schenker-search', details);
      await expect(carrier(fetcher).recognize!(long)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
      await expect(createTracker({ fetcher, providers: [], env: {} }).recognize(long))
        .resolves.toMatchObject({ choices: [], asked: ['dsv'], unanswered: ['dsv'] });
    }
    expect(detectCarrierMatch(long)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dsv'] });
    const answers = former('schenker-search');
    const hanging = vi.fn<typeof fetch>().mockImplementation(async (input, init) => new Headers(init?.headers).has('captcha-solution')
      ? new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
      : answers(input, init));
    // Recognition's own limit holds against a longer budget, and a shorter budget holds against it.
    for (const [options, budgetMs] of [[{ recognitionMs: 300 }, 60_000], [{}, 300]] as const) {
      const started = performance.now();
      await expect(new DsvTracker({ fetcher: hanging, ...options }).recognize(long, { budgetMs })).rejects.toMatchObject({ kind: 'budget' });
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });

  it('asks the former tracker only for an STT or a package SSCC', async () => {
    for (const number of [STT, 'ZZX00000420', 'ZZXAA000000042']) expect(dsvSchenkerRoute(number), number).toBe('stt');
    for (const number of [SSCC, `00${SSCC}`]) expect(dsvSchenkerRoute(number), number).toBe('sscc');
    for (const number of [UNKNOWN, '99900000011', 'ZZX000004', 'ZZXA0000042', '999999990000000425', `01${SSCC}`, 'POEXAMPLE1']) {
      expect(dsvSchenkerRoute(number), number).toBeNull();
      const fetcher = former('schenker-search');
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up on a late answer at the step’s longest wait or when the lookup’s time ends', async () => {
    const answers = former('schenker-search');
    const hanging = vi.fn<typeof fetch>().mockImplementation(async (input, init) => new Headers(init?.headers).has('captcha-solution')
      ? new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
      : answers(input, init));
    const waits = { stt: 300, sscc: 300 };
    for (const [number, budgetMs] of [[STT, 60_000], [SSCC, 60_000], [STT, 400], [SSCC, 400]] as const) {
      const started = performance.now();
      const error = await new DsvTracker({ fetcher: hanging, schenkerMs: budgetMs === 400 ? undefined : waits }).fetch(number, { budgetMs })
        .catch((caught: unknown) => caught);
      expect(error, `${number} ${budgetMs}`).toMatchObject({ kind: 'budget' });
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(JSON.stringify(error)).not.toMatch(/eyJ|solution/i);
    }
  });

  it('binds the shipment by its STT, its booking STT or a package SSCC, and leaves waybills and references open', async () => {
    for (const number of [STT, BOOKED_STT, SSCC, `00${SSCC}`]) {
      await expect(carrier(former('schenker-search')).track({ number }), number).resolves.toMatchObject({ current_stage: 'failed_attempt' });
    }
    await expect(carrier(former('schenker-search')).track({ number: 'ZZXAA-000000042' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'reference_only' });
    for (const number of ['99900000011', 'ZZXAA-000000042', 'POEXAMPLE1', 'CONSIGNEEEXAMPLE1']) {
      expect(() => parseDsvSchenkerShipment(json('schenker-land'), number, LAND_ID), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'reference_only' }));
    }
    // Asked with its data sources, the reply must be that id; asked without, a road id of the same kind.
    expect(() => parseDsvSchenkerShipment(json('schenker-land'), STT, `LandStt:${STT}:CTTS:LAND`)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseDsvSchenkerShipment(json('schenker-land'), BOOKED_STT, `LandStt:${BOOKED_STT}:LAND`).events).toHaveLength(7);
    for (const shipmentId of [`LandPackageId:${STT}:CTTS:LAND`, `LandStt:${STT}`, `LandStt:${STT}:CTTS:AIR`]) {
      expect(() => parseDsvSchenkerShipment({ ...json('schenker-land'), shipmentId }, STT, `LandStt:${STT}:LAND`).events, shipmentId)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const search = json('schenker-search').result as Record<string, unknown>[];
    const other = { ...search[0], id: 'LandStt:ZZX0000043:CTTS:LAND', stt: 'ZZX0000043' };
    expect(pickDsvSchenkerShipment({ result: [other, search[0]] }, STT)).toBe(LAND_ID);
    expect(() => pickDsvSchenkerShipment({ result: [other, search[0]] }, SSCC))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(() => pickDsvSchenkerShipment({ result: [{ ...search[0], transportMode: 'AIR', id: `AirStt:${STT}:X:AIR` }] }, STT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a delivery, its recipient and the parties out of what it returns, and drops the estimate once delivered', async () => {
    const delivered = land(payload => {
      payload.events.push({ ...payload.events[6], code: 'DLV', date: '2026-05-14T10:05:00+02:00', comment: 'Delivered',
        location: { name: 'Receivertown 99999', code: 'ZZT', countryCode: 'XC' }, recipient: 'Example Signer' });
    });
    const result = await carrier(former('schenker-search', delivered)).track({ number: STT });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update_local: '2026-05-14T10:05:00', expected_delivery: null });
    expect(result.events![0]).toEqual({ local_time: '2026-05-14T10:05:00', description: 'Delivered', provider_code: 'DLV',
      location: 'Receivertown, XC', stage: 'delivered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/Example (?:Sender|Receiver|Signer|service|terms)|Sample (?:Street|Road)|SENDERTOWN|RECEIVERTOWN|ORIGIN\b|11111|99999|EXAMPLE|123\.4|ZZXAA|99900000011|CTTS/);
    // Without an agreed day, the estimated one.
    const estimated = land(payload => { payload.deliveryDate = { estimated: '2026-05-15T00:00:00Z', agreed: null }; });
    await expect(carrier(former('schenker-search', estimated)).track({ number: STT })).resolves.toMatchObject({ expected_delivery: '2026-05-15' });
    const unstaged = land(payload => {
      payload.events.push({ ...payload.events[6], code: 'ZZZ', date: '2026-05-14T08:00:00Z', comment: 'Documents checked', reasons: null });
    });
    const open = await carrier(former('schenker-search', unstaged)).track({ number: STT });
    expect(open).toMatchObject({ status: 'unknown', last_status_text: 'Documents checked' });
    expect(open.current_stage).toBeUndefined();
    const undated = land(payload => { for (const row of payload.events) row.date = null; });
    await expect(carrier(former('schenker-search', undated)).track({ number: STT }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'no_history' });
  });

  it('leaves a number neither tracker knows open', async () => {
    const missing: Answer[] = [() => reply('{"code":"TRACKING-NOTFOUND"}', 404),
      () => reply('{"code":"TRACKING-BADREQ-NO_MATCHING_PATTERN_FOUND"}', 400),
      () => reply('{"code":"TRACKING-BADREQ-SHIPMENT_NOT_FOUND"}', 400)];
    // An STT's details, or a package's search.
    for (const [number, fetcher] of [...missing.map(details => [STT, former('schenker-search', details)] as const),
      ...(['schenker-empty', ...missing] as Answer[]).map(search => [SSCC, former(search)] as const)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
      expect(fetcher).toHaveBeenCalledTimes(3);
    }
    const refused = await carrier(former('schenker-search', () => reply('{"code":"TRACKING-BADREQ-INVALID"}', 400))).track({ number: STT })
      .catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ kind: 'indeterminate' });
    expect((refused as { reason?: string }).reason).toBeUndefined();
  });

  it('asks the former tracker only after myDSV answered that it does not know the number', async () => {
    for (const status of [404, 500, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
      await expect(carrier(fetcher).track({ number: STT })).rejects.toMatchObject({ kind: expect.any(String) });
      expect(fetcher.mock.calls.every(([url]) => !String(url).startsWith(DSV_SCHENKER_ENDPOINT))).toBe(true);
    }
  });

  it('keeps puzzle, HTTP and reply failures apart from a missing shipment, without the solution on the error', async () => {
    // Each reply as an STT's details and as a package's search.
    const replies: [Answer, string][] = [
      [() => new Response('', { status: 429, headers: { 'Captcha-Puzzle': PUZZLES } }), 'challenge'],
      [() => new Response('', { status: 429 }), 'rate_limited'],
      [() => new Response('', { status: 422 }), 'challenge'],
      [() => reply('{}', 401), 'challenge'],
      [() => reply('{}', 500), 'indeterminate'],
      [() => reply('{}', 503), 'maintenance'],
      [() => reply('{}', 504), 'indeterminate'],
      [() => reply('<html><head><title>Access Denied</title></head></html>'), 'challenge'],
      [() => reply('<!doctype html><html><body><app-root></app-root></body></html>'), 'schema'],
    ];
    const cases: (readonly [ReturnType<typeof former>, string, string])[] = [
      [former('schenker-search', 'schenker-land', null), 'rate_limited', STT],
      [former('schenker-search', 'schenker-land', null), 'rate_limited', SSCC],
      ...replies.flatMap(([value, kind]) => [[former('schenker-search', value), kind, STT], [former(value), kind, SSCC]] as const),
      [former('schenker-search', () => reply('{}', 500)), 'indeterminate', SSCC],
      [former(() => reply('{"result":{}}')), 'schema', SSCC],
      [former(() => reply(JSON.stringify({ result: [{ id: '../x', stt: STT, transportMode: 'LAND' }] }))), 'schema', SSCC],
      [former('schenker-search', () => reply('{"events":{}}')), 'schema', STT],
      [former('schenker-search', land(payload => { payload.events[0]!.date = '13/05/2026 15:10'; })), 'schema', STT],
      [former('schenker-search', land(payload => { payload.events[0]!.date = '2026-02-30T15:10:00Z'; })), 'schema', STT],
      [former('schenker-search', land(payload => { payload.events[0]!.code = 'A B'; })), 'schema', SSCC],
      [former('schenker-search', land(payload => { payload.events[0]!.reasons = 'none'; })), 'schema', STT],
    ];
    for (const [fetcher, kind, number] of cases) {
      const error = await carrier(fetcher).track({ number }).catch((caught: unknown) => caught);
      expect(error, `${kind} ${number}`).toMatchObject({ kind });
      expect((error as { request?: unknown }).request).toBeUndefined();
      expect((error as { diagnostics?: unknown }).diagnostics).toBeUndefined();
      expect(JSON.stringify(error)).not.toMatch(/eyJ|solution/i);
    }
    const missing = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(DSV_SEARCH_ENDPOINT)
      ? reply(text('search-empty')) : reply('{}', 404));
    await expect(carrier(missing).track({ number: STT })).rejects.toMatchObject({ kind: 'transport' });
    const answers = former('schenker-search');
    const failing = vi.fn<typeof fetch>().mockImplementation(async (input, init) =>
      new Headers(init?.headers).has('captcha-solution') ? Promise.reject(new TypeError('fetch failed')) : answers(input, init));
    const failed = await carrier(failing).track({ number: STT }).catch((caught: unknown) => caught);
    expect(failed).toMatchObject({ kind: 'transport' });
    expect(JSON.stringify(failed)).not.toMatch(/eyJ|solution/i);
  });

  it('reads only puzzles it can afford, and stops solving when the budget ends', async () => {
    for (const header of ['not a puzzle', puzzleHeader('a.b'), puzzleHeader(token(33, 10, 7, 63)), puzzleHeader(token(33, 0)),
      puzzleHeader(token(33, -10)), puzzleHeader(token(35, 10)), puzzleHeader(token(2, 10)), puzzleHeader(...Array.from({ length: 9 }, () => token()))]) {
      expect(() => parseDsvPuzzles(header, 'DSV'), header).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(parseDsvPuzzles(PUZZLES, 'DSV').map(puzzle => puzzle.expectedHashes)).toEqual([6553.6, 6553.6]);
    // A puzzle a thousand times harder than the tracker's is not attempted.
    const costly = former('schenker-search', 'schenker-land', puzzleHeader(token(32, 1)));
    await expect(carrier(costly).track({ number: STT })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'costly_puzzle' });
    expect(costly).toHaveBeenCalledTimes(2);
    // About eight million hashes: more than a short budget allows.
    const hard = former('schenker-search', 'schenker-land', puzzleHeader(token(32, 2)));
    const started = performance.now();
    await expect(carrier(hard).track({ number: STT }, { budgetMs: 300 })).rejects.toMatchObject({ kind: 'budget' });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(hard).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    const cancelled = carrier(former('schenker-search', 'schenker-land', puzzleHeader(token(32, 2)))).track({ number: STT }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancelled')), 50);
    await expect(cancelled).rejects.toThrow('cancelled');
  });
});

describe('DSV status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the estimates it leaves out on purpose', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(dsvCodeStage(entry.code), entry.code).toBe(stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(stage);
      if (!stage) {
        expect(statusMapAnswer({ carrier: 'dsv', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
      }
    }
    for (const code of ['constructor', 'toString', 'XYZ', '']) expect(dsvCodeStage(code), code).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'dsv', providerCode: 'Z70', description: 'Handover responsibilty of cargo' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DAI_POST_TRACK_URL, DaiPostTracker } from './adapter.js';
import { flightRows, parseDaiPost } from './parser.js';
import { daiPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'NZC999999001';
const TRANSIT = '00393580949999999992';
const UNKNOWN = 'NZC999999099';
const RSC = 'text/x-component';
const encoder = new TextEncoder();
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.rsc`, import.meta.url), 'utf8');
const bytes = (name: string) => encoder.encode(text(name));
const reply = (body: string | Uint8Array, init: { status?: number; type?: string } = {}) =>
  new Response(body as BodyInit, { status: init.status ?? 200, headers: { 'Content-Type': init.type ?? RSC } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

type Entry = { tracknbr: string; trackingevent: Record<string, string>[] | string; estimatedDeliveryDate: string; eddstatus: string };

/** The tracking view's entries in a fixture's page row. */
function trackingList(node: unknown): Entry[] | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = trackingList(child);
      if (found) return found;
    }
  } else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.trackingresponse)) return record.trackingresponse as Entry[];
    for (const child of Object.values(record)) {
      const found = trackingList(child);
      if (found) return found;
    }
  }
  return undefined;
}

/** A found fixture with its page row changed; the page row is the last row. */
function rewrite(name: string, change: (entries: Entry[]) => void): Uint8Array {
  const body = text(name);
  const at = body.lastIndexOf('\n2:');
  const page: unknown = JSON.parse(body.slice(at + 3));
  change(trackingList(page)!);
  return encoder.encode(`${body.slice(0, at)}\n2:${JSON.stringify(page)}\n`);
}

describe('DAI Post HTTP adapter', () => {
  it('asks the tracking page for its server components with the whole number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(bytes('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new DaiPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' nzc-999 999 001 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DAI_POST_TRACK_URL}?tracknbr=${DELIVERED}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal),
      headers: { RSC: '1', Accept: 'text/x-component', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dai-post', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered New Zealand parcel in Auckland time, the delivery first at a shared clock, and keeps US clocks local', () => {
    const result = parseDaiPost(bytes('delivered'), RSC, DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered! Your parcel has arrived. Enjoy!', last_update: '2026-03-04T10:15:00+13:00',
      delivered_at: '2026-03-04T10:15:00+13:00', expected_delivery: null });
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map(event => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-04T10:15:00+13:00', 'FD01', 'delivered', 'SYNTHVILLE EAST (SYN), NZ'],
      ['2026-03-04T10:15:00+13:00', 'FP05', 'out_for_delivery', 'SYNTHVILLE EAST (SYN), NZ'],
      ['2026-03-04T08:02:00+13:00', 'FP05', 'out_for_delivery', 'SYNTHVILLE EAST (SYN), NZ'],
      ['2026-03-03T15:40:00+13:00', 'DA05', 'in_transit', 'Exampleport, NZ'],
      ['2026-03-03T14:11:00+13:00', 'DH01', 'customs', 'NZ'],
      ['2026-03-03T14:10:00+13:00', 'DC01', 'in_transit', 'NZ'],
      ['2026-03-03T07:30:00+13:00', 'DA01', 'in_transit', 'Exampleport, NZ'],
      ['2026-03-01T12:05:00', 'OU01', 'in_transit', 'Synthtown, US'],
      ['2026-02-28T20:10:00', 'AD02', 'in_transit', null],
      ['2026-02-27T21:00:00', 'AD01', 'in_transit', null],
      ['2026-02-26T09:41:36', 'OP03', 'in_transit', 'Synthtown, US'],
      ['2026-02-26T09:30:00', 'OA01', 'accepted', 'Synthtown, US'],
      ['2026-02-20T14:03:00', 'CI02', 'registered', 'Synthtown, US'],
    ]);
    expect(result.events!.filter(event => event.local_time).every(event => !event.time)).toBe(true);
  });

  it('reads a parcel in Australia on local clocks with its delivery window, and single-zone origins as instants', () => {
    const result = parseDaiPost(bytes('in-transit'), RSC, TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null,
      last_update_local: '2026-03-10T13:33:26', last_status_text: 'Your parcel’s on its way to you, almost there!',
      expected_delivery_from: '2026-03-12', expected_delivery: '2026-03-16' });
    expect(result).not.toHaveProperty('delivered_at');
    const clocks = result.events!.map(event => [event.provider_code, event.time ?? `local ${String(event.local_time)}`]);
    expect(clocks).toContainEqual(['DH01', 'local 2026-03-06T12:06:00']);
    // Two scans at one clock, both in transit, keep the page's order.
    expect(clocks.slice(7, 10)).toEqual([['OU02', '2026-03-04T08:51:00+08:00'], ['DA08', '2026-03-04T08:51:00+08:00'],
      ['OP03', '2026-03-02T18:03:29+08:00']]);
    // The label data keeps its clock even where the country has one zone.
    expect(clocks.at(-1)).toEqual(['CI02', 'local 2026-03-02T12:06:47']);
  });

  it('reads one estimated day, swaps a reversed window and drops the estimate the page replaces or delivery settles', () => {
    const window = (estimate: string, eddstatus = '$undefined', name = 'in-transit', number = TRANSIT) =>
      parseDaiPost(rewrite(name, ([entry]) => Object.assign(entry!, { estimatedDeliveryDate: estimate, eddstatus })), RSC, number);
    expect(window('2026-03-14')).toMatchObject({ expected_delivery: '2026-03-14' });
    expect(window('2026-03-14')).not.toHaveProperty('expected_delivery_from');
    expect(window('2026-03-16 to 2026-03-12')).toMatchObject({ expected_delivery_from: '2026-03-12', expected_delivery: '2026-03-16' });
    expect(window('2026-03-12 to 2026-03-16', 'Delayed')).toMatchObject({ expected_delivery: null });
    for (const odd of ['soon', '2026-02-30', '2026-03-12 to 2026-03-14 to 2026-03-16']) expect(window(odd)).toMatchObject({ expected_delivery: null });
    expect(window('2026-03-05', '$undefined', 'delivered', DELIVERED)).toMatchObject({ expected_delivery: null });
  });

  it('stages an unknown code by its wording, and keeps unknown wording without a stage', () => {
    const result = parseDaiPost(rewrite('in-transit', ([entry]) => {
      const events = entry!.trackingevent as Record<string, string>[];
      events.unshift({ code: 'ZZ98', description: 'Mystery handling step', eventdate: '2026-03-11T08:00:00', city: 'Exampleton', country: 'AU' });
      events.unshift({ code: 'ZZ99', description: 'Out for delivery', eventdate: '2026-03-11T09:00:00', city: 'Exampleton', country: 'AU' });
    }), RSC, TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: 'ZZ99', stage: 'out_for_delivery' });
    expect(result.events![0]!.stage_source).toMatch(/^wording:/);
    expect(result.events![1]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
  });

  it('reads text rows by their byte length, with the next row on the same line', () => {
    const { rows } = flightRows(bytes('delivered'));
    expect(rows.some(row => JSON.stringify(row).includes('"trackingresponse"'))).toBe(true);
    const shortened = text('delivered').replace(/f:T([0-9a-f]+),/, (_match, length: string) => `f:T${(parseInt(length, 16) - 2).toString(16)},`);
    expect(() => parseDaiPost(encoder.encode(shortened), RSC, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const truncated = text('delivered').replace(/f:T([0-9a-f]+),/, 'f:Tfffff,');
    expect(() => parseDaiPost(encoder.encode(truncated), RSC, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the absence heading as not found only when the search field holds the requested number', () => {
    expect(() => parseDaiPost(bytes('not-found'), RSC, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDaiPost(bytes('not-found'), RSC, 'NZC999999098')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const echoless = text('not-found').replace(`"defaultValue":"${UNKNOWN}"`, '"defaultValue":"$undefined"');
    expect(() => parseDaiPost(encoder.encode(echoless), RSC, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The layout's generic 404 template alone says nothing about the number.
    const unworded = text('not-found').replace("Sorry, we couldn't find your parcel.", 'Something else.');
    expect(() => parseDaiPost(encoder.encode(unworded), RSC, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the entry to the whole requested number', () => {
    expect(() => parseDaiPost(bytes('delivered'), RSC, 'NZC999999002')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = rewrite('delivered', entries => { entries.push({ ...entries[0]!, tracknbr: 'NZC999999002' }); });
    expect(() => parseDaiPost(twice, RSC, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const prefixed = rewrite('delivered', ([entry]) => { entry!.tracknbr = `${DELIVERED}0`; });
    expect(() => parseDaiPost(prefixed, RSC, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a listed parcel without scans as having no history yet', () => {
    for (const events of [[], '$undefined']) {
      const listed = rewrite('in-transit', ([entry]) => { entry!.trackingevent = events; });
      expect(() => parseDaiPost(listed, RSC, TRANSIT)).toThrow(NoHistoryError);
    }
  });

  it('keeps a web page, an odd reply, a render failure and a changed scan apart from a missing parcel', () => {
    expect(() => parseDaiPost(encoder.encode('<!DOCTYPE html><html></html>'), 'text/html', TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDaiPost(encoder.encode('<!DOCTYPE html><html></html>'), RSC, TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDaiPost(bytes('in-transit'), 'application/json', TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDaiPost(new Uint8Array(), RSC, TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDaiPost(encoder.encode('not a flight reply'), RSC, TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The page row replaced by a component that threw on the server.
    const head = text('in-transit').split('\n2:')[0]!;
    expect(() => parseDaiPost(encoder.encode(`${head}\n2:E{"digest":"1234567890"}\n`), RSC, TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDaiPost(encoder.encode(`${head}\n2:E{"digest":"NEXT_REDIRECT;replace;/;307;"}\n`), RSC, TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDaiPost(encoder.encode(`${head}\n`), RSC, TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (event: Record<string, string>) => { event.eventdate = '2026-03-10T13:33:26+10:00'; },
      (event: Record<string, string>) => { event.eventdate = '10/03/2026 13:33'; },
      (event: Record<string, string>) => { event.description = ''; },
      (event: Record<string, string>) => { event.description = '$4'; },
    ]) {
      const changed = rewrite('in-transit', ([entry]) => { change((entry!.trackingevent as Record<string, string>[])[0]!); });
      expect(() => parseDaiPost(changed, RSC, TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('recognizes a known parcel and an unknown one, and leaves a failing lookup open', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(bytes('delivered')))
      .mockResolvedValueOnce(reply(bytes('not-found')))
      .mockResolvedValueOnce(reply('', { status: 500, type: 'text/plain' }));
    const direct = carrier(fetcher);
    await expect(direct.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-03T21:15:00.000Z' });
    await expect(direct.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(direct.recognize!(TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(direct.recognize!('AB12')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s from the tracking page as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('synthetic', { status, type: 'text/plain' }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(bytes('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new DaiPostTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ status: 'in_transit' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('rejects inputs that are no single tracking number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['AB12', 'NZCABCDEFGHI', `${DELIVERED},${UNKNOWN}`, `${DELIVERED}/x`, '9'.repeat(41)]) {
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
  });

  it('routes an NZC number to the adapter by detection', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(bytes('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dai-post', source: 'dai-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(DAI_POST_TRACK_URL))).toBe(true);
  });
});

describe('DAI Post status vocabulary', () => {
  it('records every code and wording with the stage the adapter gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(daiPostStage(entry.code ?? null), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(daiPostStage(null)).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'dai-post', providerCode: 'FD21', description: 'Parcel available for collection' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});

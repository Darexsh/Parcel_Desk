import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SamedayTracker } from './adapter.js';
import { normalizeSamedayNumber, parseSamedayHistory, parseSamedayReply } from './parser.js';
import { samedayStage, statusMap } from './status.js';

const AWB = '1EXA000000001';
const PARCEL = `${AWB}001`;
const OTHER = '1EXA000000002';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const parcelRows = (value: ReturnType<typeof fixture>) => value.parcelsList[PARCEL];
const NOT_FOUND = { error: { code: 404, message: 'Awb not found!' } };
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('Sameday history', () => {
  it("reads a single-parcel AWB from its parcel's scans, newest first, without private or transit details", () => {
    const result = normalizeCarrierResult(parseSamedayHistory(fixture(), AWB));
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The parcel has been successfully delivered.', last_update: '2026-01-07T16:54:30+02:00',
      delivered_at: '2026-01-07T16:54:30+02:00', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.events).toHaveLength(10);
    expect(result.events?.[0]).toEqual({ time: '2026-01-07T16:54:30+02:00', description: 'The parcel has been successfully delivered.',
      location: 'Southvale, Exampleland', provider_code: '5/9', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'out_for_delivery', 'in_transit',
      'in_transit', 'in_transit', 'accepted', 'registered', 'registered', 'registered']);
    // The redirection before the pickup keeps the registration's stage without a map of its own.
    expect(result.events?.[7]).toMatchObject({ provider_code: '24/141', stage: 'registered', stage_source: 'none' });
    expect(result.events?.at(-1)).toEqual({ time: '2026-01-05T09:12:40+02:00', description: 'We will pick up your parcel from the sender soon.',
      provider_code: '1/1', stage: 'registered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/Midtown|transitLocation|reason|createdBy|parcelAwbNumber|inReturn|easybox/);
  });

  it('binds a parcel number to its own scans and names the AWB', () => {
    const value = fixture();
    value.parcelsList[`${AWB}002`] = parcelRows(value).slice(0, 3).map((row: object) => ({ ...row, parcelAwbNumber: `${AWB}002` }));
    const result = parseSamedayHistory(value, PARCEL);
    expect(result).toMatchObject({ canonical_tracking_number: AWB, current_stage: 'delivered' });
    expect(result.events).toHaveLength(10);
    expect(parseSamedayHistory(value, `${AWB}002`)).toMatchObject({ canonical_tracking_number: AWB, current_stage: 'registered' });
  });

  it('reads the AWB history of a multi-parcel AWB, and the AWB return flag only for its current state', () => {
    const value = fixture();
    value.parcelsList[`${AWB}002`] = [];
    const result = parseSamedayHistory(value, AWB);
    expect(result.events).toHaveLength(10);
    expect(result.events?.[1]).toMatchObject({ time: '2026-01-06T15:00:13+02:00', provider_code: '18/78' });
    value.isReturn = true;
    const returned = parseSamedayHistory(value, AWB);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(returned).not.toHaveProperty('delivered_at');
    expect(returned.events?.[1]).toMatchObject({ stage: 'ready_for_pickup' });
  });

  it('falls back to the AWB history when its only parcel has no scans', () => {
    const value = fixture();
    value.parcelsList[PARCEL] = [];
    expect(parseSamedayHistory(value, AWB).events?.[1]).toMatchObject({ time: '2026-01-06T15:00:13+02:00' });
    expect(() => parseSamedayHistory(value, PARCEL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value.awbHistory = [];
    expect(() => parseSamedayHistory(value, AWB)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('never answers for another shipment or parcel', () => {
    const other = fixture(); other.awbNumber = OTHER;
    const stray = fixture(); parcelRows(stray)[3].parcelAwbNumber = `${OTHER}001`;
    for (const value of [other, stray]) {
      expect(() => parseSamedayHistory(value, AWB)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSamedayHistory(fixture(), `${AWB}002`)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('files the return leg under returned, and reads the return and refusal statuses under any state', () => {
    const value = fixture();
    const rows = parcelRows(value);
    for (const row of rows.slice(5)) row.inReturn = true;
    const result = parseSamedayHistory(value, AWB);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events?.slice(0, 5).map((event) => event.stage)).toEqual(Array(5).fill('returned'));
    expect(result.events?.[5]).toMatchObject({ stage: 'in_transit' });
    expect(samedayStage('5', '46', false, 'Synthetic', '')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(samedayStage('6', '74', false, 'Synthetic', '')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(samedayStage('10', '1', true, 'Synthetic', '')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
  });

  it('stages an unlisted state by its wording, and an instruction alone as pending', () => {
    const value = fixture();
    Object.assign(parcelRows(value).at(-1), { statusStateId: 99, statusId: 999, status: 'Synthetic note', statusState: 'The parcel has been delivered' });
    expect(parseSamedayHistory(value, AWB)).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language' });
    Object.assign(parcelRows(value).at(-1), { statusState: 'Synthetic state' });
    expect(parseSamedayHistory(value, AWB)).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'none' });
    const instruction = fixture();
    instruction.parcelsList[PARCEL] = [parcelRows(instruction)[2]];
    expect(parseSamedayHistory(instruction, AWB)).toMatchObject({ status: 'pending', current_stage: 'pending', current_stage_source: 'none' });
  });

  it('validates scans, drops exact duplicates and bounds the history', () => {
    for (const change of [{ statusDate: '2026-01-05T09:12:40' }, { statusDate: 'yesterday' }, { statusStateId: null },
      { statusId: 'A' }, { status: '', statusState: '' }]) {
      const value = fixture(); Object.assign(parcelRows(value)[0], change);
      expect(() => parseSamedayHistory(value, AWB), JSON.stringify(change)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [{ parcelsList: [] }, { awbHistory: null }, { awbNumber: '' }]) {
      expect(() => parseSamedayHistory({ ...fixture(), ...change }, AWB)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = fixture(); const rows = parcelRows(value);
    rows.splice(1, 0, { ...rows[0] });
    expect(parseSamedayHistory(value, AWB).events).toHaveLength(10);
    for (let index = 0; index < 110; index += 1) rows.unshift({ ...rows[0], status: `Synthetic scan ${index}` });
    expect(parseSamedayHistory(value, AWB).events).toHaveLength(100);
    value.parcelsList[PARCEL] = Array(501).fill(rows[0]);
    expect(() => parseSamedayHistory(value, AWB)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps equal clocks in the order the site lists them', () => {
    const value = fixture(); const rows = parcelRows(value);
    rows[1].statusDate = rows[0].statusDate;
    const result = parseSamedayHistory(value, AWB);
    expect(result.events?.slice(-2).map((event) => event.provider_code)).toEqual(['1/23', '1/1']);
  });

  it('tells a country that does not know the number from pages and errors', () => {
    expect(parseSamedayReply(404, JSON.stringify(NOT_FOUND), AWB)).toBeNull();
    expect(parseSamedayReply(200, JSON.stringify(fixture()), AWB)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseSamedayReply(404, '<html>Not Found</html>', AWB)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSamedayReply(404, '{"message":"No route"}', AWB)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSamedayReply(200, '<html><title>Just a moment...</title></html>', AWB)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSamedayReply(200, '<html>Maintenance</html>', AWB)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSamedayReply(200, '{"error":{"code":500}}', AWB)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSamedayReply(200, '[]', AWB)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts the numbers the site takes', () => {
    expect(normalizeSamedayNumber(' #1exa 000000001 ')).toBe(AWB);
    expect(normalizeSamedayNumber('12345')).toBe('12345');
    for (const number of ['1234', 'ABCDEFG', `${AWB}/../x`, `${AWB}?a=1`, '1'.repeat(29)]) {
      expect(() => normalizeSamedayNumber(number), number).toThrow(InvalidInputError);
    }
  });
});

describe('Sameday status map', () => {
  const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')).entries as
    { code: string; wording: string; stage?: string }[];

  it('stages every recorded state and status as statuses.json says', () => {
    for (const entry of statuses) {
      const [state, status = '0'] = entry.code.split('/');
      expect(samedayStage(state!, status, false, entry.wording, '')?.stage ?? null, entry.code).toBe(entry.stage ?? null);
    }
  });

  it('answers by the code alone only where the return flag cannot change the stage', () => {
    const answer = (providerCode: string, description: string) => statusMapAnswer({ carrier: 'sameday', providerCode, description });
    expect(answer('1/23', 'A courier will pick up the parcel from the sender soon.')).toEqual({ kind: 'mapped', stage: 'registered' });
    expect(answer('10/70', 'Synthetic failed attempt')).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(answer('5/46', 'Synthetic return')).toEqual({ kind: 'mapped', stage: 'returned' });
    expect(answer('5/9', 'The parcel has been successfully delivered.')).toEqual({ kind: 'unknown' });
    expect(answer('99/999', 'Synthetic scan')).toEqual({ kind: 'unknown' });
    expect(answer('24/141', 'The parcel was redirected.')).toMatchObject({ kind: 'intentional_gap' });
    for (const gap of statusMap.gaps) expect(statusMap.stage(gap.code!, normalizeStatusWording('Synthetic'))).toBeUndefined();
  });
});

describe('Sameday retrieval', () => {
  it('asks Romania first with one anonymous request, and recognizes a known parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fixture()));
    const instance = adapter(environment(fetcher));
    await expect(instance.recognize!('1234')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(AWB)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-07T14:54:30.000Z' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.sameday.ro/api/public/awb/${AWB}/awb-history?_locale=en`);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(init?.method ?? 'GET').toBe('GET');
    const headers = new Headers(init?.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.has('Cookie') || headers.has('Authorization')).toBe(false);
  });

  it('asks the next country when one does not know the number', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(NOT_FOUND, { status: 404 }))
      .mockResolvedValueOnce(Response.json(fixture()));
    await expect(new SamedayTracker({ fetcher }).fetch(AWB)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['api.sameday.ro', 'api.sameday.bg']);
  });

  it('reports a missing parcel only when every country says so', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(NOT_FOUND, { status: 404 }));
    await expect(new SamedayTracker({ fetcher }).fetch(AWB)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['api.sameday.ro', 'api.sameday.bg']);
    await expect(adapter(environment(fetcher)).recognize!(AWB)).resolves.toEqual({ known: false });
  });

  it.each([
    [403, 'Forbidden', 'challenge'], [429, 'Slow down', 'rate_limited'], [503, 'Unavailable', 'maintenance'],
    [500, 'Error', 'indeterminate'], [404, '<html>Not Found</html>', 'schema'], [200, '<html>Blocked</html>', 'challenge'],
  ])('keeps HTTP %s distinct from absence', async (status, body, kind) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(body, { status }))
      .mockImplementation(async () => Response.json(NOT_FOUND, { status: 404 }));
    await expect(new SamedayTracker({ fetcher }).fetch(AWB)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('still finds a parcel in another country after a failure', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(Response.json(fixture()));
    await expect(new SamedayTracker({ fetcher }).fetch(PARCEL)).resolves.toMatchObject({ canonical_tracking_number: AWB });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`https://api.sameday.bg/api/public/awb/${PARCEL}/awb-history?_locale=en`);
  });

  it('rejects invalid inputs before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['1234', 'ABCDEFG', `${AWB}/x`]) {
      await expect(new SamedayTracker({ fetcher: unused }).fetch(number)).rejects.toThrow(InvalidInputError);
    }
    await expect(new SamedayTracker({ fetcher: unused }).fetch(AWB, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted(); return new Response('{}');
    });
    await expect(new SamedayTracker({ fetcher: slow }).fetch(AWB, { budgetMs: 20.5 })).rejects.toThrow();
    expect(slow).toHaveBeenCalledOnce();
    const huge = vi.fn<typeof fetch>().mockImplementation(async () => new Response('x'.repeat(2_000_001)));
    await expect(new SamedayTracker({ fetcher: huge }).fetch(AWB)).rejects.toThrow('unexpectedly large');
  });
});

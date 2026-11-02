import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GATI_TOKEN_URL, GATI_TRACKING_URL, GatiTracker } from './adapter.js';
import { normalizeGatiNumber, parseGati } from './parser.js';
import { gatiStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000001';
const IN_TRANSIT = '200000002';
const UNKNOWN = '400000004';
const TOKEN = '1000|SyntheticPageToken0000000000000000000000000';

type Detail = { [key: string]: unknown; TRANSIT_DTLS: Record<string, unknown>[] };
interface Reply { success: boolean; data: { result: string; details: Detail[] } }

const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
// The fixture's one docket, edited.
const edited = (name: string, edit: (detail: Detail) => void) => {
  const reply = fixture(name);
  edit(reply.data.details[0]!);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const grant = () => json({ token: TOKEN, expires_in: 300, type: 'Bearer' });
// The site's token, then the lookup's reply.
const replies = (...lookups: Response[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const reply of lookups) fetcher.mockResolvedValueOnce(grant()).mockResolvedValueOnce(reply);
  return fetcher;
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// What the site relays when the tracking service behind it does not answer in time.
const SERVICE_TIMEOUT = { success: false, error: 'cURL error 28: Operation timed out after 30002 milliseconds with 0 bytes received', status_code: 500 };
// What the site answers a docket number it refuses before asking the tracking service.
const REFUSED = { success: false, message: 'Validation failed', errors: { docketNo: ['Each docket number must be 9 digits long'] } };

describe('AllcargoGATI HTTP adapter', () => {
  it('gets a page token, then looks the whole docket number up with it, through the supplied transport', async () => {
    const fetcher = replies(json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GatiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 200-000-002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[tokenUrl, tokenInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(tokenUrl).toBe(GATI_TOKEN_URL);
    expect(tokenUrl).toBe('https://admin.allcargologistics.com/api/frontend/token');
    expect(tokenInit).toMatchObject({ method: 'POST', body: '{}', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', Origin: 'https://www.allcargologistics.com' } });
    expect(url).toBe(GATI_TRACKING_URL);
    expect(url).toBe('https://admin.allcargologistics.com/api/track-shipment');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ docketNo: IN_TRANSIT }), redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`,
        Origin: 'https://www.allcargologistics.com', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gati', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Indian wall clocks at UTC+5:30 and stages each scan by its milestone code, newest first', () => {
    const result = parseGati(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-09-09T10:35:00Z', delivered_at: '2026-09-09T10:35:41Z',
      expected_delivery: null, weight_kg: 42, timezone: 'Asia/Kolkata' });
    expect(result.events!.map((event) => [event.time, event.location, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-09-09T10:35:00Z', 'Southganj', 'DDLVD', 'delivered', 'Delivered'],
      ['2026-09-09T03:42:00Z', 'Southganj', 'DPDCC', 'out_for_delivery', 'Out For Delivery'],
      ['2026-09-08T13:10:00Z', 'Southganj', 'DUNDL', 'failed_attempt', 'Undelivered Due To Consignee Premises Closed'],
      ['2026-09-08T04:32:00Z', 'Southganj', 'DPDCC', 'out_for_delivery', 'Out For Delivery'],
      // The repeated arrival is kept once.
      ['2026-09-07T15:45:00Z', 'Southganj', 'DKTAD', 'in_transit', 'Arrived At Destination'],
      ['2026-09-05T22:00:00Z', 'Midvale Stc', 'TCSEO', 'in_transit', 'Out For Next Location Southganj'],
      ['2026-09-05T09:18:00Z', 'Midvale Stc', 'TCAER', 'in_transit', 'Received At Midvale Stc'],
      ['2026-09-02T18:50:00Z', 'Northpur', 'TCSOU', 'in_transit', 'Departed From Origin'],
      ['2026-09-02T09:30:00Z', 'Northpur', 'DCRE', 'accepted', 'Shipment Booked'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time)).toBe(true);
  });

  it('keeps no consignor, consignee, receiver, remark, reference or proof of delivery link', () => {
    const text = JSON.stringify(parseGati(fixture('delivered'), DELIVERED));
    expect(text).not.toMatch(/SAMPLE|Asha|Ravi|neighbour|good condition|viewPOD|gati\.com|NORTHPUR|SOUTHGANJ|SUR EXPRESS|10000001"/);
  });

  it('reads a docket on its way with the delivery date promised at booking, or its revision', () => {
    const result = parseGati(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      expected_delivery: '2026-10-17' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(parseGati(edited('in-transit', (detail) => { detail.revisedAssuredDeliveryDate = '19-OCT-2026'; }), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-10-19' });
    // A date in another form is left out.
    expect(parseGati(edited('in-transit', (detail) => { detail.assuredDlyDate = '2026-10-17'; }), IN_TRANSIT))
      .toMatchObject({ expected_delivery: null });
  });

  it('takes the docket’s delivered status over a later scan, and the delivery scan’s clock without a delivery time', () => {
    const detained = edited('delivered', (detail) => {
      detail.TRANSIT_DTLS.unshift({ intransitDate: '30-SEP-2026', intransitTime: '11:00', intransitLocation: 'Southganj',
        intransitStatus: 'Docket Detained For', milestonecode: 'DDETN', milestonestatus: 'N' });
      detail.DeliveryDt = '';
    });
    expect(parseGati(detained, DELIVERED)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Docket Detained For', delivered_at: '2026-09-09T10:35:00Z' });
    // Without the docket's status, the newest staged scan gives the stage.
    expect(parseGati(edited('delivered', (detail) => { detail.docketStatus = ''; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered', delivered_at: '2026-09-09T10:35:41Z' });
  });

  it('keeps an unknown code without a stage and reads a history listed oldest first', () => {
    const unknown = parseGati(edited('in-transit', (detail) => { detail.TRANSIT_DTLS[0]!.milestonecode = 'ZZZZZ'; detail.TRANSIT_DTLS[0]!.intransitStatus = 'Sample Note'; }), IN_TRANSIT);
    expect(unknown.events![0]).toMatchObject({ provider_code: 'ZZZZZ', description: 'Sample Note' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample Note' });
    expect(gatiStage('ZZZZZ', 'Sample Note')).toBeNull();
    const reversed = parseGati(edited('delivered', (detail) => { detail.TRANSIT_DTLS.reverse(); }), DELIVERED);
    expect(reversed.events![0]).toMatchObject({ provider_code: 'DDLVD' });
    expect(reversed.events!.at(-1)).toMatchObject({ provider_code: 'DCRE' });
  });

  it('reads the tracking service’s own answer for an unknown docket as not found, and a docket without scans as no history', () => {
    expect(() => parseGati(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGati(edited('in-transit', (detail) => { detail.TRANSIT_DTLS = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseGati(edited('in-transit', (detail) => { Reflect.deleteProperty(detail, 'TRANSIT_DTLS'); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a docket only when the reply names the number asked', () => {
    expect(() => parseGati(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'AllcargoGATI answered for another docket' }));
    expect(() => parseGati(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'AllcargoGATI answered for another docket' }));
    expect(() => parseGati(edited('in-transit', (detail) => { detail.docketNumber = '200000003'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseGati(edited('in-transit', (detail) => { detail.dktno = 200000002; }), IN_TRANSIT).events!.length).toBeGreaterThan(0);
    for (const dktno of [200000002.5, '2000000021', { value: IN_TRANSIT }]) {
      expect(() => parseGati(edited('in-transit', (detail) => { detail.dktno = dktno; }), IN_TRANSIT), String(dktno)).toThrow();
    }
  });

  it('keeps a failed tracking service, a refused number and a changed reply apart from a missing docket', () => {
    expect(() => parseGati(SERVICE_TIMEOUT, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGati(REFUSED, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseGati(edited('not-found', (detail) => { detail.errmsg = 'Service unavailable'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const failed = fixture('in-transit');
    failed.data.result = 'failed';
    expect(() => parseGati(failed, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    const twice = fixture('in-transit');
    twice.data.details.push(twice.data.details[0]!);
    for (const reply of [
      null, [], { success: true }, { success: 'yes', data: fixture('in-transit').data }, { status: 'error', message: 'Sample' },
      { success: true, data: { result: 'successful', details: [] } }, twice,
      edited('in-transit', (detail) => { delete detail.dktno; }),
      edited('in-transit', (detail) => { detail.result = 'partial'; }),
      edited('in-transit', (detail) => { detail.TRANSIT_DTLS = {} as never; }),
      edited('in-transit', (detail) => { detail.TRANSIT_DTLS[0] = 'scan' as never; }),
      edited('in-transit', (detail) => { detail.TRANSIT_DTLS[0]!.intransitStatus = ''; }),
      edited('in-transit', (detail) => { detail.TRANSIT_DTLS[0]!.intransitStatus = { text: 'Sample' }; }),
      edited('in-transit', (detail) => { detail.TRANSIT_DTLS[0]!.intransitTime = '24:00'; }),
      edited('in-transit', (detail) => { detail.TRANSIT_DTLS[0]!.intransitDate = '31-SEP-2026'; }),
      edited('in-transit', (detail) => { detail.TRANSIT_DTLS[0]!.intransitDate = '2026-10-14'; }),
      edited('in-transit', (detail) => { detail.TRANSIT_DTLS = Array.from({ length: 501 }, () => detail.TRANSIT_DTLS[0]!); }),
    ]) {
      expect(() => parseGati(reply, IN_TRANSIT), JSON.stringify(reply)?.slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown docket, a refused number, a failed service, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (reply: Response) => carrier(replies(reply)).track({ number: UNKNOWN });
    await expect(lookup(json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(json(REFUSED, { status: 422 }))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup(json(SERVICE_TIMEOUT))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(json(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 302, headers: { Location: 'https://www.allcargologistics.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // The token was just issued, so a refusal of it or of the origin is a changed gate.
    await expect(lookup(json({ status: 'error', message: 'Invalid frontend token' }, { status: 401 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(json({ status: 'error', message: 'Invalid request origin' }, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>Allcargo</title></html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('needs a bearer page token before it looks anything up', async () => {
    for (const reply of [json({ token: '', type: 'Bearer' }), json({ token: TOKEN, type: 'Basic' }), json({ message: 'Sample' }), json('<html></html>')]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply);
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'schema' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const moved = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(carrier(moved).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without the token', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === GATI_TOKEN_URL ? grant() : new Response('', { status }));
      const error = await carrier(fetcher).track({ number: IN_TRANSIT }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind, status });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
      expect((error as { request?: unknown }).request).toBeUndefined();
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

  it.each([[429, 'rate_limited'], [403, 'challenge'], [500, 'indeterminate']] as const)('preserves HTTP %s on the token as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recognizes a known docket with its last scan and the unknown-docket answer, and asks nothing for a number Gati does not issue', async () => {
    const fetcher = replies(json(fixture('delivered')), json(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T10:35:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('10000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects numbers Gati does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['10000000', '1000000010', 'A00000001', '100000001,200000002', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGatiNumber('100-000-001')).toBe(DELIVERED);
    expect(normalizeGatiNumber(' 100 000 001 ')).toBe(DELIVERED);
  });

  it('ends a hanging lookup inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(grant()).mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.slice(1).every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under AllcargoGATI to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === GATI_TOKEN_URL ? grant() : json(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: '100 000 001', carrier: 'gati' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'gati', source: 'gati', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === GATI_TRACKING_URL && init?.body === JSON.stringify({ docketNo: DELIVERED }))).toBe(true);
  });

  it('leaves docket numbers to the caller: no rule claims nine digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) expect(detectCarrierMatch(number).carrier, number).not.toBe('gati');
  });
});

describe('AllcargoGATI status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(gatiStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'gati', providerCode: 'DPDCC', description: 'Out For Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'gati', providerCode: 'ZZZZZ', description: 'Sample Note' })).toEqual({ kind: 'unknown' });
  });
});

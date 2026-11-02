import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JneTracker, JNE_LOGIN, JNE_LOOKUP } from './adapter.js';
import { jneScan, normalizeJneNumber, parseJne } from './parser.js';
import { jneMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'JT12345078902';
const IN_TRANSIT = '100200300400500';
const UNKNOWN = 'JT99999999999';

type Row = Record<string, unknown>;
type Reply = Row & { cnote: Row; history: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });

const loginOk = () => reply({ status: '00', token: 'guest-token' });
/** A fetcher that answers the guest login, then the lookup with the given body. */
function fetcherFor(lookup: () => Response, login: () => Response = loginOk) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === JNE_LOGIN) return login();
    if (url === JNE_LOOKUP) return lookup();
    throw new Error(`unexpected request ${url}`);
  });
}
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookupBody = (body: unknown, init?: ResponseInit) => carrier(fetcherFor(() => reply(body, init))).track({ number: UNKNOWN });

describe('JNE HTTP adapter', () => {
  it('mints a guest token, then posts the number and the app client to the lookup', async () => {
    const fetcher = fetcherFor(() => reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JneTracker({ fetcher, recorder }).fetch(' jt1234-5078902 ', { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [loginUrl, loginInit] = fetcher.mock.calls[0]!;
    expect(String(loginUrl)).toBe(JNE_LOGIN);
    expect(loginInit).toMatchObject({ method: 'POST', body: '{}', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'okhttp/4.12.0' } });
    const [lookupUrl, lookupInit] = fetcher.mock.calls[1]!;
    expect(String(lookupUrl)).toBe(JNE_LOOKUP);
    expect(lookupInit).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'okhttp/4.12.0', 'access-token': 'guest-token' } });
    expect(JSON.parse(String(lookupInit!.body))).toEqual({ code: DELIVERED, clientcode: 'JN3XRUP1' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jne', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock, stages it by its phrase and drops the recipient', () => {
    const result = parseJne(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED TO', last_update: null, last_update_local: '2026-02-12T14:03:00', expected_delivery: null,
      weight_kg: 2.5 });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.location ?? null, event.description])).toEqual([
      ['2026-02-12T14:03:00', 'delivered', 'DENPASAR', 'DELIVERED TO'],
      ['2026-02-12T08:10:00', 'out_for_delivery', 'DENPASAR, DROP POINT SAMPLE', 'WITH DELIVERY COURIER'],
      // The repeated warehouse scan is kept once.
      ['2026-02-11T06:20:00', 'in_transit', 'DENPASAR, HUB BALI', 'RECEIVED AT WAREHOUSE'],
      ['2026-02-10T10:02:00', 'in_transit', 'SURABAYA, OTB SAMPLE', 'PROCESS AND FORWARD TO'],
      ['2026-02-10T09:40:00', 'in_transit', 'SURABAYA, OTB SAMPLE', 'RECEIVED AT SORTING CENTER'],
      ['2026-02-10T09:15:00', 'accepted', 'SURABAYA, AGEN SAMPLE', 'SHIPMENT RECEIVED AT'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source)).toBe(true);
    // No recipient, shipper, proof of delivery, goods or price survives.
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|32000|sig\.jpg|pod\.jpg|BERSANGKUTAN|SAMPLE GOODS/i);
  });

  it('reads an in-transit history under a fifteen-digit resi', () => {
    const result = parseJne(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'RECEIVED AT WAREHOUSE', last_update: null, last_update_local: '2026-03-02T20:45:00', weight_kg: 1.2 });
    expect(result.events!.at(-1)).toMatchObject({ stage: 'accepted', description: 'SHIPMENT RECEIVED BY JNE COUNTER OFFICER AT' });
    expect(result.events).toHaveLength(4);
  });

  it('splits a scan into its phrase and its station, dropping the delivery recipient', () => {
    expect(jneScan('WITH DELIVERY COURIER [BOGOR, DROP POINT SAMPLE] [BOGOR, DROP POINT SAMPLE]'))
      .toEqual({ wording: 'WITH DELIVERY COURIER', location: 'BOGOR, DROP POINT SAMPLE' });
    // The second bracket can be empty; the last non-empty station is kept.
    expect(jneScan('SHIPMENT PICKED UP BY JNE COURIER [TANGERANG] []'))
      .toEqual({ wording: 'SHIPMENT PICKED UP BY JNE COURIER', location: 'TANGERANG' });
    // A delivery bracket is recipient, date and city; only the city stays.
    expect(jneScan('DELIVERED TO [BUDI SAMPLE:} | 12-02-2026 14:03 | DENPASAR ]'))
      .toEqual({ wording: 'DELIVERED TO', location: 'DENPASAR' });
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const result = parseJne(changed('in-transit', (body) => { body.history[2]!.date = '01-03-2026 15:30'; }), IN_TRANSIT);
    expect(result.events!.map((event) => [event.local_time, event.description])).toEqual([
      ['2026-03-02T20:45:00', 'RECEIVED AT WAREHOUSE'], ['2026-03-01T15:30:00', 'DEPARTED FROM TRANSIT'],
      ['2026-03-01T15:30:00', 'RECEIVED AT SORTING CENTER'], ['2026-03-01T13:00:00', 'SHIPMENT RECEIVED BY JNE COUNTER OFFICER AT'],
    ]);
  });

  it('reorders a history given newest first', () => {
    const result = parseJne(changed('in-transit', (body) => { body.history.reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update_local: '2026-03-02T20:45:00', current_stage: 'in_transit' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'SHIPMENT RECEIVED BY JNE COUNTER OFFICER AT' });
  });

  it('reads an unknown number as not found and a record without scans as no history', () => {
    expect(() => parseJne(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJne(changed('delivered', (body) => { body.history = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it echoes the number asked', () => {
    expect(() => parseJne(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseJne(changed('delivered', (body) => { body.cnote.cnote_no = DELIVERED.toLowerCase(); }), DELIVERED).events)
      .toHaveLength(6);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { body.status = '00'; delete (body as Row).cnote; },
      (body: Reply) => { body.cnote = 'cnote' as never; },
      (body: Reply) => { body.status = 7; },
      (body: Reply) => { body.history = 'history' as never; },
      (body: Reply) => { body.history = Array.from({ length: 501 }, () => body.history[0]!); },
      (body: Reply) => { body.history[0] = 'scan' as never; },
      (body: Reply) => { body.history[0]!.date = '2026-02-12 14:03'; },
      (body: Reply) => { body.history[0]!.date = '32-02-2026 14:03'; },
      (body: Reply) => { body.history[0]!.desc = ['DELIVERED TO']; },
      (body: Reply) => { body.history[0]!.desc = '[DENPASAR]'; },
    ]) {
      expect(() => parseJne(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refusal, a browser check, a token reset and a broken reply apart', async () => {
    await expect(lookupBody(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookupBody('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookupBody('', { status: 401 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookupBody('', { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookupBody('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookupBody('<html><title>JNE</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    // An expired guest token is a transient the next read's fresh token fixes.
    await expect(lookupBody({ status: '77', message: 'invalid token' })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('reads a refused or rate-limited guest login', async () => {
    await expect(carrier(fetcherFor(() => reply(fixture('delivered')), () => reply('', { status: 429 }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(fetcherFor(() => reply(fixture('delivered')), () => reply('', { status: 403 }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcherFor(() => reply(fixture('delivered')), () => reply({ status: '99' }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('preserves a rate limit during retrieval', async () => {
    await expect(lookupBody('', { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('rejects numbers JNE does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JT1234567890', 'JT123456789012', '12345678901234', '12345678901234567', 'SAMPLETRACKING']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJneNumber(' jt1234-5078902 ')).toBe(DELIVERED);
  });

  it('routes a JT number detected as JNE to the adapter', async () => {
    const fetcher = fetcherFor(() => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jne', source: 'jne', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === JNE_LOOKUP)).toBe(true);
  });
});

describe('JNE numbers', () => {
  it('claims JT consignments at high confidence', () => {
    expect(detectCarrierMatch('JT12345078902')).toMatchObject({ carrier: 'jne', confidence: 'high' });
  });
});

describe('JNE status vocabulary', () => {
  it('stages every wording recorded for the carrier', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(jneMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'jne', providerCode: '', description: 'WITH DELIVERY COURIER' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'jne', providerCode: '', description: 'SYNTHETIC NOTE' })).toEqual({ kind: 'unknown' });
    expect(jneMappedStage('SYNTHETIC NOTE')).toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ECONT_AUTHORIZE_URL, ECONT_TRACE_URL, EcontTracker } from './adapter.js';
import { parseEcont } from './parser.js';
import { econtScan, econtSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9000000000001';
const READY = '9000000000002';
const PREPARED = '9000000000003';
const UNKNOWN = '9000000000009';
const TOKEN = '00000000-0000-4000-8000-000000000001';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const grant = (token = TOKEN) => new Response(null, { status: 302, headers: {
  Location: `https://www.econt.com/trace/oauth/process-token.html#access_token=${token}&token_type=bearer&expires_in=3599&scope=read%20write` } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
type Track = { trace: { time: string; event: string | null; isReceipt?: boolean }[]; storage: string | null; shortDeliveryStatus: string | null };
const track = (payload: unknown) => (payload as { tracks: [Track] }).tracks[0];

/** A transport that grants a session and answers the trace service with the given replies in turn. */
function econt(...replies: (() => Response)[]) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input) === ECONT_AUTHORIZE_URL) return grant();
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    return next();
  });
}

describe('Econt HTTP adapter', () => {
  it('opens a guest session once and posts the whole number with it', async () => {
    const fetcher = econt(() => json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new EcontTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 9000 0000 00001 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([ECONT_AUTHORIZE_URL, ECONT_TRACE_URL, ECONT_TRACE_URL]);
    const [, authorize] = fetcher.mock.calls[0]!;
    expect(authorize).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    const [, trace] = fetcher.mock.calls[1]!;
    expect(trace).toMatchObject({ method: 'POST', body: JSON.stringify({ waybillNumber: [DELIVERED], source: 'external' }),
      signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'econt', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(2);
  });

  it('reads a delivered shipment newest first in Sofia time, without people, receipts or order numbers', () => {
    const result = parseEcont(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-05T12:00:00+02:00', delivered_at: '2026-03-04T11:45:00+02:00',
      timezone: 'Europe/Sofia' });
    expect(result.pickup_point).toBeUndefined();
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage ?? null, event.description, event.location ?? null])).toEqual([
      ['2026-03-05T12:00:00+02:00', 'receipt', null, 'Return receipt: Delivered', null],
      ['2026-03-04T11:45:00+02:00', 'client', 'delivered', 'Delivered', null],
      ['2026-03-04T09:00:00+02:00', 'courier', 'out_for_delivery', 'Submitted to courier', null],
      ['2026-03-03T17:20:00+02:00', 'failed_delivery', 'failed_attempt', 'Failed delivery (Absent receiver)', 'Obraztsovo Iztok'],
      ['2026-03-03T10:00:00+02:00', 'instruction', null, 'Change delivery terms: change of delivery address', null],
      ['2026-03-03T08:15:00+02:00', 'courier', 'out_for_delivery', 'Submitted to courier', null],
      ['2026-03-03T02:40:00+02:00', 'office', 'in_transit', 'Arrival at an office', 'Obraztsovo LC'],
      ['2026-03-02T18:30:00+02:00', 'courier_direction', 'in_transit', 'Received by line-haul: Primergrad - Obraztsovo', null],
      ['2026-03-02T16:05:00+02:00', 'office', 'in_transit', 'Arrival at an office', 'Primergrad Tsentar'],
      ['2026-03-02T15:10:00+02:00', 'courier', 'accepted', 'Submitted to courier', null],
    ]);
    const kept = JSON.stringify(result);
    for (const dropped of ['Synthetic Recipient', 'Example Shop', 'Primeren', 'Drug Kurier', 'Куриер', '260303000001', 'Отсъствие']) {
      expect(kept).not.toContain(dropped);
    }
  });

  it('names the storing office as the pickup point in summer time, only when one of its scans names it', () => {
    const ready = parseEcont(fixture('ready'), READY);
    expect(ready).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'At office',
      pickup_point: 'Obraztsovo - Primerna', last_update: '2026-07-09T03:10:00+03:00' });
    const elsewhere = fixture('ready');
    track(elsewhere).storage = 'Друг офис';
    const moving = parseEcont(elsewhere, READY);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(moving.pickup_point).toBeUndefined();
  });

  it('reads a printed label as registered, and a found shipment without scans as a summary', () => {
    expect(parseEcont(fixture('prepared'), PREPARED)).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'Awaiting delivery to Econt', events: [{ time: '2026-10-05T10:30:00+03:00', provider_code: 'prepared',
        stage: 'registered', description: 'Awaiting delivery to Econt' }] });
    const empty = fixture('prepared');
    track(empty).trace = [];
    expect(parseEcont(empty, PREPARED)).toMatchObject({ status: 'pending', current_stage: 'registered', summary_only: true, events: [] });
    const unknown = fixture('ready');
    track(unknown).shortDeliveryStatus = 'Нов статус';
    track(unknown).trace.push({ event: 'weighed', time: '2026-07-09 04:00:00' });
    const unmapped = parseEcont(unknown, READY);
    expect(unmapped).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'At office' });
    expect(unmapped.events![0]).toEqual({ time: '2026-07-09T04:00:00+03:00', provider_code: 'weighed', description: 'weighed' });
  });

  it('keeps a clock the autumn change repeats or the spring change skips as Sofia local time', () => {
    const payload = fixture('prepared');
    track(payload).trace = [
      { event: 'office', time: '2026-03-29 03:30:00' },
      { event: 'office', time: '2026-10-25 03:30:00' },
      { event: 'office', time: '2026-10-25 04:30:00' },
    ];
    expect(parseEcont(payload, PREPARED).events!.map(event => event.time ?? event.local_time)).toEqual([
      '2026-10-25T04:30:00+02:00', '2026-10-25T03:30:00', '2026-03-29T03:30:00',
    ]);
  });

  it('binds the reply to the whole requested number and rejects malformed replies', () => {
    expect(() => parseEcont(fixture('delivered'), '9000000000008')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = fixture('delivered') as { tracks: unknown[] };
    twice.tracks.push(twice.tracks[0]);
    expect(() => parseEcont(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const undated = fixture('delivered');
    track(undated).trace[1]!.time = '02.03.2026 16:05';
    expect(() => parseEcont(undated, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const unflagged = fixture('delivered') as { tracks: [Record<string, unknown>] };
    delete unflagged.tracks[0].isFound;
    expect(() => parseEcont(unflagged, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcont({ status: 'ok', tracks: {} }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcont({ status: 'error', tracks: [] }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const unknown = fixture('not-found') as { tracks: [{ waybillNumber: number }] };
    expect(() => parseEcont(unknown, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    unknown.tracks[0].waybillNumber = 9000000000008;
    expect(() => parseEcont(unknown, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('recognizes a known shipment and the not-found flag without a browser or recipient inputs', async () => {
    const fetcher = econt(() => json(text('delivered')), () => json(text('not-found')));
    const direct = carrier(fetcher);
    await expect(direct.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T10:00:00.000Z' });
    await expect(direct.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(direct.recognize!('900000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(carrier(econt(() => json(text('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('opens a new session once when the trace service rejects the token', async () => {
    const fetcher = econt(() => json('{"error":"invalid_token"}', 401), () => json(text('ready')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new EcontTracker({ fetcher, recorder }).fetch(READY)).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([ECONT_AUTHORIZE_URL, ECONT_TRACE_URL, ECONT_AUTHORIZE_URL, ECONT_TRACE_URL]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'refresh', outcome: 'ok' }));
    const refused = econt(() => json('{"error":"invalid_token"}', 401));
    await expect(carrier(refused).track({ number: READY })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(refused).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the trace service as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = econt(() => json('{"status":500,"error":"Internal Server Error"}', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('keeps firewall pages, refused sessions and malformed replies apart from missing shipments', async () => {
    const page = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>';
    for (const [body, kind] of [[page, 'challenge'], ['<html>Maintenance</html>', 'schema'], ['{"tracks":[]}', 'schema']]) {
      await expect(carrier(econt(() => new Response(body))).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    }
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(new Response(page));
    await expect(carrier(blocked).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    const login = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://login.econt.com/oauth2/' } }));
    await expect(carrier(login).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('rejects numbers Econt does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['900000000001', '90000000000011', '0900000000001', 'EC9000000001']) {
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

  it('routes a shipment filed under Econt to the adapter', async () => {
    const fetcher = econt(() => json(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'econt' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'econt', source: 'econt', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => [ECONT_AUTHORIZE_URL, ECONT_TRACE_URL].includes(String(url)))).toBe(true);
  });
});

describe('Econt status vocabulary', () => {
  it('records every scan code and summary status with the wording and stage the adapter gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      const { code, stage } = entry;
      if (code !== undefined && code !== 'receipt') {
        expect(econtScan(code)).toEqual({ wording: entry.wording, ...(stage ? { stage } : {}) });
        expect(statusMap.stage(code, entry.wording.toLowerCase())).toBe(stage);
      } else if (code === undefined) {
        expect(econtSummaryStage(entry.wording, true), entry.wording).toBe(stage);
      }
    }
    expect(econtSummaryStage('В офис', false)).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'econt', providerCode: 'client', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    for (const code of ['courier', 'instruction', 'info', 'receipt']) {
      expect(statusMapAnswer({ carrier: 'econt', providerCode: code, description: 'Any wording' }), code).toMatchObject({ kind: 'intentional_gap' });
    }
  });
});

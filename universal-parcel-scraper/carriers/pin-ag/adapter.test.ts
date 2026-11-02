import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PIN_AG_ENDPOINT, PinAgTracker } from './adapter.js';
import { normalizePinAgNumber, parsePinAg } from './parser.js';
import { pinAgStatus, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = '0100000000000001';
const LETTER = '1000000000001';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(name));
const json = 'application/json; charset=utf-8';
const reply = (name: string) => new Response(text(name), { status: 200, headers: { 'Content-Type': json } });
const refusal = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message, status } }), { status, headers: { 'Content-Type': json } });
const unknown = () => refusal(404, 'Für Ihre Sendungsnummer konnte kein Zustellstatus gefunden werden');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (payload: Record<string, unknown>) => payload.statuses as Record<string, unknown>[];

describe('PIN AG HTTP adapter', () => {
  it('asks the tracking service once for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PinAgTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0100 0000 0000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://sendungsverfolgung.pin-ag.de/api2/tracking?sendung=${PARCEL}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pin-ag', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('asks for a thirteen-digit number without the brackets its label prints', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    await expect(carrier(fetcher).track({ number: '100000000000(1)' })).resolves.toMatchObject({ status: 'delivered' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${PIN_AG_ENDPOINT}?sendung=${LETTER}`);
  });

  it('reads a delivered parcel newest first on Berlin wall clocks, without any address or customer number', () => {
    const result = parsePinAg(fixture('delivered'), PARCEL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Die Sendung wurde zugestellt.',
      last_update: null, last_update_local: '2026-07-31T10:55:46' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-07-31T10:55:46', '990323', 'delivered', 'Die Sendung wurde zugestellt.'],
      ['2026-07-31T07:02:44', '990300', 'out_for_delivery', 'Die Sendung ist in Zustellung.'],
      ['2026-07-31T05:40:10', '990200', 'in_transit', 'Die Sendung ist im Zustelldepot eingetroffen.'],
      ['2026-07-30T18:12:03', '990100', 'in_transit', 'Die Sendung wurde im Sortierzentrum bearbeitet.'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|00000|0000000/);
  });

  it('reads an item PIN cannot deliver as an exception, worded by its description when the label is empty', () => {
    expect(parsePinAg(fixture('undeliverable'), PARCEL)).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Die Sendung konnte nicht zugestellt werden.', last_update_local: '2026-08-04T11:30:00' });
  });

  it('reads an item PIN delivers without tracking it further as in transit, though the page files it under In Zustellung', () => {
    const payload = fixture('delivered');
    const untracked = { ...rows(payload)[0]!, statusCode: 'NON_FURTHER_TRACKABLE', stage: 'In Zustellung', label: 'Synthetic: recorded at the sorting center, delivered without further updates.' };
    (payload as { statuses: unknown[] }).statuses = [untracked];
    const result = parsePinAg(payload, PARCEL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(result.events![0]).toMatchObject({ provider_code: 'NON_FURTHER_TRACKABLE', stage: 'in_transit' });
  });

  it('reads an item waiting at the depot, whose address the page shows, as ready for pickup', () => {
    const payload = fixture('delivered');
    const waiting = { ...rows(payload)[1]!, statusCode: '990302', label: 'Synthetic: waiting at the depot for collection.' };
    (payload as { statuses: unknown[] }).statuses = [rows(payload)[0]!, rows(payload)[1]!, waiting];
    const result = parsePinAg(payload, PARCEL);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(result.events![0]).toMatchObject({ provider_code: '990302', stage: 'ready_for_pickup' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  });

  it('keeps a step the map does not know, and a clock it cannot read, visible without a stage', () => {
    const payload = fixture('delivered');
    Object.assign(rows(payload)[4]!, { stage: 'Abholbereit', timeStamp: '31.07.2026 10:55' });
    const result = parsePinAg(payload, PARCEL);
    expect(result).toMatchObject({ status: 'unknown', last_update_local: null });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ description: 'Die Sendung wurde zugestellt.', provider_code: '990323', provider_time_text: '31.07.2026 10:55' });
  });

  it('rejects a changed reply and keeps an empty list apart from a missing parcel', () => {
    for (const change of [
      (payload: Record<string, unknown>) => { payload.statuses = {}; },
      (payload: Record<string, unknown>) => { (payload.statuses as unknown[])[1] = 'Zustelldepot'; },
      (payload: Record<string, unknown>) => { Object.assign(rows(payload)[1]!, { statusCode: null }); },
      (payload: Record<string, unknown>) => { Object.assign(rows(payload)[1]!, { label: { text: 'Zustelldepot' } }); },
      (payload: Record<string, unknown>) => { Object.assign(rows(payload)[1]!, { label: '', statusDescription: '', stage: '' }); },
    ]) {
      const payload = fixture('delivered');
      change(payload);
      expect(() => parsePinAg(payload, PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePinAg({ statuses: [] }, PARCEL)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parsePinAg({ statuses: [{ statusCode: 'NOT_FOUND_HINT' }] }, PARCEL)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('keeps an unknown number, an item type PIN does not track and other refusals apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: PARCEL });
    await expect(lookup(unknown())).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(refusal(405, 'Für diese Sendungsart ist keine Sendungsverfolgung möglich')))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'tracking_withheld' });
    await expect(lookup(refusal(404, 'Seite nicht gefunden'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response('<html>Not found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response(null, { status: 405 }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(PARCEL)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps blocked HTTP 200 pages and malformed replies apart from missing parcels', async () => {
    for (const body of ['<html><title>Wartung</title></html>', '{"items":[]}']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).recognize!(PARCEL)).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('recognizes a known parcel by its day and the unknown-number answer, and asks nothing for a number PIN does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('delivered')).mockResolvedValueOnce(unknown());
    await expect(carrier(fetcher).recognize!(PARCEL)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-07-31T10:55:46' });
    await expect(carrier(fetcher).recognize!(PARCEL)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('01000000000000012')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers PIN does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['010000000000001', '01000000000000012', '100000000001', 'PIN0000000000001', '0100-0000-0000-000X']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePinAgNumber('0100-0000-0000-0001')).toBe(PARCEL);
  });

  it('sends a read that failed to reach PIN once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply('delivered'));
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under PIN AG to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARCEL, carrier: 'pin-ag' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'pin-ag', source: 'pin-ag', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${PIN_AG_ENDPOINT}?sendung=${PARCEL}`)).toBe(true);
  });
});

describe('PIN AG status vocabulary', () => {
  it('records every code the map knows with the stage of the step it came with', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, (entry.wording ?? '').toLowerCase())).toBe(entry.stage);
      expect(pinAgStatus(entry.note.match(/Filed under the (.+?) step/)?.[1] ?? 'Zustelldepot', entry.code)?.stage).toBe(entry.stage);
    }
    // Waiting at the depot, whatever step the page files it under.
    for (const step of ['Zustelldepot', 'In Zustellung']) expect(pinAgStatus(step, '990302')).toEqual({ status: 'out_for_delivery', stage: 'ready_for_pickup' });
    // Sorted, then delivered without further tracking: the step it is filed under says more than it knows.
    expect(pinAgStatus('In Zustellung', 'NON_FURTHER_TRACKABLE')).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(pinAgStatus('In Zustellung', '990300')?.stage).toBe('out_for_delivery');
    expect(statusMapAnswer({ carrier: 'pin-ag', providerCode: '990323', description: 'Die Sendung wurde zugestellt.' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(pinAgStatus('toString')).toBeUndefined();
  });
});

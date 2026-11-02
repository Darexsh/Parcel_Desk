// @vitest-environment node
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { CARGUS_APP_API, readCargusApp } from './app.js';
import { normalizeCargusNumber, parseCargus } from './parser.js';
import { cargusScanStage, cargusSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const KEY = '00112233445566778899aabbccddeeff';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fixture(name)) as Record<string, unknown>;
const PRIVATE = /Synthetic Signer|PIN|SYNTHETIC-REF|Ramburs|confirmedBy|responseCode/;
const instance = (fetcher: typeof fetch) => adapter({
  fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, userAgent: 'Host/1.0',
});
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const service = (response: () => Response) => vi.fn<typeof fetch>(async () => response());
const empty = () => new Response(null, { status: 204 });

describe('Cargus numbers', () => {
  it('takes an AWB as written and refuses what is no identifier', () => {
    expect(normalizeCargusNumber(' 1000 000 001 ')).toBe('1000000001');
    for (const number of ['', '1234567', '1000000001!', 'X'.repeat(21)]) {
      expect(() => normalizeCargusNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('suggests the ten-digit series and the nine-digit 85 and 86 block, and is asked about them only for a lookup in Romania', () => {
    for (const number of ['1000000001', '1200000000', '850000000', '869999999']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('cargus');
      expect(recognitionAskedCarriers(number, { countryHint: 'RO' })[0], number).toBe('cargus');
      for (const countryHint of [undefined, 'BG', 'GR', 'DE', 'FR']) {
        expect(recognitionAskedCarriers(number, { countryHint }), `${number} ${countryHint}`).not.toContain('cargus');
      }
    }
    for (const other of ['2000000001', '0100000000', '840000000', '870000000', '10000000001', '85000000']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('cargus');
    }
  });
});

describe('Cargus app history', () => {
  it('keeps newest-first local clocks with town and county, without who signed or the sender reference', async () => {
    const result = normalizeCarrierResult(await instance(service(() => reply(json('delivered.json')))).track({ number: '1000000001' }));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-03T11:45:30', expected_delivery: null });
    expect(result.summary_only).toBeUndefined();
    expect(result.events!.map(({ local_time, description, location, stage }) => [local_time, description, location, stage])).toEqual([
      ['2026-03-03T11:45:30', 'Delivered', 'ARAD', 'delivered'],
      ['2026-03-03T08:02:09', 'With courier', 'ARAD', 'out_for_delivery'],
      // Two scans in the same second read alike, so one is kept.
      ['2026-03-03T03:15:44', 'Received in warehouse Arad [Depozit]', 'ARAD', 'in_transit'],
      ['2026-03-02T21:30:00', 'Automatic parcel sorting', 'SIBIU', 'in_transit'],
      // Scans of one clock come oldest first, so the later listed is the newer.
      ['2026-03-02T17:10:20', 'Received in warehouse Alba [Depozit]', 'ALBA IULIA, Alba', 'in_transit'],
      ['2026-03-02T17:10:20', 'Consolidation scan', 'ALBA IULIA, Alba', 'in_transit'],
      ['2026-03-02T15:04:05', 'Pickup shipment', 'ALBA IULIA, Alba', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('takes the newest scan over a summary that lags behind it', () => {
    const payload = { ...json('in-transit.json'), statusMessage: 'New' };
    expect(parseCargus(payload, '1000000002')).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Received in warehouse Bucuresti [Depozit]', last_update_local: '2026-01-21T18:00:01' });
    expect(parseCargus(payload, '1000000002').events?.at(-1)).toMatchObject({ description: 'Drop off at delivery location by sender',
      location: 'BUCURESTI', stage: 'accepted' });
  });

  it('answers an AWB without scans by its summary alone', () => {
    expect(parseCargus(json('registered.json'), '1000000003')).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'New', last_update: null, summary_only: true, expected_delivery: null, events: [] });
  });

  it('binds the reply to the whole AWB and refuses malformed scans', () => {
    expect(() => parseCargus(json('delivered.json'), '1000000002')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCargus({ ...json('delivered.json'), awbBarcode: undefined }, '1000000001')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const scan = { date: '2026-03-02T15:04:05.12', event: 'Pickup shipment', countyName: 'Alba', localityName: 'ALBA IULIA' };
    for (const broken of [{ ...scan, date: '2026-02-30T15:04:05' }, { ...scan, date: '2026-03-02T15:04:05Z' }, { ...scan, date: '2026-03-02 15:04' },
      { ...scan, event: ' ' }, { ...scan, countyName: 7 }, 'scan']) {
      expect(() => parseCargus({ awbBarcode: '1000000001', events: [broken] }, '1000000001'), JSON.stringify(broken))
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseCargus({ awbBarcode: '1000000001', events: [] }, '1000000001')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCargus({ awbBarcode: '1000000001', events: {} }, '1000000001')).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('stages wording the map has not seen by the shared rules, or leaves it unstaged', () => {
    expect(cargusScanStage('Synthetic wording')).toBeUndefined();
    expect(cargusSummaryStage('Synthetic wording')).toBeUndefined();
    expect(parseCargus({ awbBarcode: '1000000001', events: [{ date: '2026-03-02T15:04:05', event: 'Synthetic wording' }] }, '1000000001'))
      .toMatchObject({ status: 'unknown', last_status_text: 'Synthetic wording', events: [{ description: 'Synthetic wording' }] });
  });

  it('records each wording under the stage the parser and the status map give it', () => {
    for (const entry of statuses.entries) {
      const stage = entry.note?.startsWith('Summary') ? cargusSummaryStage(entry.wording) : cargusScanStage(entry.wording);
      expect(stage?.stage, entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'cargus', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('1', 'delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'received in warehouse cluj [depozit]')).toBe('in_transit');
  });
});

describe('Cargus app service', () => {
  it("sends the app's encrypted proof with the AWB, fresh each time", async () => {
    const fetcher = service(() => reply(json('delivered.json')));
    const read = () => readCargusApp('1000000001', { key: KEY, fetcher, userAgent: 'Host/1.0', signal: new AbortController().signal, timeoutMs: 5_000 });
    await read();
    await read();
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(CARGUS_APP_API);
    expect(Object.fromEntries(url.searchParams)).toEqual({ BarCode: '1000000001', lang: 'EN' });
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('Host/1.0');
    expect(headers.get('s')).toBe('M');
    expect(headers.get('seed')).toMatch(/^[0-9a-f]{32}$/);
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(KEY, 'hex'), Buffer.from(headers.get('seed')!, 'hex'));
    const message = Buffer.concat([decipher.update(headers.get('k')!, 'base64'), decipher.final()]).toString('utf8');
    expect(message).toMatch(/^[0-9a-f]{12}$/);
    const again = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(again.get('seed')).not.toBe(headers.get('seed'));
    expect(again.get('k')).not.toBe(headers.get('k'));
  });

  it('proves itself with the included key', async () => {
    const fetcher = service(() => reply(json('delivered.json')));
    await instance(fetcher).track({ number: '1000000001' });
    const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
    expect(headers.get('k')).toBeTruthy();
    expect(headers.get('seed')).toMatch(/^[0-9a-f]{32}$/);
    expect(headers.get('user-agent')).toBe('Host/1.0');
  });

  it('answers the empty reply for an unknown AWB as not found, and recognizes a known one', async () => {
    await expect(instance(service(empty)).track({ number: '9999999999' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(instance(service(() => reply(''))).track({ number: '9999999999' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(instance(service(empty)).recognize!('9999999999')).resolves.toEqual({ known: false });
    await expect(instance(service(() => reply(json('delivered.json')))).recognize!('1000000001')).resolves.toMatchObject({ known: true });
    const unused = service(empty);
    await expect(instance(unused).recognize!('1234567')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused key', () => reply('Bad Request', { status: 400, headers: { 'Content-Type': 'text/plain' } })],
    ['an unauthorized reply', () => reply('', { status: 401 })],
    ['a web page with HTTP 200', () => new Response('<html><title>Blocked</title></html>', { headers: { 'Content-Type': 'text/html' } })],
    ['a web page labelled as JSON', () => reply('<html></html>')],
  ])('answers %s as a challenge, never as not found', async (_, response) => {
    await expect(instance(service(response)).track({ number: '1000000001' })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([
    [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance'],
  ])('keeps HTTP %s distinct from an unknown AWB', async (status, kind) => {
    await expect(instance(service(() => reply('', { status }))).track({ number: '1000000001' })).rejects.toMatchObject({ kind, status });
  });

  it('treats a reply that is not JSON as malformed and bounds an oversized one', async () => {
    await expect(instance(service(() => reply('{"awbBarcode":'))).track({ number: '1000000001' })).rejects.toMatchObject({ kind: 'schema' });
    await expect(instance(service(() => reply(`"${'x'.repeat(300_000)}"`))).track({ number: '1000000001' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each(['network', 'rate limit', 'server error', 'body read'])('drops the key, AWB and body from a %s failure', async mode => {
    const privateData = `Synthetic Signer 1000000001 ${KEY}`;
    const fetcher: typeof fetch = async () => {
      if (mode === 'network') throw new Error(privateData);
      if (mode === 'rate limit') return reply(privateData, { status: 429, headers: { 'Retry-After': '30' } });
      if (mode === 'server error') return reply(privateData, { status: 500 });
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateData)); } }));
    };
    const error: unknown = await instance(fetcher).track({ number: '1000000001' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject(mode === 'rate limit' ? { kind: 'rate_limited', status: 429, retryAfterMs: 30_000 }
      : mode === 'server error' ? { kind: 'indeterminate', status: 500 } : { kind: 'transport' });
    expect(error).not.toHaveProperty('diagnostics');
    expect((error as Error).cause).toBeUndefined();
    expect(`${JSON.stringify(error)} ${String(error)}`).not.toMatch(/Synthetic|1000000001|00112233/);
  });

  it('starts no request for an invalid AWB or an aborted lookup', async () => {
    const fetcher = service(() => reply(json('delivered.json')));
    await expect(instance(fetcher).track({ number: '12-34' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(instance(fetcher).track({ number: '1000000001' }, { signal: AbortSignal.abort(new Error('caller cancelled')) }))
      .rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts the request in flight with the caller and ends with the budget', async () => {
    const hanging = vi.fn<typeof fetch>((_, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = instance(hanging).track({ number: '1000000001' }, { signal: controller.signal });
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    await expect(instance(hanging).track({ number: '1000000001' }, { budgetMs: 20 })).rejects.toMatchObject({ kind: 'budget' });
    expect(hanging).toHaveBeenCalledTimes(2);
  });
});

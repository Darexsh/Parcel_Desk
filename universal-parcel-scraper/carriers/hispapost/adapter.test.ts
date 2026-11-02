import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { universalCarrierHints } from '../../providers/shared/hints.js';
import { adapter, HISPAPOST_TRACKING, HispapostTracker } from './adapter.js';
import { hispapostBarcode, normalizeHispapostNumber, parseHispapost, parseHispapostRefusal } from './parser.js';
import { hispapostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'BAE90000H900000001';
const RETURNED = 'BG-2601019ABCDEFGHI-01';
const IN_TRANSIT = 'CNES90000000025';
const UNKNOWN = 'CNES90000000017';
const TOKEN = 'SyntheticFormToken-0000000000000000000000000000000000000000000000000000000000000000000000';
const SESSION = '_hispapost_session=Synthetic%2BSession%3D%3D--0000000000--1111111111%3D%3D';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const page = () => html(fixture('page'), { headers: { 'Set-Cookie': `${SESSION}; path=/; expires=Sun, 01 Mar 2026 08:00:00 GMT; httponly; samesite=lax` } });
/** The page, then the given answer to the form. */
const flow = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async (_url, init) => (init?.method === 'POST' ? answer() : page()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Hispapost HTTP adapter', () => {
  it('reads the page’s token and session, then posts the barcode with them, through the supplied transport', async () => {
    const fetcher = flow(() => html(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HispapostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bae90000h900000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [formUrl, formInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([String(pageUrl), String(formUrl)]).toEqual([HISPAPOST_TRACKING, HISPAPOST_TRACKING]);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(formInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: SESSION, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(formInit.body)))).toEqual({ authenticity_token: TOKEN, barcode: DELIVERED });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hispapost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('gives a Temu number back its dashes, since the tracker matches the whole barcode as printed', async () => {
    expect(hispapostBarcode(normalizeHispapostNumber(RETURNED))).toBe(RETURNED);
    expect(hispapostBarcode('BG2601019ABCDEFGHI01')).toBe(RETURNED);
    expect(hispapostBarcode(DELIVERED)).toBe(DELIVERED);
    expect(hispapostBarcode('BG9000000017')).toBe('BG9000000017');
    const fetcher = flow(() => html(fixture('returned')));
    await expect(carrier(fetcher).track({ number: 'BG2601019ABCDEFGHI01' })).resolves.toMatchObject({ current_stage: 'returned' });
    expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)).get('barcode')).toBe(RETURNED);
  });

  it('reads the status and its Madrid clock as one dated status, marked as a summary', () => {
    expect(parseHispapost(fixture('delivered'), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Entregado',
      last_update: '2026-03-14T12:05:00+01:00', expected_delivery: null, delivered_at: '2026-03-14T12:05:00+01:00',
      timezone: 'Europe/Madrid', summary_only: true,
      events: [{ time: '2026-03-14T12:05:00+01:00', description: 'Entregado', stage: 'delivered', stage_source: 'carrier_map' }],
    });
  });

  it('reads the hour Madrid’s clocks repeat as its first occurrence', () => {
    expect(parseHispapost(fixture('returned'), 'BG2601019ABCDEFGHI01')).toMatchObject({
      status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Devuelto a origen - No retirado en oficina', last_update: '2026-10-25T02:30:00+02:00',
      summary_only: true, events: [{ time: '2026-10-25T02:30:00+02:00', stage: 'returned' }],
    });
    expect(parseHispapost(fixture('returned'), RETURNED)).not.toHaveProperty('delivered_at');
  });

  it('leaves a wording the map lacks to the shared rules, and keeps one they cannot read without a stage', () => {
    expect(parseHispapost(fixture('in-transit'), IN_TRANSIT)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: expect.stringMatching(/^wording:/),
      last_update: '2026-02-02T09:41:00+01:00', events: [{ description: 'En reparto', stage: 'out_for_delivery' }],
    });
    const unread = parseHispapost(fixture('in-transit').replace('En reparto', 'Xyzzy'), IN_TRANSIT);
    expect(unread).toMatchObject({ status: 'unknown', last_status_text: 'Xyzzy', events: [{ description: 'Xyzzy' }] });
    expect(unread).not.toHaveProperty('current_stage');
    expect(unread.events![0]).not.toHaveProperty('stage');
  });

  it('keeps a status shown without a clock, undated', () => {
    const result = parseHispapost(fixture('delivered').replace(/<p class="h4">[^<]*<\/p>/, '<p class="h4"></p>'), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, events: [{ description: 'Entregado' }] });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![0]).not.toHaveProperty('time');
  });

  it('reads the tracker’s message for the barcode asked as not found, and nothing else', async () => {
    expect(() => parseHispapostRefusal(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHispapostRefusal(fixture('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHispapostRefusal(fixture('page'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHispapostRefusal(CHALLENGE, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(carrier(flow(() => html(fixture('not-found'), { status: 422 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses an answer for another barcode, or without the barcode, status or a valid clock', () => {
    expect(() => parseHispapost(fixture('delivered'), 'BAE90000H900000002')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHispapost(fixture('page'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHispapost(fixture('delivered').replace('Estado del envío: ', 'Estado: '), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHispapost(fixture('delivered').replace('Entregado', ''), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const clock of ['31/02/2026 12:05', '14/03/2026', '2026-03-14 12:05']) {
      expect(() => parseHispapost(fixture('delivered').replace('14/03/2026 12:05', clock), DELIVERED), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseHispapost(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits, moved routes and a refused token apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(flow(answer)).track({ number: DELIVERED });
    await expect(lookup(() => html(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://intranet.hispapost.es/users/sign_in' } })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => html('<html><body>Error</body></html>', { status: 422 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => html('<html><body><h1>Hispapost</h1></body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('needs the page’s form and session before it posts', async () => {
    const without = (first: Response) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first);
      return { fetcher, lookup: carrier(fetcher).track({ number: DELIVERED }) };
    };
    const noSession = without(html(fixture('page')));
    await expect(noSession.lookup).rejects.toMatchObject({ kind: 'schema' });
    const noForm = without(html('<html><body>Mantenimiento</body></html>', { headers: { 'Set-Cookie': `${SESSION}; path=/` } }));
    await expect(noForm.lookup).rejects.toMatchObject({ kind: 'schema' });
    const blocked = without(html(CHALLENGE));
    await expect(blocked.lookup).rejects.toMatchObject({ kind: 'challenge' });
    const moved = without(html('', { status: 301, headers: { Location: 'https://www.hispapost.es/' } }));
    await expect(moved.lookup).rejects.toMatchObject({ kind: 'transport' });
    for (const { fetcher } of [noSession, noForm, blocked, moved]) expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('starts again with a new page once when Hispapost cannot be reached', async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return init?.method === 'POST' ? html(fixture('delivered')) : page();
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new HispapostTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST']);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('rejects what is not a barcode, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ABCDEFGH', 'AB12', `CNES${'0'.repeat(37)}1`, 'CNES9000000001é']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers a number filed under Hispapost, with no recognition', async () => {
    const fetcher = flow(() => html(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'hispapost' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'hispapost', source: 'hispapost', result: { current_stage: 'delivered', summary_only: true } });
    expect(carrier(fetcher)).not.toHaveProperty('recognize');
  });
});

describe('Hispapost numbers and hand-offs', () => {
  it('claims none of the marketplace numbers it delivers, so recognition never asks it', () => {
    for (const number of [DELIVERED, 'BG2601019ABCDEFGHI01', IN_TRANSIT, 'NT900000000000000000017']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('hispapost');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id), number).not.toContain('hispapost');
    }
  });

  it('takes a hand-off from a result that names it as the delivery carrier', () => {
    expect(deliveryHandoff('cacesa', DELIVERED, { status: 'in_transit', delivery_carrier: 'hispapost', events: [] }))
      .toEqual({ carrier: 'hispapost', number: DELIVERED, basis: 'partner' });
  });

  it('turns the names universal providers give it into Hispapost', () => {
    // 17TRACK's carrier list writes the name with a trailing space.
    for (const name of ['Hispapost ', 'Hispapost', 'HISPAPOST', 'Hispapost S.A.']) {
      expect(universalCarrierHints([name], IN_TRANSIT), name).toMatchObject({ discovered_carrier: 'hispapost' });
    }
  });
});

describe('Hispapost status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(hispapostStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'hispapost', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('X', 'entregado')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'hispapost', description: 'En reparto' })).toEqual({ kind: 'unknown' });
  });
});

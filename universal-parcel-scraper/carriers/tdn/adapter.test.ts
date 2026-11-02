import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TDN_TRACKING, TdnTracker } from './adapter.js';
import { normalizeTdnNumber, parseTdn } from './parser.js';
import { statusMap, tdnMappedStage, tdnStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '999900000017';
const IN_TRANSIT = '999900000025';
const UNKNOWN = '999900000033';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** A page as the tracker sends it: windows-1252 bytes, which its header names. */
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : Buffer.from(body, 'latin1'),
  { status, headers: { 'Content-Type': 'text/html;charset=windows-1252', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('TDN HTTP adapter', () => {
  it('asks the tracker for the whole expedition number as the tracking page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TdnTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9999 0000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TDN_TRACKING}?REFERENCIA=${DELIVERED}&Aceptar=Aceptar`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tdn', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the status, without the branch number, and keeps its clock a wall clock, marked as a summary', () => {
    expect(parseTdn(fixture('delivered'), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Entregado',
      last_update: null, last_update_local: '2026-03-14T12:05:00', expected_delivery: null, summary_only: true,
      events: [{ local_time: '2026-03-14T12:05:00', description: 'Entregado', stage: 'delivered', stage_source: 'carrier_map' }],
    });
  });

  it('leaves a wording the map lacks to the shared rules, and keeps one they cannot read without a stage', () => {
    expect(parseTdn(fixture('in-transit'), IN_TRANSIT)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: expect.stringMatching(/^wording:/),
      last_status_text: 'En reparto', last_update_local: '2026-02-02T09:41:00', summary_only: true,
      events: [{ local_time: '2026-02-02T09:41:00', description: 'En reparto', stage: 'out_for_delivery' }],
    });
    const unread = parseTdn(fixture('in-transit').replace('En reparto', 'Xyzzy'), IN_TRANSIT);
    expect(unread).toMatchObject({ status: 'unknown', last_status_text: 'Xyzzy', events: [{ description: 'Xyzzy' }] });
    expect(unread).not.toHaveProperty('current_stage');
    expect(unread.events![0]).not.toHaveProperty('stage');
  });

  it('keeps a wording with its own dashes, drops a branch named after its number, reads a line without a branch, and refuses one without a clock', () => {
    const line = (text: string) => parseTdn(fixture('in-transit').replace('En reparto - 028 - 02/02/2026 09:41', text), IN_TRANSIT);
    expect(line('Incidencia - Ausente - 028 - 02/02/2026 09:41')).toMatchObject({
      current_stage: 'failed_attempt', events: [{ local_time: '2026-02-02T09:41:00', description: 'Incidencia - Ausente' }],
    });
    for (const branch of ['028 VILLANUEVA', '028 VILLA NUEVA-NORTE']) {
      expect(line(`En reparto - ${branch} - 02/02/2026 09:41`), branch).toMatchObject({
        current_stage: 'out_for_delivery', last_status_text: 'En reparto', events: [{ local_time: '2026-02-02T09:41:00', description: 'En reparto' }],
      });
    }
    expect(line('En reparto - 02/02/2026 09:41')).toMatchObject({ events: [{ local_time: '2026-02-02T09:41:00', description: 'En reparto' }] });
    for (const text of ['En reparto', 'En reparto - 028', 'En reparto - 028 - 02/02/2026']) {
      expect(() => line(text), text).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('puts the latest of several status lines first', () => {
    const html = fixture('delivered').replace('<div class="circle-contain2 "></div>', '<div class="circle-contain2 ">En reparto - 046 - 14/03/2026 08:30</div>');
    expect(parseTdn(html, DELIVERED).events!.map((event) => event.description)).toEqual(['Entregado', 'En reparto']);
  });

  it('reads the tracker’s notice for an unregistered expedition as not found, in both its wordings', async () => {
    expect(() => parseTdn(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const short = fixture('not-found').replace(/Envío no registrado\.[^<]*/, 'Envío no registrado');
    expect(() => parseTdn(short, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    const beside = fixture('not-found').replace('<div class="circle-contain2"></div>', '<div class="circle-contain2">Entregado - 046 - 14/03/2026 12:05</div>');
    expect(() => parseTdn(beside, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('decodes the page in the encoding its header names, and still knows the notice in the wrong one', async () => {
    const transit = fixture('in-transit').replace('En reparto', 'En tránsito');
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: IN_TRANSIT });
    await expect(lookup(reply(transit))).resolves.toMatchObject({ last_status_text: 'En tránsito', current_stage: 'in_transit' });
    await expect(lookup(reply(transit, 200, { 'Content-Type': 'text/html' }))).resolves.toMatchObject({ last_status_text: 'En tránsito' });
    await expect(lookup(new Response(transit, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } })))
      .resolves.toMatchObject({ last_status_text: 'En tránsito' });
    // UTF-8 bytes read as windows-1252 garble the accent, which the notice leaves open.
    const mislabelled = new Response(fixture('not-found'), { headers: { 'Content-Type': 'text/html;charset=windows-1252' } });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(mislabelled)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a page for another reference, or without the panel, the reference, the rail, a status or a valid clock', () => {
    expect(() => parseTdn(fixture('delivered'), '999900000041')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTdn(fixture('delivered').replace(`<strong>${DELIVERED}</strong>`, '<strong></strong>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTdn(fixture('delivered').replace('class="principal"', 'class="main"'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTdn(fixture('delivered').replaceAll('circle-contain2', 'slot'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTdn(fixture('delivered').replace('Entregado - 046 - 14/03/2026 12:05', ''), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const clock of ['31/02/2026 12:05', '14/13/2026 12:05', '14/03/2026 24:05', '14/03/2026 12:61']) {
      expect(() => parseTdn(fixture('delivered').replace('14/03/2026 12:05', clock), DELIVERED), clock).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTdn(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTdn('<html><body><h1>Mantenimiento</h1></body></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing expeditions', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHALLENGE))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 301, headers: { Location: 'https://www.tdn.es/' } }));
    await expect(carrier(moved).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '   ']) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new TdnTracker({ fetcher: flaky, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
  });

  it('takes twelve-digit numbers starting with 9999 only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '99990000001', '9999000000170', '899900000017', '9999O0000017', 'ABCD00000017', `9999${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(() => normalizeTdnNumber('9999-0000-0017')).not.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known expedition and an unregistered one by the same lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-14T12:05:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('TDN numbers and links', () => {
  it('routes a number to the adapter when the caller names TDN or pastes its link, which detection never offers', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('tdn');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('tdn');
    for (const link of [`https://www.tdn.es/tracking?envio=${DELIVERED}&autoredir=1`, `https://www.tdn.es/tracking/?Envio=${DELIVERED}`,
      `http://tracking.tdnonline.com/consulta_expediciones/tracking?REFERENCIA=${DELIVERED}&Aceptar=Aceptar`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'tdn', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'tdn' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tdn', source: 'tdn', result: { current_stage: 'delivered', summary_only: true } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${TDN_TRACKING}?`))).toBe(true);
  });
});

describe('TDN status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      // The coded rows come from the older tracker's table; the adapter reads wording alone.
      if (entry.code) continue;
      expect(tdnMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      if (!entry.stage) continue;
      expect(tdnStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'tdn', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('ENTR', 'entregado')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'tdn', description: 'En reparto' })).toEqual({ kind: 'unknown' });
  });
});

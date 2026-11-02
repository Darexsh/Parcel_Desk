import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CORREOS_CUBA_LOOKUP, CORREOS_CUBA_PAGE, CorreosCubaTracker } from './adapter.js';
import { correosCubaPageToken, normalizeCorreosCubaNumber, parseCorreosCuba } from './parser.js';
import { correosCubaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const INBOUND = 'ZZ000000014GB';
const OWN = 'ZZ000000014CU';
const TOKEN = '0123456789';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fixture(`${name}.json`)) as { datos: Record<string, unknown>[] } & Record<string, unknown>;
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
// The tracker page, then the lookup's replies in turn.
const site = (...replies: Response[]) => {
  const lookups = [...replies];
  return vi.fn<typeof fetch>(async (url) => String(url) === CORREOS_CUBA_PAGE ? html(fixture('page.html')) : lookups.shift() ?? reply(json('unknown')));
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sample block page</body></html>';

describe('Correos de Cuba tracking adapter', () => {
  it('posts the whole code with Havana\'s year and the page\'s token, as the page\'s script does, through the supplied transport', async () => {
    const fetcher = site(reply(json('delivered')), reply(json('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    // Two in the morning in Havana's New Year is still the old year in its lookups.
    const tracker = new CorreosCubaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => Date.parse('2027-01-01T04:30:00Z') });
    await expect(tracker.fetch(' zz 000 000 014 gb ', { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[page, pageInit], [lookup, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(page).toBe(CORREOS_CUBA_PAGE);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(lookup).toBe(CORREOS_CUBA_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
      Referer: CORREOS_CUBA_PAGE, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ codigo: INBOUND, anno: '2026', token: TOKEN, user: '' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'correos-cuba', step: 'direct', outcome: 'ok' }));
    // The next lookup reuses the page's token.
    await expect(tracker.fetch(OWN)).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new URLSearchParams(String(fetcher.mock.calls[2]![1]!.body)).get('codigo')).toBe(OWN);
  });

  it('reads an item from abroad newest first, with each office\'s wall clock, and keeps a scan listed twice once', () => {
    const result = parseCorreosCuba(json('delivered'), INBOUND);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO', last_update: null, last_update_local: '2026-05-21T12:19:28', expected_delivery: null,
      events: expect.any(Array) });
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-05-21T12:19:28', 'Sample 10 (P)', 'ENTREGADO', 'delivered'],
      // A received item is at the office that received it, the other scans at the office they left.
      ['2026-05-21T11:23:58', 'Sample 10 (P)', 'RECEPCIONADO', 'in_transit'],
      ['2026-05-21T11:08:28', 'CCP Sample Town', 'FACTURADO', 'in_transit'],
      ['2026-05-21T11:05:42', 'CCP Sample Town', 'CLASIFICADO', 'in_transit'],
      ['2026-05-21T10:50:13', 'CCP Sample Town', 'RECEPCIONADO', 'in_transit'],
      ['2026-05-21T09:18:24', 'Oficina Cambio Internacional', 'FACTURADO', 'in_transit'],
      ['2026-05-20T10:54:48', 'Oficina Cambio Internacional', 'CLASIFICADO', 'in_transit'],
      ['2026-05-19T14:30:05', 'Oficina Cambio Internacional', 'SALIDA ADUANA', 'in_transit'],
      ['2026-05-19T14:21:02', 'Oficina Cambio Internacional', 'ENTREGADO A ADUANA', 'customs'],
      ['2026-05-19T14:15:50', 'Oficina Cambio Internacional', 'RECEPCIONADO', 'in_transit'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/CHECA|timeline|peso/i);
  });

  it('reads an item posted in Cuba, and one leaving it at the country the reply names', async () => {
    const result = await carrier(site(reply(json('in-transit')))).track({ number: OWN });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'FACTURADO', last_update_local: '2026-04-28T12:23:56' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-04-27T11:34:36', location: 'Sample Pueblo (P)', description: 'IMPUESTO',
      stage: 'accepted', stage_source: 'carrier_map' });
    const exported = parseCorreosCuba(json('export'), OWN);
    expect(exported).toMatchObject({ current_stage: 'customs', last_status_text: 'ENTREGADO A ADUANA' });
    expect(exported.events![0]!.location).toBe('BRASIL');
    expect(exported.events![1]!.location).toBe('Oficina Cambio Internacional');
  });

  it('takes a new state without inventing a stage, and a date without a clock', () => {
    const value = json('in-transit');
    value.datos.unshift({ ...value.datos[0], estado: 'SAMPLE STATE', fecha: '2026-04-29' });
    expect(parseCorreosCuba(value, OWN)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'SAMPLE STATE',
      last_update_local: '2026-04-29' });
    expect(parseCorreosCuba(value, OWN).events![0]).toEqual({ local_time: '2026-04-29', location: 'Sample Pueblo (P)', description: 'SAMPLE STATE' });
    value.datos[0]!.estado = 'DEVUELTO AL REMITENTE';
    expect(parseCorreosCuba(value, OWN)).toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
  });

  it('reads the tracker\'s empty answer as inconclusive, never as a missing item', async () => {
    expect(() => parseCorreosCuba(json('unknown'), OWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    await expect(carrier(site(reply(json('unknown')))).track({ number: OWN })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(carrier(site(reply(json('unknown')))).recognize!(OWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(site(reply({ datos: [], error: 'Sample refusal' }))).track({ number: OWN }))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'Correos de Cuba refused the lookup' });
    await expect(carrier(site(reply(' '))).track({ number: OWN })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('recognizes an item with scans by its local clock', async () => {
    await expect(carrier(site(reply(json('in-transit')))).recognize!(OWN))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-28T12:23:56' });
  });

  it('replaces a token the tracker has dropped once, and drops one it refuses fresh', async () => {
    const fetcher = site(reply(json('in-transit')), reply(json('expired-token')), reply(json('delivered')));
    const tracker = new CorreosCubaTracker({ fetcher });
    await tracker.fetch(OWN);
    await expect(tracker.fetch(INBOUND)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([CORREOS_CUBA_PAGE, CORREOS_CUBA_LOOKUP, CORREOS_CUBA_LOOKUP,
      CORREOS_CUBA_PAGE, CORREOS_CUBA_LOOKUP]);
    const refusing = site(reply(json('expired-token')), reply(json('in-transit')));
    const fresh = new CorreosCubaTracker({ fetcher: refusing });
    await expect(fresh.fetch(OWN)).rejects.toMatchObject({ kind: 'challenge', message: 'Correos de Cuba refused its own page token' });
    expect(refusing).toHaveBeenCalledTimes(2);
    // The refused token is not reused.
    await expect(fresh.fetch(OWN)).resolves.toMatchObject({ status: 'in_transit' });
    expect(refusing.mock.calls.map(([url]) => String(url))).toEqual([CORREOS_CUBA_PAGE, CORREOS_CUBA_LOOKUP, CORREOS_CUBA_PAGE, CORREOS_CUBA_LOOKUP]);
  });

  it('keeps a firewall\'s page a challenge and a changed page or reply a schema error', async () => {
    const page = (body: string) => vi.fn<typeof fetch>().mockResolvedValue(html(body));
    await expect(carrier(page(BLOCKED)).track({ number: OWN })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(page('<html><body><div class="g-recaptcha"></div></body></html>')).track({ number: OWN })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(page('<html><body>Sample maintenance page</body></html>')).track({ number: OWN })).rejects.toMatchObject({ kind: 'schema' });
    for (const token of ['', 'sample token', '<b>', 'x'.repeat(65)]) {
      expect(() => correosCubaPageToken(fixture('page.html').replace(`value="${TOKEN}"`, `value="${token}"`)), token).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    await expect(carrier(site(html(BLOCKED))).track({ number: OWN })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(html('<html><body>Sample error</body></html>'))).track({ number: OWN })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('rejects a malformed reply or row', () => {
    for (const payload of [null, [], {}, { datos: {} }, { datos: [null] }, { datos: [], error: 3 }, { datos: Array(501).fill(json('delivered').datos[0]) }]) {
      expect(() => parseCorreosCuba(payload, OWN), JSON.stringify(payload).slice(0, 40)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const [field, value] of [['estado', ''], ['estado', 3], ['fecha', '21/05/2026 12:19:28'], ['fecha', '2026-02-30 12:00:00'],
      ['fecha', '2026-05-21 24:00:00'], ['fecha', null], ['oficina_origen', {}], ['oficina_destino', ['Sample']]] as const) {
      const value_ = json('delivered'); value_.datos[0]![field] = value;
      expect(() => parseCorreosCuba(value_, INBOUND), `${field} ${String(value)}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015CU', 'ZZ00000001CU', 'ZZ000000014CUX', '4567854523', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}CU`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCorreosCubaNumber(' zz-000 000 014 cu ')).toBe(OWN);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [301, 'transport'], [404, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s on the page and the lookup, without a retry', async (status, kind) => {
      const page = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('page.html'), status));
      await expect(carrier(page).track({ number: OWN })).rejects.toMatchObject({ kind });
      expect(page).toHaveBeenCalledTimes(1);
      const lookup = site(reply(json('unknown'), status));
      await expect(carrier(lookup).track({ number: OWN })).rejects.toMatchObject({ kind });
      expect(lookup).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
    const flaky = site(reply(json('delivered')));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(flaky).track({ number: INBOUND })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(3);
    const immediate = site(reply(json('delivered')));
    await expect(carrier(immediate).track({ number: INBOUND }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: INBOUND }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: INBOUND }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1024 * 1024 + 1)));
    await expect(carrier(large).track({ number: INBOUND })).rejects.toThrow('unexpectedly large');
  });

  it('is asked first about its own codes, and not about other posts\' codes', () => {
    // The issuer does not establish who delivers the item: detection keeps the postal fallback.
    expect(detectCarrierMatch(OWN)).toMatchObject({ carrier: 'intl-post' });
    expect(recognitionAskedCarriers(OWN)[0]).toBe('correos-cuba');
    for (const number of [INBOUND, 'ZZ000000015CU']) expect(recognitionAskedCarriers(number), number).not.toContain('correos-cuba');
  });

  it('routes an item filed under Correos de Cuba to the adapter', async () => {
    const fetcher = site(reply(json('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INBOUND, carrier: 'correos-cuba' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'correos-cuba', source: 'correos-cuba', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => [CORREOS_CUBA_PAGE, CORREOS_CUBA_LOOKUP].includes(String(url)))).toBe(true);
  });
});

describe('Correos de Cuba status vocabulary', () => {
  it('maps every state it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'correos-cuba', description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(correosCubaStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    for (const wording of ['constructor', 'toString', 'Sample delivered note']) expect(statusMap.stage(null, wording), wording).toBeUndefined();
    expect(correosCubaStage('')).toBeNull();
  });
});

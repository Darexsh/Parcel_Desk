import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, INTEX_TRACKING, IntexTracker, intexTrackingUrl } from './adapter.js';
import { intexRequestNumber, normalizeIntexNumber, parseIntex } from './parser.js';
import { intexStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '4000001-3';
const IN_TRANSIT = '4000002-1';
const UNKNOWN = '4000009-9';
const html = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = html('delivered');
const transit = html('in-transit');
const absent = html('not-found');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => {
  const $ = load(body);
  change($);
  return $.html();
};
const scans = (rows: [string, string][], body = delivered) => edit(($) => {
  $('table.shipment_data tr').filter((_, tr) => $(tr).children('td').length === 2).remove();
  $('table.shipment_data tr').eq(2).after(rows.map(([wording, clock]) => `<tr><td>${wording}</td><td>${clock}</td></tr>`).join(''));
}, body);
const shown = (number: string, body = delivered) => edit(($) => { $('table.shipment_data th').eq(1).text(number); }, body);
const reply = (body = delivered, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const pageUrl = (number: string) => `${INTEX_TRACKING}?sdnr=${number}&mid=1`;

describe('INTEX Paketdienst tracking adapter', () => {
  it('reads a delivered shipment newest first, dating every scan in Berlin', () => {
    const result = normalizeCarrierResult(parseIntex(delivered, DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'Zugestellt', last_update: '2026-01-13T11:05:00+01:00', expected_delivery: null,
      delivered_at: '2026-01-13T11:05:00+01:00', destination_country: 'DE' });
    expect(result.events!.map((event) => [event.time, event.description, event.stage, event.stage_source])).toEqual([
      ['2026-01-13T11:05:00+01:00', 'Zugestellt', 'delivered', 'wording:language'],
      ['2026-01-13T05:31:00+01:00', 'Eingang Auslieferstation', 'in_transit', 'carrier_map'],
      ['2026-01-13T00:42:00+01:00', 'Ausgang Hauptumschlagsplatz', 'in_transit', 'carrier_map'],
      ['2026-01-13T00:11:00+01:00', 'Eingang Hauptumschlagsplatz', 'in_transit', 'carrier_map'],
      ['2026-01-13T00:10:00+01:00', 'Eingang Hauptumschlagsplatz', 'in_transit', 'carrier_map'],
      ['2026-01-12T16:20:00+01:00', 'Dateneingang INTEX', 'registered', 'carrier_map'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
    // The recipient's postcode and town and the partner's parcel number stay out.
    expect(JSON.stringify(result)).not.toMatch(/12345|Musterstadt|09900000001|derkurier/);
  });

  it('reads a shipment in transit on the summer offset, typed with or without its hyphen', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(transit));
    for (const typed of [IN_TRANSIT, '40000021']) {
      const result = await carrier(fetcher).track({ number: typed });
      expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Eingang Auslieferstation',
        last_update: '2026-06-11T05:56:00+02:00', destination_country: 'DE' });
      expect(result).not.toHaveProperty('delivered_at');
      expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
        ['2026-06-11T05:56:00+02:00', 'in_transit'],
        ['2026-06-11T00:48:00+02:00', 'in_transit'],
        ['2026-06-11T00:17:00+02:00', 'in_transit'],
        ['2026-06-09T15:12:00+02:00', 'registered'],
      ]);
    }
    // Both forms ask with the hyphen, as the tracker shows the number.
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([pageUrl(IN_TRANSIT), pageUrl(IN_TRANSIT)]);
  });

  it('reads the repeated hour when the clocks go back as its first occurrence', () => {
    const result = parseIntex(scans([['Eingang Hauptumschlagsplatz', '25.10.2026 um 02:30 Uhr']]), DELIVERED);
    expect(result.events![0]!.time).toBe('2026-10-25T02:30:00+02:00');
  });

  it('keeps a destination outside Germany unnamed', () => {
    const abroad = edit(($) => { $('table.shipment_data th').eq(3).text('L-1234 Beispieldorf'); });
    expect(parseIntex(abroad, DELIVERED)).not.toHaveProperty('destination_country');
  });

  it('binds the page to the whole number asked', () => {
    expect(() => parseIntex(delivered, IN_TRANSIT)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const number of ['4000001', '4000001-', '400000-13', '14000001-3']) {
      expect(() => parseIntex(shown(number), DELIVERED), number).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseIntex(shown('40000013'), DELIVERED)).toMatchObject({ status: 'delivered' });
    expect(() => parseIntex(shown(''), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // A page listing several shipments has not settled on the one asked.
    const several = edit(($) => { $('table.shipment_data').after($('table.shipment_data').clone()); });
    expect(() => parseIntex(several, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports a shipment absent only on the tracker\'s notice for that number', () => {
    expect(() => parseIntex(absent, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIntex(absent.replaceAll(UNKNOWN, '40000099'), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIntex(absent, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const renamed = absent.replace('konnte nicht ermittelt werden', 'ist nicht verfügbar');
    expect(() => parseIntex(renamed, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('tells a browser check from a changed page', () => {
    expect(() => parseIntex('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const body of ['', '<html><body><div id="content"><form action="index.php"></form></div></body></html>',
      edit(($) => $('table').removeClass('shipment_data'))]) {
      expect(() => parseIntex(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects malformed scans and rows', () => {
    for (const body of [scans([['Zugestellt', '30.02.2026 um 10:00 Uhr']]), scans([['Zugestellt', '12.01.2026 um 25:00 Uhr']]),
      scans([['Zugestellt', '2026-01-12 10:00']]), scans([['', '12.01.2026 um 10:00 Uhr']]),
      edit(($) => $('table.shipment_data tr').eq(4).append('<td>extra</td>')),
      edit(($) => $('table.shipment_data').append('<tr><th>Ihre Sendung Nr.</th><th>4000001-3</th></tr>'))]) {
      expect(() => parseIntex(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseIntex(scans([]), DELIVERED)).toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
    const long = Array.from({ length: 301 }, (_, index) => ['Eingang Hauptumschlagsplatz',
      `12.01.2026 um ${String(Math.floor(index / 60) % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')} Uhr`] as [string, string]);
    expect(() => parseIntex(scans(long), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const truncated = parseIntex(scans(long.slice(0, 250)), DELIVERED);
    expect(truncated).toMatchObject({ history_truncated: true });
    expect(truncated.events).toHaveLength(200);
    // A row the page repeats is kept once.
    const twice = scans([['Dateneingang INTEX', '12.01.2026 um 16:20 Uhr'], ['Dateneingang INTEX', '12.01.2026 um 16:20 Uhr']]);
    expect(parseIntex(twice, DELIVERED).events).toHaveLength(1);
  });

  it('takes eight digits, with or without the hyphen before the last', () => {
    expect(normalizeIntexNumber(' 4000001-3 ')).toBe('40000013');
    expect(normalizeIntexNumber('40000013')).toBe('40000013');
    expect(intexRequestNumber('40000013')).toBe(DELIVERED);
    for (const number of ['', '4000001', '400000135', '4000001-34', 'A000001-3', '1'.repeat(70)]) {
      expect(() => normalizeIntexNumber(number), number).toThrow(InvalidInputError);
    }
    expect(intexTrackingUrl('40000013')).toBe(pageUrl(DELIVERED));
  });

  it('maps every recorded status, and the status map answers by wording alone', () => {
    for (const entry of statuses.entries) {
      expect(intexStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'intex-paketdienst', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'intex-paketdienst', providerCode: 'X', description: 'Dateneingang INTEX' })).toEqual({ kind: 'unknown' });
    expect(intexStage('Sendung teleportiert')).toBeNull();
  });

  it('opens the tracker from its links', () => {
    expect(parseTrackingInput(pageUrl(DELIVERED))).toMatchObject({ carrier: 'intex-paketdienst', source: 'link' });
    expect(parseTrackingInput(`https://www.intex-paketdienst.de/website/tracking.html?sdnr=${DELIVERED}`))
      .toMatchObject({ carrier: 'intex-paketdienst', source: 'link' });
  });

  it('asks the tracker once for the whole number, through the supplied transport and without a session', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new IntexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${DELIVERED} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(pageUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'intex-paketdienst', step: 'direct', outcome: 'ok' }));
    await expect(carrier(fetcher).track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('keeps the HTTP failure taxonomy', async () => {
    const answers = [[absent, 200, 'not_found', UNKNOWN], ['', 302, 'transport', DELIVERED], ['', 404, 'transport', DELIVERED],
      ['', 403, 'challenge', DELIVERED], ['', 429, 'rate_limited', DELIVERED], ['', 500, 'indeterminate', DELIVERED],
      ['<html>Service unavailable</html>', 200, 'schema', DELIVERED]] as const;
    for (const [body, status, kind, number] of answers) {
      const fetcher = vi.fn(async () => reply(body, status, status === 302 ? { Location: '/' } : {})) as unknown as typeof fetch;
      await expect(new IntexTracker({ fetcher }).fetch(number), `${status}`).rejects.toMatchObject({ kind });
    }
    const large = vi.fn(async () => new Response(new Uint8Array(300_000))) as unknown as typeof fetch;
    await expect(new IntexTracker({ fetcher: large }).fetch(DELIVERED)).rejects.toThrow('unexpectedly large');
  });

  it('asks once more after a failed connection, and only then', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    expect(await new IntexTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(DELIVERED)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(new IntexTracker({ fetcher: down as unknown as typeof fetch }).fetch(DELIVERED)).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(down).toHaveBeenCalledTimes(2);
    const missing = vi.fn(async () => reply(absent));
    await expect(new IntexTracker({ fetcher: missing as unknown as typeof fetch }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new IntexTracker({ fetcher: immediate }).fetch(DELIVERED, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new IntexTracker({ fetcher: immediate }).fetch(DELIVERED, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new IntexTracker({ fetcher: slow }).fetch(DELIVERED, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

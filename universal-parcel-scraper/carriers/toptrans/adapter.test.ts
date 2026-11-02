import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TOPTRANS_TRACKING, ToptransTracker, toptransTrackingUrl } from './adapter.js';
import { normalizeToptransNumber, parseToptrans } from './parser.js';
import { toptransStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '12300000045';
const IN_TRANSIT = '45600000078';
const FIRST_PIECE = '1230000000101';
const MIDDLE_PIECE = '1230000000102';
const html = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = html('delivered');
const transit = html('in-transit');
const absent = html('not-found');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => {
  const $ = load(body);
  change($);
  return $.html();
};
const field = (label: string, value: string, body = delivered) => edit(($) => {
  $('th').filter((_, th) => $(th).text() === label).next('td').text(value);
}, body);
const scans = (rows: [string, string][], body = delivered) => edit(($) => {
  const header = $('tr').filter((_, tr) => $(tr).children('th').first().text() === 'Depo');
  header.nextAll('tr').remove();
  header.after(rows.map(([depot, scan]) => `<tr><td>${depot}</td><td>${scan}</td></tr>`).join(''));
}, body);
const reply = (body = delivered, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const shipmentUrl = (number: string) => `${TOPTRANS_TRACKING}?parcel_number=${number}`;
const pieceUrl = (number: string) => `${TOPTRANS_TRACKING}?item_number=${number}`;
// F5's notice when its firewall turns a request away, which it serves with HTTP 200.
const REJECTED = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your '
  + 'administrator.<br><br>Your support ID is: 0000000000000000000</body></html>';
const OUTAGE = '<!DOCTYPE html><html lang="cs"><head><title>APIS</title></head><body><div class="main"><p>Vážení zákaznici,</p>'
  + '<p>s politováním musíme informovat, že nastal problém se systémem APIS.</p></div></body></html>';

describe('TOPTRANS tracking adapter', () => {
  it('reads a delivered shipment newest first, dating every scan in Prague', () => {
    const result = normalizeCarrierResult(parseToptrans(delivered, DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Zásilka doručena', last_update: '2026-01-14T10:42:00+01:00', expected_delivery: null,
      delivered_at: '2026-01-14T10:42:00+01:00', weight_kg: 41.75 });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.events!.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-01-14T10:42:00+01:00', 'Příkladov', 'Zásilka doručena', 'delivered'],
      ['2026-01-14T08:05:00+01:00', 'Příkladov', 'Zásilka se rozváží', 'out_for_delivery'],
      ['2026-01-13T16:55:00+01:00', 'Příkladov', 'Zásilka je na rozvozovém středisku', 'in_transit'],
      ['2026-01-13T08:30:00+01:00', 'Příkladov', 'Zásilka se rozváží', 'out_for_delivery'],
      ['2026-01-13T05:12:00+01:00', 'Příkladov', 'Zásilka je na rozvozovém středisku', 'in_transit'],
      ['2026-01-12T21:47:00+01:00', undefined, 'Zásilka odešla do cílového střediska', 'in_transit'],
      // Two scans in one minute: the later row is the newer.
      ['2026-01-12T14:03:00+01:00', 'Vzorovice', 'Zásilka svezena do skladu', 'accepted'],
      ['2026-01-12T14:03:00+01:00', 'Vzorovice', 'Přijata objednávka přepravy', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The drivers, their message, who took the shipment, the reference, the note and the cash on delivery stay out.
    expect(JSON.stringify(result)).not.toMatch(/Příklad \(|Vzorný|600000|Přijedu|Novákova|REF-EXAMPLE|Volat|1234\.50|901|902/);
  });

  it('reads a shipment in transit on the summer offset', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(transit));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Zásilka je na rozvozovém středisku',
      last_update: '2026-06-11T06:15:00+02:00', weight_kg: 7 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.stage])).toEqual([
      ['2026-06-11T06:15:00+02:00', 'Modelová', 'in_transit'],
      ['2026-06-10T22:58:00+02:00', null, 'in_transit'],
      ['2026-06-10T19:41:00+02:00', 'Ukázkov', 'accepted'],
      ['2026-06-10T15:20:00+02:00', 'Ukázkov', 'registered'],
    ]);
  });

  it('reads the repeated hour when the clocks go back as its first occurrence', () => {
    const result = parseToptrans(scans([['901 - Vzorovice', '25.10.26 02:30 - Zásilka svezena do skladu']]), DELIVERED);
    expect(result.events![0]!.time).toBe('2026-10-25T02:30:00+02:00');
  });

  it('binds a piece number to the shipment whose run of pieces holds it', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    for (const piece of [FIRST_PIECE, MIDDLE_PIECE, '1230000000103']) {
      expect(await carrier(fetcher).track({ number: piece }), piece).toMatchObject({ status: 'delivered', canonical_tracking_number: DELIVERED });
    }
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([pieceUrl(FIRST_PIECE), pieceUrl(MIDDLE_PIECE), pieceUrl('1230000000103')]);
    // A ten-digit piece number.
    const label = field('Číslo kusů do', '9010000001', field('Číslo kusů od', '9010000001'));
    expect(parseToptrans(label, '9010000001')).toMatchObject({ canonical_tracking_number: DELIVERED });
    for (const [body, piece] of [[delivered, '1230000000104'], [delivered, '1230000000100'], [field('Kusů', '2'), MIDDLE_PIECE],
      [field('Kusů', ''), MIDDLE_PIECE], [delivered, '9010000001'], [field('Číslo kusů od', ''), MIDDLE_PIECE]] as const) {
      expect(() => parseToptrans(body, piece), piece).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('binds a shipment number to the shipment the page names', () => {
    expect(() => parseToptrans(delivered, IN_TRANSIT)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseToptrans(delivered, FIRST_PIECE.slice(0, 11))).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseToptrans(field('Číslo př.listu', ''), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reports a shipment absent only on the service\'s notice', () => {
    expect(() => parseToptrans(absent, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseToptrans(absent, FIRST_PIECE)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const withShipment = edit(($) => $('tbody').first().append('<tr><th colspan="2">Zásilka nenalezena</th></tr>'));
    expect(() => parseToptrans(withShipment, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const renamed = edit(($) => $('th[colspan]').text('Zásilka nedostupná'), absent);
    expect(() => parseToptrans(renamed, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the page\'s status for a shipment without scans', () => {
    const bare = scans([], field('Stav zásilky', 'Přijata objednávka přepravy'));
    expect(parseToptrans(bare, DELIVERED)).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Přijata objednávka přepravy',
      last_update: null, summary_only: true, events: [] });
    expect(() => parseToptrans(scans([], field('Stav zásilky', '')), DELIVERED)).toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('tells a browser check and an outage notice from a changed page', () => {
    expect(() => parseToptrans(REJECTED, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseToptrans('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseToptrans(OUTAGE, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'maintenance' }));
    for (const body of ['', '<html><body><p>Vyhledávání zásilek</p></body></html>', `${delivered}${delivered}`,
      edit(($) => $('table').removeClass('default-table'))]) {
      expect(() => parseToptrans(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects malformed scans and fields', () => {
    for (const body of [scans([['901 - Vzorovice', '30.02.26 10:00 - Zásilka doručena']]), scans([['901 - Vzorovice', '12.01.26 25:00 - Zásilka doručena']]),
      scans([['901 - Vzorovice', '2026-01-12 10:00 - Zásilka doručena']]), scans([['901 - Vzorovice', '12.01.26 10:00 - ']]),
      edit(($) => $('tr').last().append('<td>extra</td>')), edit(($) => $('tbody').first().append('<tr><th>Kusů</th><td>3</td></tr>'))]) {
      expect(() => parseToptrans(body, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const long = Array.from({ length: 301 }, (_, index) => ['901 - Vzorovice',
      `12.01.26 ${String(Math.floor(index / 60) % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')} - Zásilka je na rozvozovém středisku`] as [string, string]);
    expect(() => parseToptrans(scans(long), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(parseToptrans(scans(long.slice(0, 250)), DELIVERED)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseToptrans(scans(long.slice(0, 250)), DELIVERED).events).toHaveLength(200);
    // A weight the page leaves out or garbles is not kept.
    expect(parseToptrans(field('Hmotnost kg', ''), DELIVERED)).not.toHaveProperty('weight_kg');
    expect(parseToptrans(field('Hmotnost kg', '12 kg'), DELIVERED)).not.toHaveProperty('weight_kg');
  });

  it('takes eleven-digit shipment numbers and ten- or thirteen-digit piece numbers', () => {
    expect(normalizeToptransNumber(' 123 0000 0045 ')).toEqual({ number: DELIVERED, kind: 'shipment' });
    expect(normalizeToptransNumber(FIRST_PIECE)).toEqual({ number: FIRST_PIECE, kind: 'piece' });
    expect(normalizeToptransNumber('9010000001')).toEqual({ number: '9010000001', kind: 'piece' });
    for (const number of ['', '123456789', '123000000450', '12300000004500', 'A2300000045', 'BO2620000', '1'.repeat(70)]) {
      expect(() => normalizeToptransNumber(number), number).toThrow(InvalidInputError);
    }
    expect(toptransTrackingUrl(normalizeToptransNumber(DELIVERED))).toBe(shipmentUrl(DELIVERED));
    expect(toptransTrackingUrl(normalizeToptransNumber(FIRST_PIECE))).toBe(pieceUrl(FIRST_PIECE));
  });

  it('maps every recorded status, and the status map answers by wording alone', () => {
    for (const entry of statuses.entries) {
      expect(toptransStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'toptrans', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'toptrans', providerCode: 'X', description: 'Zásilka doručena' })).toEqual({ kind: 'unknown' });
    expect(toptransStage('Zásilka teleportována')).toBeNull();
  });

  it('opens the tracking service from its links', () => {
    expect(parseTrackingInput(shipmentUrl(DELIVERED))).toMatchObject({ trackingNumber: DELIVERED, carrier: 'toptrans', source: 'link' });
    expect(parseTrackingInput(pieceUrl(FIRST_PIECE))).toMatchObject({ trackingNumber: FIRST_PIECE, carrier: 'toptrans', source: 'link' });
  });

  it('asks the service once for the whole number, through the supplied transport and without a session', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ToptransTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${DELIVERED} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(shipmentUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'toptrans', step: 'direct', outcome: 'ok' }));
    await expect(carrier(fetcher).track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('keeps the HTTP failure taxonomy', async () => {
    const answers = [[absent, 200, 'not_found'], [REJECTED, 200, 'challenge'], ['', 302, 'transport'], ['', 404, 'transport'],
      ['', 403, 'challenge'], ['', 429, 'rate_limited'], [OUTAGE, 503, 'maintenance'], ['', 500, 'indeterminate'],
      ['<html>Service unavailable</html>', 200, 'schema']] as const;
    for (const [body, status, kind] of answers) {
      const fetcher = vi.fn(async () => reply(body, status, status === 302 ? { Location: '/search' } : {})) as unknown as typeof fetch;
      await expect(new ToptransTracker({ fetcher }).fetch(DELIVERED), `${status}`).rejects.toMatchObject({ kind });
    }
    const large = vi.fn(async () => new Response(new Uint8Array(600_000))) as unknown as typeof fetch;
    await expect(new ToptransTracker({ fetcher: large }).fetch(DELIVERED)).rejects.toThrow('unexpectedly large');
  });

  it('asks once more after a failed connection, and only then', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    expect(await new ToptransTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(DELIVERED)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(new ToptransTracker({ fetcher: down as unknown as typeof fetch }).fetch(DELIVERED)).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(down).toHaveBeenCalledTimes(2);
    const missing = vi.fn(async () => reply(absent));
    await expect(new ToptransTracker({ fetcher: missing as unknown as typeof fetch }).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new ToptransTracker({ fetcher: immediate }).fetch(DELIVERED, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new ToptransTracker({ fetcher: immediate }).fetch(DELIVERED, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new ToptransTracker({ fetcher: slow }).fetch(DELIVERED, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, MakatiExpressTracker } from './adapter.js';
import { normalizeMakatiExpressNumber, parseMakatiExpress } from './parser.js';
import { makatiExpressMappedStage, makatiExpressStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const AIR = 'DOH00000000';
const BOX = 'DXB0000000';
const UNKNOWN = 'TAI0000000';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.html');
const transit = fixture('in-transit.html');
const missing = fixture('not-found.html');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => { const $ = load(body); change($); return $.html(); };
const progress = ($: ReturnType<typeof load>) => $('td').filter((_, node) => $(node).text().trim() === 'Activity').closest('table');
const row = (index: number, day: string, activity: string, note = '') => `<tr><td>${index}</td><td>${day}</td><td>${activity}</td><td>${note}</td></tr>`;
/** The delivered page with these rows under its progress table's header. */
const history = (...rows: string[]) => edit(($) => { const table = progress($); table.find('tr').slice(1).remove(); table.find('tr').first().after(rows.join('')); });
const reply = (body = delivered, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('Makati Express direct tracking', () => {
  it('reads a delivered air cargo from an older branch page, without the people and notes', () => {
    const result = normalizeCarrierResult(parseMakatiExpress(delivered, AIR));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-03-08', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2026-03-08', description: 'DELIVERED', stage: 'delivered', stage_source: 'carrier_map', tie_order: 1 },
      { local_time: '2026-03-08', description: 'OUT FOR DELIVERY', stage: 'out_for_delivery', stage_source: 'carrier_map', tie_order: 0 },
      { local_time: '2026-03-05', description: 'RECEIVED BY MAKATI EXPRESS CARGO (Cavite Office)', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-03', description: 'DEPARTURE DATE', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-02', description: 'SHIPMENT HANDED OVER TO THE AIRLINES', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|0000 000|FROM DOHA|2026-03-01|delivered_at|receiver|sender/i);
  });

  it('reads a box on its way from the newer branch page, without forecasts, repeats or office notes', () => {
    const result = normalizeCarrierResult(parseMakatiExpress(transit, BOX));
    // The summary's status is a forecast; the stage comes from the rows.
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'ACTUAL DEPARTURE',
      last_update: null, last_update_local: '2026-03-15' });
    expect(result.events?.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-03-15', 'ACTUAL DEPARTURE', 'in_transit'],
      ['2026-03-11', 'CONTAINER HANDED OVER TO JEBEL ALI PORT', 'in_transit'],
      ['2026-03-10', 'DOCUMENTATION DONE/AWAITING SHIPMENT LOADING', 'in_transit'],
      ['2026-03-09', 'AWB DOCUMENTATION', 'in_transit'],
      ['2026-03-07', 'BOX PICKUP/MOVED TO WAREHOUSE', 'in_transit'],
      ['2026-03-05', 'SHIPMENT LOADED IN THE CONTAINER', 'in_transit'],
      ['2026-03-02', 'SHIPMENT MOVED TO MAKATI HUB', 'accepted'],
      ['2026-03-02', 'AWB CREATED', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|ESTIMATED|EXPECTED|2026-04-20/);
    // A box only just booked is registered.
    const booked = parseMakatiExpress(edit(($) => progress($).find('tr').slice(2).remove(), transit), BOX);
    expect(booked).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'AWB CREATED' });
  });

  it('turns a newest-first table round, drops phone numbers and who took the box, and leaves unknown activities unstaged', () => {
    const result = parseMakatiExpress(history(row(3, '2026-03-08', 'BOX DELIVERED TO SAMPLE RECEIVER 0917 000 0000'),
      row(2, '2026-03-07', 'CALL 0917 000 0000 FOR DELIVERY'), row(1, '2026-03-06', 'BOX INSPECTED')), AIR);
    expect(result.events?.map((event) => [event.local_time, event.description, event.stage, event.stage_source])).toEqual([
      ['2026-03-08', 'BOX DELIVERED', 'delivered', 'carrier_map'],
      ['2026-03-07', 'CALL FOR DELIVERY', undefined, undefined],
      ['2026-03-06', 'BOX INSPECTED', undefined, undefined],
    ]);
    // An unmapped activity leaves the stage to the rows before it, and the shared rules can stage one.
    const noted = parseMakatiExpress(history(row(1, '2026-03-06', 'SHIPMENT LOADED IN THE CONTAINER'), row(2, '2026-03-07', 'BOX INSPECTED')), AIR);
    expect(noted).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'BOX INSPECTED', last_update_local: '2026-03-07' });
    const worded = parseMakatiExpress(history(row(1, '2026-03-06', 'ARRIVED AT MANILA WAREHOUSE')), AIR);
    expect(worded.events?.[0]).toMatchObject({ stage: 'in_transit', stage_source: expect.stringMatching(/^wording:/) });
  });

  it('reports a booking without rows by its status alone', () => {
    const bare = edit(($) => { progress($).closest('tr').prev('tr').remove(); progress($).closest('tr').remove(); });
    expect(parseMakatiExpress(bare, AIR)).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    const forecasts = history(row(1, '2026-03-14', 'ESTIMATED DEPARTURE'));
    const estimated = edit(($) => $('td').filter((_, node) => $(node).text().trim() === 'Status').next('td').text('ESTIMATED DEPARTURE'), forecasts);
    expect(() => parseMakatiExpress(estimated, AIR)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const blank = edit(($) => $('td').filter((_, node) => $(node).text().trim() === 'Status').next('td').text(' '), bare);
    expect(() => parseMakatiExpress(blank, AIR)).toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('binds the answer to the whole AWB, in any case', () => {
    expect(parseMakatiExpress(delivered, ' doh 0000 0000 ').status).toBe('delivered');
    expect(parseMakatiExpress(edit(($) => $('b').first().text('doh00000000')), AIR).status).toBe('delivered');
    for (const asked of ['DOH00000001', 'DXB00000000', 'DOH0000000']) {
      expect(() => parseMakatiExpress(delivered, asked), asked).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseMakatiExpress(missing, 'TAI0000001')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = edit(($) => { const label = $('td').filter((_, node) => $(node).text().trim() === 'AWB No.').closest('tr'); label.after(label.clone()); });
    expect(() => parseMakatiExpress(twice, AIR)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the tracker\'s notice as not found and a bot check as a challenge', () => {
    expect(() => parseMakatiExpress(missing, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMakatiExpress(missing.replace(UNKNOWN, UNKNOWN.toLowerCase()), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const body of ['<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><body><h1>SpamFireWall is checking your browser</h1></body></html>',
      '<html><head><title>Sucuri WebSite Firewall - Access Denied</title></head><body>Access Denied</body></html>']) {
      expect(() => parseMakatiExpress(body, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('rejects a malformed page and bounds the history', () => {
    for (const body of ['<html><body><p>Makati Express Cargo</p></body></html>', '', missing.replace('Data not found', 'Something else'),
      history(row(1, '2026-02-31', 'DELIVERED')), history(row(1, '2026/03/08', 'DELIVERED')), history(row(1, '', 'DELIVERED')),
      history(row(1, '1970-01-01', 'DELIVERED')), history(row(1, '08-March-2026, Monday', 'DELIVERED')), history(row(1, '08-Marzo-2026', 'DELIVERED')),
      history(row(1, '2026-03-08', '')), history(row(1, '2026-03-08', '0917 000 0000')), history(row(1, '2026-03-08', 'DELIVERED').replace('<td>1</td>', '<td>first</td>')),
      history('<tr><td>1</td><td>2026-03-08</td><td>DELIVERED</td></tr>'),
      edit(($) => progress($).clone().insertAfter(progress($))),
      history(...Array.from({ length: 501 }, (_, index) => row(index + 1, '2026-03-08', 'AWB DOCUMENTATION')))]) {
      expect(() => parseMakatiExpress(body, body.includes(UNKNOWN) ? UNKNOWN : AIR)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // A table whose header changed is not the progress table, though the page heads one.
    expect(() => parseMakatiExpress(edit(($) => progress($).find('td').filter((_, node) => $(node).text() === 'Date').text('Day')), AIR))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    const long = history(...Array.from({ length: 150 }, (_, index) =>
      row(index + 1, `2026-${String(1 + Math.floor(index / 28)).padStart(2, '0')}-${String(1 + index % 28).padStart(2, '0')}`, `AWB DOCUMENTATION ${index}`)));
    const result = parseMakatiExpress(long, AIR);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-06-10', last_status_text: 'AWB DOCUMENTATION 149' });
  });

  it('takes branch-coded AWBs only', () => {
    expect(normalizeMakatiExpressNumber(' dxb-000 0000 ')).toBe(BOX);
    expect(normalizeMakatiExpressNumber(AIR)).toBe(AIR);
    for (const number of ['', '0000000', '00000000', 'DX0000000', 'DXBA0000000', 'DXB00000', 'DXB0000000000', 'DXB000000A', '0'.repeat(65)]) {
      expect(() => normalizeMakatiExpressNumber(number), number).toThrow(InvalidInputError);
    }
  });

  it('maps every recorded wording, and the status map answers as the parser stages', () => {
    for (const { stage, wording, unmapped } of statuses.entries as { stage?: string; wording: string; unmapped?: boolean }[]) {
      expect(makatiExpressMappedStage(wording), wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'makati-express', providerCode: null, description: wording }), wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'unknown' });
      // A forecast never reaches the events.
      if (unmapped) expect(parseMakatiExpress(history(row(1, '2026-03-14', wording), row(2, '2026-03-15', 'ACTUAL DEPARTURE')), AIR).events).toHaveLength(1);
    }
    expect(makatiExpressMappedStage('received by makati express cargo (cavite office)')).toBe('in_transit');
    expect(makatiExpressStage('BOX INSPECTED')).toBeNull();
    for (const wording of ['constructor', 'toString']) expect(makatiExpressMappedStage(wording), wording).toBeUndefined();
  });

  it('suggests the carrier for its branch codes beside Australia Post', () => {
    expect(detectCarrierMatch(BOX).candidates).toEqual(expect.arrayContaining(['makati-express', 'australia-post']));
    expect(detectCarrierMatch(AIR).candidates).toContain('makati-express');
    expect(detectCarrierMatch('ABC0000000').candidates).not.toContain('makati-express');
  });

  it('posts the AWB as the page\'s form does, with the host User-Agent and the caller signal', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const instance = adapter({ ...environment(fetcher), userAgent: 'SyntheticAgent/1.0' });
    expect(await instance.track({ number: ' doh00000000 ' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://makati-express.com/tracking/');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: 'awbnumber=DOH00000000&Submittrackwidget=Check' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('SyntheticAgent/1.0');
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    await expect(instance.track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recognizes a known AWB and not an unknown one', async () => {
    const known = adapter(environment(vi.fn<typeof fetch>(async () => reply())));
    expect(await known.recognize!(AIR)).toMatchObject({ known: true });
    const unknown = adapter(environment(vi.fn<typeof fetch>(async () => reply(missing))));
    expect(await unknown.recognize!(UNKNOWN)).toMatchObject({ known: false });
    const untouched = vi.fn<typeof fetch>(async () => reply());
    expect(await adapter(environment(untouched)).recognize!('12345')).toEqual({ known: false });
    expect(untouched).not.toHaveBeenCalled();
    await expect(adapter(environment(vi.fn<typeof fetch>(async () => reply('', 429)))).recognize!(AIR)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('keeps the HTTP failure taxonomy', async () => {
    for (const [response, kind] of [[() => reply(missing.replace(UNKNOWN, BOX)), 'not_found'], [() => reply(transit), 'ok'],
      [() => reply(delivered.replaceAll(AIR, 'DXB0000001')), 'indeterminate'],
      [() => reply(delivered, 406), 'challenge'], [() => reply('', 403), 'challenge'], [() => reply('', 429), 'rate_limited'],
      [() => reply('', 302, { Location: 'https://makati-express.com/' }), 'transport'], [() => reply('', 404), 'transport'],
      [() => reply('', 410), 'transport'], [() => reply('', 503), 'maintenance'], [() => reply('<html><body>Error</body></html>', 500), 'indeterminate'],
      [() => reply('{"error":"changed"}', 200, { 'Content-Type': 'application/json' }), 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>(async () => response());
      const lookup = new MakatiExpressTracker({ fetcher }).fetch(BOX);
      if (kind === 'ok') expect(await lookup).toMatchObject({ status: 'in_transit' });
      else await expect(lookup, kind).rejects.toMatchObject({ kind });
      expect(fetcher, kind).toHaveBeenCalledTimes(1);
    }
    const large = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(1_100_000)));
    await expect(new MakatiExpressTracker({ fetcher: large }).fetch(BOX)).rejects.toThrow('unexpectedly large');
  });

  it('gives the single read the whole budget and honors cancellation', async () => {
    const immediate = vi.fn<typeof fetch>(async () => reply());
    await expect(new MakatiExpressTracker({ fetcher: immediate }).fetch(AIR, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new MakatiExpressTracker({ fetcher: immediate }).fetch(AIR, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const failing = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed'); });
    await expect(new MakatiExpressTracker({ fetcher: failing }).fetch(AIR)).rejects.toMatchObject({ kind: 'transport' });
    expect(failing).toHaveBeenCalledTimes(1);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new MakatiExpressTracker({ fetcher: slow }).fetch(AIR, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

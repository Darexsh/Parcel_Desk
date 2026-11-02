import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CORRE_TRACKER, correLookupUrl, CorreTracker } from './adapter.js';
import { normalizeCorreNumber, parseCorre } from './parser.js';
import { correMappedStage, correStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const RECEIVED = 'EE900000019MZ';
const HISTORY = 'EN900000022MZ';
const OTHER = 'EN900000036MZ';
const UNKNOWN = 'ZZ900000040MZ';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const tables = (html: string) => html.match(/<table[\s\S]*?<\/table>/g)!;
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('CORRE tracking adapter', () => {
  it('asks the national lookup for the whole code once, as the Track & Trace page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('received')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CorreTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ee 900 000 019 mz ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(correLookupUrl(RECEIVED));
    expect(String(url)).toBe(`https://www.corremz.com/cgi-bin/tracktrace.cgi?OBJ=${RECEIVED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'corre', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the waybill taken in at a counter with its wall clock, and keeps neither the counter, the clerk nor the waybill’s scan', () => {
    const result = parseCorre(text('received'), RECEIVED);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: 'GUIA RECEBIDA',
      last_update: null, last_update_local: '2026-03-11T09:14:00', expected_delivery: null,
      events: [{ local_time: '2026-03-11T09:14:00', description: 'GUIA RECEBIDA', stage: 'accepted', stage_source: 'carrier_map' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/co_amostra|AMOSTRA|guias|jpg|1234/);
  });

  it('reads several records newest first, staging wording it does not know through the shared rules', () => {
    const result = parseCorre(text('history'), HISTORY);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'OBJECTO ENTREGUE',
      last_update: null, last_update_local: '2026-05-06T11:02:00' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-05-06T11:02:00', 'OBJECTO ENTREGUE', 'delivered'],
      ['2026-05-04T16:30:00', 'OBJECTO EXPEDIDO', 'in_transit'],
      ['2026-05-04T08:47:00', 'GUIA RECEBIDA', 'accepted'],
    ]);
    expect(result.events!.slice(0, 2).every((event) => String(event.stage_source).startsWith('wording:'))).toBe(true);
    // No record gets an instant, and none keeps a counter or a login.
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/co_amostra|AMOSTRA|EXEMPLO|MODELO/);
  });

  it('reads an item between counters as in transit, turns a page oldest last round and keeps a repeated record once', () => {
    const page = text('history');
    const [received, sent, delivered] = tables(page) as [string, string, string];
    const inTransit = parseCorre(page.replace(delivered, ''), HISTORY);
    expect(inTransit).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'OBJECTO EXPEDIDO' });
    expect(inTransit.events).toHaveLength(2);
    const reversed = parseCorre(page.replace(received, '#1').replace(delivered, received).replace('#1', delivered), HISTORY);
    expect(reversed.events).toEqual(parseCorre(page, HISTORY).events);
    expect(parseCorre(page.replace(sent, `${sent}<br>${sent}`), HISTORY).events).toHaveLength(3);
    // A record whose wording no rule stages keeps the newest staged record's stage.
    const unstaged = parseCorre(page.replace(delivered, delivered.replace('OBJECTO ENTREGUE', 'Registo de amostra')), HISTORY);
    expect(unstaged).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Registo de amostra',
      last_update_local: '2026-05-06T11:02:00' });
    expect(unstaged.events![0]).toEqual({ local_time: '2026-05-06T11:02:00', description: 'Registo de amostra' });
  });

  it('keeps records of one clock in the page’s order', () => {
    const page = text('history').replace('202605041630', '202605061102');
    expect(parseCorre(page, HISTORY).events!.map((event) => event.description)).toEqual(['OBJECTO ENTREGUE', 'OBJECTO EXPEDIDO', 'GUIA RECEBIDA']);
  });

  it('reads a search that listed nothing as not found, and a record for another code as inconclusive', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseCorre(text('received'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CORRE answered for a different item' }));
    expect(() => parseCorre(text('history'), RECEIVED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = text('history').replace(`<td>OBJECTO EXPEDIDO</td>\n<td>${HISTORY}</td>`, `<td>OBJECTO EXPEDIDO</td>\n<td>${OTHER}</td>`);
    expect(() => parseCorre(mixed, HISTORY)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseCorre(text('received').replace(`<td>${RECEIVED}</td>`, '<td> ee900000019mz </td>'), RECEIVED).events).toHaveLength(1);
  });

  it('reads the lookup’s length refusal as invalid input, a firewall page as a challenge and other pages as changed', async () => {
    const lookup = (body: BodyInit, status = 200) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status))).track({ number: RECEIVED });
    await expect(lookup(text('wrong-length'))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    // The frame without a record or the search's closing line is no answer about the item.
    await expect(lookup(text('not-found').replace(/A pesquisa demorou \d+ milisegundos/, ''))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('rejects records of a changed shape', () => {
    const page = text('received');
    for (const [index, changed] of [
      page.replace('<td>DATA</td>\n<td>202603110914</td>\n</tr>\n', ''),
      page.replace('<td>USER</td>\n<td>AMOSTRA.USER</td>\n', '<td>USER</td>\n'),
      page.replace('<td>GUIA RECEBIDA</td>', '<td> </td>'),
      page.replace(/<td>DATA<\/td>[\s\S]*<td>AMOSTRA\.USER<\/td>\n<\/tr>\n/, ''),
      page.replace(/<table[\s\S]*<\/table>/, '<table></table>'),
      page.replace('202603110914', '11/03/2026 09:14'),
      page.replace('202603110914', '20260311091'),
      page.replace('202603110914', '202602300914'),
      page.replace('202603110914', '202603112400'),
      page.replace('202603110914', '202603110960'),
      page.replace('<title>Track & Trace de objetos CORRE</title>', '<title>Sample</title>'),
      page.replace(/<table[\s\S]*<\/table>/, (table) => table.repeat(201)),
    ].entries()) {
      expect(changed, String(index)).not.toBe(page);
      expect(() => parseCorre(changed, RECEIVED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A labelled cell the parser does not read is left out.
    const extra = page.replace('<td>NO</td>', '<td>EXTRA</td>\n<td>Amostra</td>\n</tr>\n<td>NO</td>');
    expect(parseCorre(extra, RECEIVED).events).toEqual(parseCorre(page, RECEIVED).events);
    expect(JSON.stringify(parseCorre(extra, RECEIVED))).not.toMatch(/Amostra|EXTRA/);
  });

  it('reads a page in the site’s windows-1252 as well as in UTF-8', async () => {
    const wording = 'Objecto em trânsito';
    const page = text('received').replace('GUIA RECEBIDA', wording);
    const latin = Uint8Array.from(page, (character) => character.charCodeAt(0));
    const fromLatin = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(latin))).track({ number: RECEIVED });
    const fromUtf8 = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page))).track({ number: RECEIVED });
    expect(fromLatin.events![0]).toMatchObject({ description: wording });
    expect(fromUtf8.events).toEqual(fromLatin.events);
  });

  it('takes CORRE’s own S10 codes with a valid check digit, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['EE900000010MZ', 'EE90000001MZ', 'EE900000019MZX', 'LX900000075CN', 'RR900000053ZA', '1234567890123',
      'SAMPLETRACKING', `EE${'0'.repeat(70)}MZ`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCorreNumber(' ee-900-000-019 mz ')).toBe(RECEIVED);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('received'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(RECEIVED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-11T09:14:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const changed = vi.fn<typeof fetch>().mockResolvedValue(reply('<html><body>Sample</body></html>'));
    await expect(carrier(changed).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: RECEIVED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(RECEIVED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [404, 'transport'], [410, 'transport'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: RECEIVED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(RECEIVED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('received')));
    await expect(carrier(flaky).track({ number: RECEIVED })).resolves.toMatchObject({ current_stage: 'accepted' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('received')));
    await expect(carrier(immediate).track({ number: RECEIVED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: RECEIVED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: RECEIVED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: RECEIVED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under CORRE to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('received')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: RECEIVED, carrier: 'corre' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'corre', source: 'corre', result: { current_stage: 'accepted' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(CORRE_TRACKER))).toBe(true);
  });

  it('leaves Mozambican S10 codes with the postal fallback, which asks it first, and reads the lookup’s links', () => {
    expect(detectCarrierMatch(RECEIVED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(RECEIVED)[0]).toBe('corre');
    for (const path of ['tracktrace', 'trace']) {
      expect(parseTrackingInput(`https://www.corremz.com/cgi-bin/${path}.cgi?OBJ=${RECEIVED}`))
        .toMatchObject({ trackingNumber: RECEIVED, carrier: 'corre', source: 'link' });
    }
  });
});

describe('CORRE status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(correMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'corre', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(correStage('  guia   Recebida ')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(correStage('Registo de amostra')).toBeNull();
    for (const wording of ['constructor', 'toString', 'Registo de amostra']) expect(correMappedStage(wording), wording).toBeUndefined();
  });
});

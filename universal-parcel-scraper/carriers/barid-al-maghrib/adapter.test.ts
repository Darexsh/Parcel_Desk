import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BARID_AL_MAGHRIB_DETAIL, BARID_AL_MAGHRIB_LOOKUP, BaridAlMaghribTracker } from './adapter.js';
import { baridAlMaghribSummaryKnows, normalizeBaridAlMaghribNumber, parseBaridAlMaghrib } from './parser.js';
import { baridAlMaghribStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'RB300000009FR';
const IN_TRANSIT = 'CP100000003MA';
const UNKNOWN = 'RR500000004MA';
const WITHOUT_HISTORY = 'EE200000006MA';
const SEARCH_PAGE = '/bamb2cstorefront/fr/tracking/page';
const PRIVATE = /EXEMPLE DESTINATAIRE|RUE DE L EXEMPLE|0600000000|150\.00|COURRIER|COLIS\b|France/;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
/** The page with a change made through cheerio. */
const edited = (name: string, edit: ($: CheerioAPI) => void) => {
  const $ = load(fixture(name));
  edit($);
  return $.html();
};
const detailUrl = (number: string) => `${BARID_AL_MAGHRIB_DETAIL}?code=${number}`;
const lookupUrl = (number: string) => `${BARID_AL_MAGHRIB_LOOKUP}?trackingCode=${number}`;
const redirect = (location = SEARCH_PAGE, status = 302) => new Response(null, { status, headers: { Location: location } });
/** The detail page's answer, then the lookup's when the page sends the number back to the search form. */
const site = (detail: () => Response, lookup: () => Response = () => new Response('{}')) => vi.fn<typeof fetch>()
  .mockImplementation(async (input) => (String(input).startsWith(BARID_AL_MAGHRIB_LOOKUP) ? lookup() : detail()));
const page = (name: string) => site(() => new Response(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = ($: CheerioAPI) => $('#tracking-table-detail-body');

describe('Barid Al-Maghrib tracking page', () => {
  it('opens the detail page of the code through the supplied transport', async () => {
    const fetcher = page('in-transit.html');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BaridAlMaghribTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cp 100-000.003 ma ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-07-03' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(detailUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/html' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'barid-al-maghrib', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates each scan to its day, keeps its clock as printed, and drops the item’s kind, amount, origin and phone', () => {
    const result = parseBaridAlMaghrib(fixture('delivered.html'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENVOI LIVRÉ', last_update: null, last_update_local: '2026-06-12', expected_delivery: null,
      weight_kg: 1.25, destination_country: 'MA' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.local_time, event.provider_time_text, event.location, event.description, event.stage]))
      .toEqual([
        ['2026-06-12', '12/06/2026 04:10:05', 'EXEMPLEVILLE CLD', 'ENVOI LIVRÉ', 'delivered'],
        ['2026-06-12', '12/06/2026 10:02:41', 'EXEMPLEVILLE CLD', 'ENVOI EN COURS DE LIVRAISON', 'out_for_delivery'],
        ['2026-06-12', '12/06/2026 07:15:30', 'EXEMPLEVILLE CLD', 'ENVOI ARRIVÉ À DESTINATION', 'in_transit'],
        ['2026-06-10', '10/06/2026 08:20:00', 'CNA', 'ENVOI ÉXPÉDIÉ', 'in_transit'],
        ['2026-06-10', '10/06/2026 11:45:12', 'EMS CI MAROC', 'ENVOI DÉDOUANÉ', 'in_transit'],
        ['2026-06-02', '02/06/2026 03:05:44', 'EMS CI MAROC', 'ENVOI SOUS DOUANE', 'customs'],
        ['2026-06-02', '02/06/2026 09:30:09', 'EMS CI MAROC', 'ENVOI REÇU AU MAROC', 'in_transit'],
        // A row the page lists twice is kept once.
        ['2026-05-28', '28/05/2026 05:40:00', 'FRXMPA', 'ENVOI ÉXPÉDIÉ', 'in_transit'],
        ['2026-05-28', '28/05/2026 02:10:00', 'FRXMPA', 'ENVOI ÉXPÉDIÉ', 'in_transit'],
        ['2026-05-28', '28/05/2026 01:55:00', 'FRXMPA', 'ENVOI REÇU POUR EXPORT', 'in_transit'],
        ['2026-05-28', '28/05/2026 01:20:00', 'FRXMPA', 'ENVOI PRIS EN CHARGE', 'accepted'],
      ]);
    // A twelve-hour clock without AM or PM is never read as an hour of the day.
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'barid-al-maghrib', steps: ['direct', 'retry'], recognition: { rank: 901 }, localClocks: true });
  });

  it('stages an item on its way, and keeps a domestic item’s cash-on-delivery amount and phone out', () => {
    const result = parseBaridAlMaghrib(fixture('in-transit.html'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'ENVOI ÉXPÉDIÉ',
      last_update_local: '2026-07-03', weight_kg: 0.8, destination_country: 'MA' });
    expect(result.events!.map((event) => [event.local_time, event.stage])).toEqual([
      ['2026-07-03', 'in_transit'], ['2026-07-02', 'in_transit'], ['2026-07-02', 'accepted']]);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('leaves out a weight, an arrival or a clock it cannot read, and a wording the map does not know to the shared rules', () => {
    const changed = parseBaridAlMaghrib(edited('in-transit.html', ($) => {
      $('.crbt-data').first().text('Sans');
      $('.crbt-title').filter((_, title) => /ARRIV/.test($(title).text())).siblings('.crbt-data').text('EXEMPLEVILLE');
      rows($).children('tr').eq(1).children('td').eq(1).text('');
      rows($).children('tr').eq(1).children('td').eq(3).text('SYNTHETIC NOTE');
    }), IN_TRANSIT);
    expect(changed).not.toHaveProperty('weight_kg');
    expect(changed).not.toHaveProperty('destination_country');
    expect(changed.events![0]).toEqual({ local_time: '2026-07-03', location: 'CTT EXEMPLEVILLE', description: 'SYNTHETIC NOTE' });
    expect(changed).toMatchObject({ current_stage: 'in_transit', last_status_text: 'SYNTHETIC NOTE' });
    const unstaged = parseBaridAlMaghrib(edited('in-transit.html', ($) => {
      rows($).children('tr').filter((_, row) => !$(row).children('td').first().text().trim())
        .children('td:nth-child(4)').text('SYNTHETIC NOTE');
    }), IN_TRANSIT);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'SYNTHETIC NOTE' });
    expect(unstaged).not.toHaveProperty('current_stage');
    expect(() => parseBaridAlMaghrib(edited('in-transit.html', ($) => { rows($).empty(); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts an item only when its page names the code asked', () => {
    expect(() => parseBaridAlMaghrib(fixture('in-transit.html'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Barid Al-Maghrib answered for a different item' }));
    expect(() => parseBaridAlMaghrib(edited('in-transit.html', ($) => { $('.title-tracking h3').text(`${IN_TRANSIT}1`); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseBaridAlMaghrib(edited('in-transit.html', ($) => { $('.title-tracking h3').text(' cp100000003ma '); }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed page', () => {
    const first = ($: CheerioAPI) => rows($).children('tr').first();
    for (const [name, change] of [
      ['no item', ($: CheerioAPI) => { $('.detail-tracking-body').remove(); }],
      ['two items', ($: CheerioAPI) => { $('body').append('<div class="detail-tracking-body"></div>'); }],
      ['no history', ($: CheerioAPI) => { rows($).removeAttr('id'); }],
      ['short row', ($: CheerioAPI) => { first($).children('td').last().remove(); }],
      ['ISO date', ($: CheerioAPI) => { first($).children('td').first().text('2026-07-03'); }],
      ['impossible date', ($: CheerioAPI) => { first($).children('td').first().text('31/06/2026'); }],
      ['date row with a scan', ($: CheerioAPI) => { first($).children('td').last().text('ENVOI ÉXPÉDIÉ'); }],
      ['scan before a date', ($: CheerioAPI) => { first($).remove(); }],
      ['scan without wording', ($: CheerioAPI) => { rows($).children('tr').eq(1).children('td').last().text(' '); }],
      ['too many rows', ($: CheerioAPI) => { rows($).append($.html(rows($).children('tr').eq(1)).repeat(500)); }],
    ] as const) {
      expect(() => parseBaridAlMaghrib(edited('in-transit.html', change), IN_TRANSIT), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBaridAlMaghrib('<html><body><p>Synthetic</p></body></html>', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('asks the form’s lookup about a code the page sends back to the search form, and reads its errors list as not found', async () => {
    const fetcher = site(() => redirect(), () => new Response(fixture('not-found.json')));
    await expect(new BaridAlMaghribTracker({ fetcher, userAgent: 'SyntheticHost/1.0' }).fetch(UNKNOWN))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([detailUrl(UNKNOWN), lookupUrl(UNKNOWN)]);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'X-Requested-With': 'XMLHttpRequest' } });
    // The site's own address for the form, written out in full.
    const absolute = site(() => redirect(`https://www.barid.ma${SEARCH_PAGE}`), () => new Response(fixture('not-found.json')));
    await expect(new BaridAlMaghribTracker({ fetcher: absolute }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps a code the lookup knows, or answers for another, apart from a missing item', async () => {
    const known = site(() => redirect(), () => new Response(fixture('known-summary.json')));
    await expect(new BaridAlMaghribTracker({ fetcher: known }).fetch(WITHOUT_HISTORY))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'Barid Al-Maghrib knows the item but did not open its history' });
    expect(baridAlMaghribSummaryKnows(JSON.parse(fixture('known-summary.json')), WITHOUT_HISTORY)).toBe(true);
    expect(baridAlMaghribSummaryKnows(JSON.parse(fixture('not-found.json')), UNKNOWN)).toBe(false);
    for (const [name, payload] of [
      ['another code', fixture('not-found.json')],
      ['no lists', '{"tracking":null,"errors":[]}'],
      ['an entry without its code', '{"tracking":[],"errors":[{"parcel":null}]}'],
      ['a list', '[]'],
    ] as const) {
      const fetcher = site(() => redirect(), () => new Response(payload));
      await expect(new BaridAlMaghribTracker({ fetcher }).fetch(DELIVERED), name).rejects.toMatchObject({ kind: 'schema' });
    }
    await expect(new BaridAlMaghribTracker({ fetcher: site(() => redirect(), () => new Response('<html>Synthetic</html>')) }).fetch(UNKNOWN))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps a firewall page, a moved page and HTTP refusals apart from a missing item', async () => {
    const track = (fetcher: typeof fetch) => new BaridAlMaghribTracker({ fetcher }).fetch(IN_TRANSIT);
    expect(() => parseBaridAlMaghrib(fixture('rejected.html'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(track(page('rejected.html'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(site(() => redirect(), () => new Response(fixture('rejected.html'))))).rejects.toMatchObject({ kind: 'challenge' });
    for (const [name, answer] of [
      ['home page', () => redirect('/bamb2cstorefront/fr/')],
      ['another site', () => redirect(`https://example.com${SEARCH_PAGE}`)],
      ['no address', () => new Response(null, { status: 302 })],
      ['404', () => new Response('<html>Synthetic</html>', { status: 404 })],
      ['410', () => new Response('', { status: 410 })],
    ] as const) {
      const moved = site(answer);
      await expect(track(moved), name).rejects.toMatchObject({ kind: 'transport' });
      expect(moved, name).toHaveBeenCalledOnce();
    }
    for (const status of [302, 404]) {
      const lookupMoved = site(() => redirect(), () => redirect('/', status));
      await expect(track(lookupMoved), String(status)).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = site(() => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const lookup = site(() => redirect(), () => new Response('', { status }));
      await expect(carrier(lookup).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
    });

  it('recognizes a known code and the not-found answer, and asks nothing about a code Barid Al-Maghrib cannot track', async () => {
    // A day alone dates the last activity without an instant.
    await expect(carrier(page('delivered.html')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-12T00:00:00' });
    await expect(carrier(site(() => redirect(), () => new Response(fixture('not-found.json')))).recognize!(UNKNOWN))
      .resolves.toEqual({ known: false });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('RR500000005MA')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => new Response(fixture('delivered.html')));
    await expect(new BaridAlMaghribTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other codes before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    // A failed check digit, other shapes, two codes the form would split and an oversized paste.
    for (const number of ['RR500000005MA', 'RR50000000MA', 'R500000004MA', '1234567890', `${UNKNOWN};${IN_TRANSIT}`, '', 'R'.repeat(65)]) {
      await expect(new BaridAlMaghribTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new BaridAlMaghribTracker({ fetcher: unused }).fetch(IN_TRANSIT, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    // A letter O typed for a zero in the serial.
    expect(normalizeBaridAlMaghribNumber('cp1OOOOOOO3ma')).toBe(IN_TRANSIT);
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new BaridAlMaghribTracker({ fetcher: hanging }).fetch(IN_TRANSIT, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(new BaridAlMaghribTracker({ fetcher: site(() => new Response('x'.repeat(1_100_000))) }).fetch(IN_TRANSIT))
      .rejects.toThrow('unexpectedly large');
  });

  it('routes a code filed under Barid Al-Maghrib to the adapter', async () => {
    const fetcher = page('delivered.html');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'barid-al-maghrib' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'barid-al-maghrib', source: 'barid-al-maghrib', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === detailUrl(DELIVERED))).toBe(true);
  });
});

describe('Barid Al-Maghrib status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'barid-al-maghrib', providerCode: null, description: 'envoi livré' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'barid-al-maghrib', providerCode: null, description: 'synthetic note' })).toEqual({ kind: 'unknown' });
    expect(baridAlMaghribStage('SYNTHETIC NOTE')).toBeNull();
    expect(baridAlMaghribStage('ENVOI RETOURNÉ À L’EXPÉDITEUR')).toMatchObject({ stage: 'returned' });
  });
});

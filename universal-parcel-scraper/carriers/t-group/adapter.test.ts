import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, T_GROUP_TRACKER, TGroupTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeTGroupNumber, parseTGroup } from './parser.js';
import { statusMap, tGroupStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '3010TGR00000000000001';
const IN_TRANSIT = '3010TGR00000000000002';
const UNKNOWN = '3010TGR00000000000003';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, from: string | RegExp, to: string) => {
  const html = fixture(name);
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The ${name} fixture has no ${String(from)}`);
  return next;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
// The in-transit page's newest scan given another clock.
const newestAt = (clock: string) => changed('in-transit', '26/10/2026 09:10', clock);

describe('Tgroup HTTP adapter', () => {
  it('opens the tracker’s page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TGroupTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 3010tgr 0000 0000 0000 02 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${T_GROUP_TRACKER}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'it-IT,it', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 't-group', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment newest first on Rome’s winter clock, with its weight', () => {
    const result = parseTGroup(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Spedizione Consegnata', last_update: '2026-01-14T11:22:00+01:00', delivered_at: '2026-01-14T11:22:00+01:00',
      weight_kg: 12.4, expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2026-01-14T11:22:00+01:00', 'Spedizione Consegnata', 'VILLA SINTETICA', 'delivered'],
      // The delivery round's scan names no branch.
      ['2026-01-14T07:50:00+01:00', 'Affidata Al Giro Consegna', null, 'out_for_delivery'],
      // The repeated scan is kept once.
      ['2026-01-12T21:15:00+01:00', 'In Partenza Da Centro Smistamento', 'CENTRO PROVA', 'in_transit'],
      ['2026-01-12T11:40:00+01:00', 'Nuova Spedizione Creata', 'BORGO ESEMPIO', 'registered'],
      ['2026-01-12T08:05:00+01:00', 'Ritiro Assegnato Al Giro Di Distribuzione', 'BORGO ESEMPIO', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(result).not.toHaveProperty('last_update_local');
  });

  it('reads a shipment in transit with its planned delivery day, the repeated hour and scans of one minute', () => {
    const result = parseTGroup(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Prenotazione Telefonica Da Effettuare',
      last_update: '2026-10-26T09:10:00+01:00', expected_delivery: '2026-10-28', weight_kg: 3.25 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.description, event.location])).toEqual([
      ['2026-10-26T09:10:00+01:00', 'Prenotazione Telefonica Da Effettuare', 'CITTA ESEMPIO'],
      // The hour Rome's clocks repeat reads as its first occurrence.
      ['2026-10-25T02:30:00+02:00', 'In Partenza Da Centro Smistamento', 'CENTRO PROVA'],
      // Scans of one minute keep the page's order, the later one newer.
      ['2026-10-23T16:02:00+02:00', 'Ritiro Assegnato Al Giro Di Distribuzione', 'BORGO PROVA'],
      ['2026-10-23T16:02:00+02:00', 'Nuova Spedizione Creata', 'BORGO PROVA'],
    ]);
  });

  it('keeps a wall clock Rome skips as written', () => {
    const result = parseTGroup(newestAt('28/03/2027 02:30'), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2027-03-28T02:30:00' });
    expect(result.events![0]).toMatchObject({ local_time: '2027-03-28T02:30:00' });
    expect(result.events![0]).not.toHaveProperty('time');
    expect(parseTGroup(newestAt('29/03/2027 02:30'), IN_TRANSIT)).toMatchObject({ last_update: '2027-03-29T02:30:00+02:00' });
  });

  it('keeps no address, sender, delivery note or branch number, and no weight the page leaves at zero', () => {
    const result = parseTGroup(fixture('delivered'), DELIVERED);
    expect(JSON.stringify(result)).not.toMatch(/00001|00002|Borgo Esempio \(|Villa Sintetica \(|0000000000000000000001|901-0000001|PORTO|COLLI/);
    expect(parseTGroup(changed('delivered', '12,40 Kg', '0,00 Kg'), DELIVERED)).not.toHaveProperty('weight_kg');
    expect(parseTGroup(changed('in-transit', '28/10/2026', '31/02/2026'), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('stages a wording it does not know through the shared rules, or leaves it unstaged', () => {
    const worded = parseTGroup(changed('in-transit', 'Prenotazione Telefonica Da Effettuare', 'Pacco Consegnato Al Vicino'), IN_TRANSIT);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    expect(worded.events![0]).toMatchObject({ stage: 'delivered', stage_source: expect.not.stringMatching(/^carrier_map$/) });
    const unstaged = parseTGroup(changed('in-transit', 'Prenotazione Telefonica Da Effettuare', 'Nota Sintetica'), IN_TRANSIT);
    expect(unstaged).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Nota Sintetica', expected_delivery: '2026-10-28' });
    expect(unstaged.events![0]).not.toHaveProperty('stage');
  });

  it('reads the tracker’s notice as not found and a shipment without scans as no history', () => {
    expect(() => parseTGroup(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTGroup(changed('delivered', /<ul class="timeline">[\s\S]*?<\/ul>/, '<ul class="timeline"></ul>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads a page with several shipments as inconclusive, since the page does not repeat the number', () => {
    const page = fixture('delivered');
    const shipment = page.slice(page.indexOf('<div id="bodyContent">'), page.indexOf('<!--       <footer'));
    expect(() => parseTGroup(page.replace(shipment, `${shipment}${shipment}`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Tgroup answered for several shipments' }));
  });

  it('rejects a changed page', () => {
    for (const html of [
      '<html><title>Tgroup</title><body>Traccia la tua spedizione</body></html>',
      changed('delivered', 'id="tab_1"', 'id="tab_x"'),
      changed('delivered', '<strong>Dettaglio Merce</strong>', '<strong>Merce</strong>'),
      changed('delivered', '<strong>Dettaglio Spedizione</strong>', '<strong>Spedizione</strong>'),
      changed('delivered', '<strong>Destinatario</strong>', '<strong>Ricevente</strong>'),
      changed('delivered', '14/01/2026 11:22', '2026-01-14 11:22'),
      changed('delivered', '14/01/2026 11:22', '30/02/2026 11:22'),
      changed('delivered', '14/01/2026 11:22', '14/01/2026 24:22'),
      changed('delivered', '>Spedizione Consegnata<', '> <'),
      changed('delivered', /<div class="timeline-heading"/, '<div class="timeline-body"'),
      changed('delivered', '<div class="tab-content">', '<div class="tab-content"><center>NUMERO SPEDIZIONE NON TROVATO</center>'),
      fixture('delivered').replace(/<!-- \/\.timeline-label -->[\s\S]*?<!-- END timeline item -->/, (row) => row.repeat(201)),
    ]) {
      expect(() => parseTGroup(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a bot check, an empty page and a broken page apart', async () => {
    await expect(lookup(fixture('not-found'), {}, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker answers a number it does not know itself: a 404 or a redirect is a moved route.
    await expect(lookup('<html><title>Pagina non trovata</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.tgroupspa.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="g-recaptcha" data-sitekey="synthetic"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>Tgroup</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a read that did not reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a page over its size limit', async () => {
    await expect(lookup('x', { headers: { 'Content-Length': String(2_000_000) } })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects what is not a Tgroup number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['3010TGR0000000000001', '3010TGR000000000000001', '3011TGR00000000000001', '3010TGX00000000000001', '00000000000000', `3010TGR${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTGroupNumber('3010tgr-0000-0000-0000-02')).toBe(IN_TRANSIT);
  });

  it('recognizes a shipment the tracker shows and not a number it does not know', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(fixture(String(url).endsWith(UNKNOWN) ? 'not-found' : 'delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-14T10:22:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('routes a number filed under Tgroup to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 't-group' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 't-group', source: 't-group', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${T_GROUP_TRACKER}${DELIVERED}`)).toBe(true);
  });

  it('proposes no hand-off: the page names no other carrier or number', () => {
    expect(deliveryHandoff('t-group', DELIVERED, parseTGroup(fixture('delivered'), DELIVERED))).toBeNull();
  });
});

describe('Tgroup numbers', () => {
  it('accepts every public number, which its rule settles without recognition, and reads the tracker link', () => {
    for (const record of numbers.records) {
      expect(normalizeTGroupNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number), record.number).toMatchObject({ carrier: 't-group', confidence: 'high' });
      expect(recognitionCandidates(record.number), record.number).toEqual([]);
    }
    expect(parseTrackingInput(`https://track.tgroupspa.com/ttnet/traccia_spedizione/${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 't-group' });
  });
});

describe('Tgroup status vocabulary', () => {
  it('records every scan wording the map knows with the stage it gives', () => {
    expect(statuses.entries).toHaveLength(7);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(tGroupStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 't-group', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 't-group', description: 'Nota sintetica' })).toEqual({ kind: 'unknown' });
    expect(tGroupStage('Nota sintetica')).toBeNull();
  });
});

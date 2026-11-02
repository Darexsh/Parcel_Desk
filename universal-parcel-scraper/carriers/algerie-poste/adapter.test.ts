import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ALGERIE_POSTE_TRACKER, AlgeriePosteTracker } from './adapter.js';
import { normalizeAlgeriePosteNumber, parseAlgeriePoste } from './parser.js';
import { algeriePosteStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const INBOUND = 'ZZ000000014GB';
// Algérie Poste's own code, whose check digit fails as some of its EY codes' do.
const OWN = 'ZZ000000020DZ';
const UNKNOWN = 'ZZ000000045DZ';
const DOMESTIC = 'EC00000000001';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// One row of the timeline, as the page writes it.
const row = (date: string, wording: string, office: string) => `<div id="${date}" class="cd-timeline__block js-cd-block etat ${date}">
  <div class="cd-timeline__img cd-timeline__img--etape2 js-cd-img"><img src="https://ems.dz/track/img/delivery-package.png" alt="Picture"></div>
  <div class="cd-timeline__content js-cd-content"><h2>${wording}</h2><p>${office}</p><span class="cd-timeline__date">${date}</span></div>
</div>`;
// The unknown number's page with these rows in its timeline.
const withRows = (rows: string) => page('unknown').replace('<div class="cd-timeline__container">', `$&${rows}`);
const BLOCKED = '<!DOCTYPE html><html><head><title>Web Page Blocked</title></head><body>The page cannot be displayed. Attack ID: 20000000</body></html>';

describe('Algérie Poste tracking adapter', () => {
  it('asks the tracker for the whole number once, as its form does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('inbound-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AlgeriePosteTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 gb ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ALGERIE_POSTE_TRACKER}?icd=${INBOUND}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'algerie-poste', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an EMS item from abroad newest first, with each office\'s wall clock and the sending post\'s scans', () => {
    const result = parseAlgeriePoste(page('inbound-delivered'), INBOUND);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Distribué', last_update: null, last_update_local: '2026-05-14T11:20:00', expected_delivery: null,
      events: expect.any(Array) });
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-05-14T11:20:00', 'SAMPLE TOWN EMS', 'Distribué', 'delivered'],
      ['2026-05-13T10:05:00', 'SAMPLE TOWN EMS', 'Echec de Distribution', 'failed_attempt'],
      ['2026-05-13T08:40:00', 'SAMPLE TOWN EMS', 'En cours de Distribution', 'out_for_delivery'],
      ['2026-05-12T09:31:00', 'SAMPLE TOWN EMS', 'Arrivée au bureau de distribution', 'in_transit'],
      // The scan the page lists twice is kept once.
      ['2026-05-11T15:02:00', 'EMS Sample International Center', 'Expédier envoi à adresse nationale (Ent)', 'in_transit'],
      ['2026-05-11T09:47:00', 'EMS Sample International Center', 'Dédouanement effectué', 'in_transit'],
      ['2026-05-09T13:15:00', 'EMS Sample International Center', 'Présentation au service des Douanes', 'customs'],
      ['2026-05-09T12:58:00', 'EMS Sample International Center', 'Arrivée au pays de destination', 'in_transit'],
      ['2026-05-06T22:10:00', 'ZZSMPA', 'Départ vers le pays de destination', 'in_transit'],
      ['2026-05-06T17:45:00', 'ZZSMPB', 'Arrivée au centre d\'exportation', 'in_transit'],
      ['2026-05-06T16:30:00', 'ZZSMPB', 'Envoi déposé', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads an item on Algérie Poste\'s parcel network by its days, without its unnamed row\'s stage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('parcel-network')));
    const result = await carrier(fetcher).track({ number: OWN });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Entrée en transit', last_update_local: '2026-06-04' });
    expect(result.events).toEqual([
      { local_time: '2026-06-04', location: 'Guichet EMS SAMPLE', description: 'Entrée en transit', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-06-03', location: 'Agence EMS SAMPLE', description: 'En cours d\'acheminement', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-06-03', location: 'Agence EMS SAMPLE', description: 'Entrée en transit', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-06-02', location: 'Centre de Tri Sample', description: 'Expédier envoi hors du centre de tri (Ent)', stage: 'in_transit',
        stage_source: 'carrier_map' },
      { local_time: '2026-06-02', location: 'Centre de Tri Sample' },
      { local_time: '2026-06-02', location: 'Centre de Tri Sample', description: 'Recevoir envoi au centre de tri (Ent)', stage: 'in_transit',
        stage_source: 'carrier_map' },
      { local_time: '2026-06-01', location: 'EMS Sample International Center', description: 'Attente de controle douane', stage: 'customs',
        stage_source: 'carrier_map' },
      { local_time: '2026-06-01', location: 'EMS Sample International Center', description: 'Présentation au service des Douanes', stage: 'customs',
        stage_source: 'carrier_map' },
    ]);
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('icd')).toBe(OWN);
  });

  it('takes a newest row without wording, and new wording, without inventing a stage', () => {
    const unnamed = parseAlgeriePoste(withRows(row('2026-06-02 ', '', 'Centre de Tri Sample')), UNKNOWN);
    expect(unnamed).toEqual({ status: 'unknown', last_status_text: null, last_update: null, last_update_local: '2026-06-02',
      expected_delivery: null, events: [{ local_time: '2026-06-02', location: 'Centre de Tri Sample' }] });
    expect(parseAlgeriePoste(withRows(row('2026-06-02 10:00', 'Retour à l\'expéditeur', 'Sample')), UNKNOWN))
      .toMatchObject({ current_stage: 'exception', current_stage_source: expect.stringMatching(/^wording:/) });
    const sample = parseAlgeriePoste(withRows(row('2026-06-02 10:00', 'Sample counter scan', 'Sample')), UNKNOWN);
    expect(sample).toMatchObject({ status: 'unknown', last_status_text: 'Sample counter scan' });
    expect(sample.events![0]).toEqual({ local_time: '2026-06-02T10:00:00', location: 'Sample', description: 'Sample counter scan' });
    // A row with neither wording nor office says nothing.
    expect(() => parseAlgeriePoste(withRows(row('2026-06-02 ', '', '')), UNKNOWN)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the tracker\'s empty timeline as inconclusive, never as a missing item', async () => {
    expect(() => parseAlgeriePoste(page('unknown'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const lookup = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number: UNKNOWN });
    await expect(lookup(page('unknown'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(BLOCKED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="g-recaptcha"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the page to the whole requested number and rejects a changed page', () => {
    expect(() => parseAlgeriePoste(page('inbound-delivered'), 'ZZ000000028GB'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Algérie Poste answered for a different item' }));
    expect(() => parseAlgeriePoste(page('unknown'), OWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseAlgeriePoste(page('inbound-delivered').replace(`>${INBOUND}<`, `>${INBOUND.toLowerCase()}<`), INBOUND).events).toHaveLength(11);
    const delivered = page('inbound-delivered');
    for (const changed of [
      delivered.replace(`>${INBOUND}<`, '><'),
      delivered.replace('<font color="#f47334">', '<span>'),
      delivered.replace('class="cd-timeline js-cd-timeline"', 'class="timeline"'),
      delivered.replace('class="cd-timeline__container"', 'class="timeline__container"'),
      delivered.replace('<p>ZZSMPA</p>', ''),
      delivered.replace('<span class="cd-timeline__date">2026-05-12 09:31</span>', ''),
      delivered.replace('>2026-05-12 09:31<', '>12/05/2026 09:31<'),
      delivered.replace('>2026-05-12 09:31<', '>2026-02-30 09:31<'),
      delivered.replace('>2026-05-12 09:31<', '>2026-05-12 24:31<'),
      delivered.replace('>2026-05-12 09:31<', '>2026-05-12 9:31<'),
    ]) {
      expect(() => parseAlgeriePoste(changed, INBOUND)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const oversized = withRows(Array.from({ length: 501 }, () => row('2026-06-02 ', 'Entrée en transit', 'Sample')).join(''));
    expect(() => parseAlgeriePoste(oversized, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes S10 codes with a valid check digit, its own codes and EMS domestic numbers, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015GB', 'ZZ00000001DZ', 'ZZ000000014DZX', 'EC0000000001', 'EC000000000001', 'EA00000000001',
      '00000000001', 'SAMPLETRACKING', `EC${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAlgeriePosteNumber(' zz-000 000 020 dz ')).toBe(OWN);
    expect(normalizeAlgeriePosteNumber('zz 000 000 014 gb')).toBe(INBOUND);
    for (const number of [DOMESTIC, 'ED00000000001', 'ET00000000001']) expect(normalizeAlgeriePosteNumber(number)).toBe(number);
  });

  it('recognizes a known item and leaves an empty timeline inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('parcel-network'))).mockResolvedValueOnce(reply(page('unknown')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(OWN)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-04T00:00:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [301, 'transport'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('unknown'), status));
      await expect(carrier(fetcher).track({ number: INBOUND })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(INBOUND)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('inbound-delivered')));
    await expect(carrier(flaky).track({ number: INBOUND })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('inbound-delivered')));
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

  it('routes an item filed under Algérie Poste to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('inbound-delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: INBOUND, carrier: 'algerie-poste' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'algerie-poste', source: 'algerie-poste', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(ALGERIE_POSTE_TRACKER))).toBe(true);
  });

  it('is asked about its own codes and the domestic numbers, and reads the tracker\'s address', () => {
    expect(detectCarrierMatch(DOMESTIC)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['algerie-poste']) });
    expect(recognitionAskedCarriers(DOMESTIC)).toContain('algerie-poste');
    // Its own S10 codes, and its EY codes whose check digit fails.
    for (const number of [UNKNOWN, 'EY000000020DZ']) expect(recognitionAskedCarriers(number), number).toContain('algerie-poste');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('algerie-poste');
    for (const link of [`https://ems.dz/track/index.php?icd=${UNKNOWN}`, `https://www.ems.dz/track/index.php?icd=${UNKNOWN}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: UNKNOWN, carrier: 'algerie-poste', source: 'link' });
    }
  });
});

describe('Algérie Poste status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'algerie-poste', description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(algeriePosteStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    for (const wording of ['constructor', 'toString', 'Sample delivered note']) expect(statusMap.stage(null, wording), wording).toBeUndefined();
    expect(algeriePosteStage('')).toBeNull();
  });
});

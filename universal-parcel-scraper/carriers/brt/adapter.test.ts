import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { normalizeCarrierResult, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { BrtTracker, adapter, type BrtOriginLookup } from './adapter.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { isBrtCarrierDepot } from './depot.js';
import { groupShipment, normalizeBrtNumber, parseBrt, partnerShipment, readBrt, stagedDpdLeg, withOriginLeg } from './parser.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { classifyBrtStatus, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError } from '../../core/errors/index.js';

const NUMBER = '99000000000002';
const OTHER = '99000000000003';
const SHIPMENT = '990000000001';
const html = readFileSync(new URL('./fixtures/history.html', import.meta.url), 'utf8');
const PARCEL_ID = '990991000000015';
const parcelPage = readFileSync(new URL('./fixtures/parcel-id.html', import.meta.url), 'utf8');
const parcelList = readFileSync(new URL('./fixtures/parcel-list.html', import.meta.url), 'utf8');
const notFoundPage = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const negative = (number = NUMBER) => `<div id="box_tool_content"><div id="toolbar_sx"><h3>Rintraccia</h3></div><h3 class="separatore">Errori riscontrati</h3><div id="box_contenuti">TIS0868 Parcel Label number ${number} not found</div></div>`;
const changed = (page: string, fn: (document: ReturnType<typeof load>) => void) => { const $ = load(page); fn($); return $.html(); };
const edit = (fn: (document: ReturnType<typeof load>) => void) => changed(html, fn);
const response = (body = html) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });
// Each scan's instant, else its wall clock marked local, else its provider text.
const clocks = (events: ReturnType<typeof parseBrt>['events']) =>
  events!.map(event => event.time ?? (typeof event.local_time === 'string' ? `local ${event.local_time}` : event.provider_time_text));

describe('BRT direct tracking', () => {
  it('projects actual locker scans, Italian depot instants, cross-border local clocks and explicit kilogram weight', () => {
    const result = normalizeCarrierResult(parseBrt(html, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-01-16T21:07:00+01:00', delivered_at: '2026-01-16T21:07:00+01:00', weight_kg: 0.2 });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events).toHaveLength(7);
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', description: 'Delivered', time: '2026-01-16T21:07:00+01:00', location: 'TEST DEPOT (990)' });
    expect(result.events?.[1]!.stage).toBe('ready_for_pickup');
    // BRT dates its delivery round by the day alone: the scan keeps that day, on no clock.
    expect(result.events?.[2]).toMatchObject({ stage: 'out_for_delivery', local_time: '2026-01-14' });
    expect(result.events?.[2]!.time).toBeUndefined(); expect(result.events?.[2]!.provider_time_text).toBeUndefined();
    // No copy of such a scan has its clock, which the catalog tells consumers.
    expect(JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')).tracking).toMatchObject({ localClocks: true, dateOnlyScans: true });
    expect(result.events?.[5]!.stage).toBe('accepted');
    expect(result.events?.[6]!.stage).toBe('registered');
    // The Italian depot's scans are on Rome's clock; the depot abroad, named after a country on another clock, keeps wall clocks.
    expect(clocks(result.events)).toEqual(['2026-01-16T21:07:00+01:00', '2026-01-14T15:49:00+01:00', 'local 2026-01-14', '2026-01-14T08:32:00+01:00',
      'local 2026-01-13T21:00:00', 'local 2026-01-13T18:00:00', 'local 2026-01-10T14:57:00']);
    expect(result.events?.every(event => !event.provider_code)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    for (const entry of statuses.entries) expect(classifyBrtStatus(entry.wording)?.stage).toBe(entry.stage);
    for (const word of ['constructor', 'toString', 'DELIVERY PLANNED', 'RETURN REQUESTED']) expect(classifyBrtStatus(word)).toBeUndefined();
  });

  it('binds the returned BRTcode, rejects ambiguous details and accepts only the supported format', () => {
    expect(normalizeBrtNumber('9900 0000 0000 02')).toBe(NUMBER);
    expect(normalizeBrtNumber(PARCEL_ID)).toBe(PARCEL_ID);
    for (const n of ['', '123', NUMBER + '00', NUMBER.slice(1), NUMBER + '?', 'ABC00000000000']) expect(() => normalizeBrtNumber(n)).toThrow(InvalidInputError);
    for (const body of [edit($ => $('.table_dati_spedizione tr').eq(1).children('td').last().text(OTHER)),
      edit($ => $('.table_dati_spedizione tr').eq(1).remove()),
      edit($ => $('.table_dati_spedizione tr').eq(1).clone().appendTo('.table_dati_spedizione')),
      edit($ => $('.table_dati_spedizione').clone().appendTo('body')),
      edit($ => $('.table_stato_dati').clone().appendTo('body'))]) {
      expect(() => parseBrt(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps shipment numbers separate from BRTcodes and binds the complete identifier', async () => {
    const shipmentHtml = edit($ => {
      const identity = $('.table_dati_spedizione tr').eq(1).children('td');
      identity.first().text('N. spedizione'); identity.last().text(SHIPMENT);
    });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://vas.brt.it/vas/sped_det_show.hsm?lang=en');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ Nspediz: SHIPMENT,
        referer: 'sped_numspe_par.htm', RicercaNumeroSpedizione: 'Ricerca', lang: 'en' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return response(shipmentHtml);
    });
    expect(await adapter(environment(fetcher)).recognize!(SHIPMENT)).toEqual({ known: true, lastActivityAt: '2026-01-16T20:07:00.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => parseBrt(shipmentHtml.replace(SHIPMENT, '990000000002'), SHIPMENT)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBrt(shipmentHtml.replace('N. spedizione', 'BRTcode'), SHIPMENT)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBrt(shipmentHtml + shipmentHtml, SHIPMENT)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBrt(negative(SHIPMENT), SHIPMENT)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => normalizeBrtNumber(SHIPMENT + '0')).toThrow(InvalidInputError);
  });

  it('follows a parcel ID through the parcel list that names it', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (fetcher.mock.calls.length === 1) {
        expect(String(url)).toBe('https://vas.brt.it/vas/sped_det_show.hsm?lang=en');
        expect(init?.method).toBe('POST');
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ referer: 'sped_numspe_par.htm', ChiSono: PARCEL_ID,
          ClienteMittente: '', DataInizio: '', DataFine: '', RicercaChiSono: 'Ricerca', lang: 'en' });
        return response(parcelPage);
      }
      expect(String(url)).toBe('https://vas.brt.it/vas/sped_colli_lista.htm?nspediz=990000000001&KSU=&SpeChkCde=123456789&AnnoSpedizione=2026&lang=en');
      expect(init?.method).toBeUndefined();
      return response(parcelList);
    });
    const result = normalizeCarrierResult(await new BrtTracker({ fetcher }).fetch(PARCEL_ID));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', weight_kg: 1 });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'failed_attempt', 'out_for_delivery',
      'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SYNTHETIC|SpeChkCde|123456789|990000000001/);
  });

  it('refuses a parcel ID its parcel list does not name, and never follows another shipment\'s list', async () => {
    const twice = (detail: string, list = parcelList) => vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(response(list));
    for (const [detail, list] of [
      [parcelPage, parcelList.replaceAll(PARCEL_ID, '990991000000016')],
      [parcelPage, parcelList.replace('ID collo cliente', 'Something else')],
      [parcelPage.replace('sped_colli_lista.htm?nspediz=990000000001', 'sped_colli_lista.htm?nspediz=990000000002'), parcelList],
      [parcelPage.replace('sped_colli_lista.htm', 'https://example.invalid/sped_colli_lista.htm'), parcelList],
      [parcelPage.replace('id="aColli"', 'id="aOther"'), parcelList],
    ]) {
      await expect(new BrtTracker({ fetcher: twice(detail!, list) }).fetch(PARCEL_ID)).rejects.toMatchObject({ kind: 'schema' });
    }
    expect(() => parseBrt(parcelPage, PARCEL_ID)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // The parcel ID search gives its not-found reply without BRT's error code.
    const absent = vi.fn<typeof fetch>().mockResolvedValue(response(notFoundPage.replace('TIS0564 ', '')));
    await expect(new BrtTracker({ fetcher: absent }).fetch(PARCEL_ID)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(absent).toHaveBeenCalledTimes(1);
  });

  it('follows an EOB customer parcel ID through the same parcel search', async () => {
    const customerId = 'EOB99099100000000015';
    const list = parcelList.replace(`<td>${PARCEL_ID}</td></tr>`, `<td>${customerId}</td></tr>`);
    expect(normalizeBrtNumber('eob 9909 9100 0000 0001 5')).toBe(customerId);
    for (const n of [customerId.slice(0, -1), customerId + '0', 'EOC99099100000000015', 'EOB9909910000000001A']) {
      expect(() => normalizeBrtNumber(n)).toThrow(InvalidInputError);
    }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(parcelPage)).mockResolvedValueOnce(response(list));
    const result = await new BrtTracker({ fetcher }).fetch(customerId);
    expect(Object.fromEntries(new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body)))).toMatchObject({ ChiSono: customerId, RicercaChiSono: 'Ricerca' });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    // The list must name this customer ID, and BRT's code-less negative stays inconclusive.
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(response(parcelPage)).mockResolvedValueOnce(response(parcelList));
    await expect(new BrtTracker({ fetcher: other }).fetch(customerId)).rejects.toMatchObject({ kind: 'schema' });
    const absent = vi.fn<typeof fetch>().mockResolvedValue(response(notFoundPage.replace('TIS0564 ', '')));
    await expect(new BrtTracker({ fetcher: absent }).fetch(customerId)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });

  it('reads the shipment past a held-parcel record and a DPD link box', () => {
    const result = parseBrt(parcelPage, '990000000001');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', weight_kg: 1 });
    expect(result.events).toHaveLength(8);
    expect(() => parseBrt(parcelPage.replace('N. Giacenza', 'N. spedizione'), '990000000001'))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a shipment delivered back to its sender as returned', () => {
    const body = edit($ => {
      $('.table_stato_dati tr').eq(1).children('td').last().text('DELIVERED');
      $('.table_stato_dati tr').eq(2).children('td').last().text('RETURNED TO SENDER');
    });
    const result = parseBrt(body, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Delivered', last_update: '2026-01-16T21:07:00+01:00' });
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads a shipment a public demonstration holds up as an exception, until a later scan moves it on', () => {
    const held = parseBrt(edit($ => $('.table_stato_dati tr').eq(1).children('td').last().text('TURMOIL')), NUMBER);
    expect(held).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'TURMOIL' });
    expect(held.events![0]).toMatchObject({ stage: 'exception', provider_status: 'TURMOIL' });
    const moved = parseBrt(edit($ => {
      $('.table_stato_dati tr').eq(1).children('td').last().text('ARRIVED AT DEPOT');
      $('.table_stato_dati tr').eq(2).children('td').last().text('TURMOIL');
    }), NUMBER);
    expect(moved).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(moved.events![1]).toMatchObject({ stage: 'exception' });
  });

  it('dates a shipment delivered in Italy on Rome\'s clock at each of BRT\'s depots, and its last update by the newest scan', () => {
    // Collected and delivered in Italy, in summer time.
    const result = parseBrt(parcelPage, SHIPMENT);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-09-04T12:38:00+02:00', delivered_at: '2026-09-04T12:38:00+02:00' });
    expect(result.last_update_local).toBeUndefined();
    expect(clocks(result.events)).toEqual(['2026-09-04T12:38:00+02:00', '2026-09-03T12:59:00+02:00', '2026-09-02T15:21:00+02:00', 'local 2026-09-02',
      '2026-09-02T08:32:00+02:00', '2026-09-01T21:00:00+02:00', '2026-09-01T18:00:00+02:00', '2026-08-27T14:31:00+02:00']);
    // On its way, the newest scan's instant is the last update, without a delivery.
    const moving = parseBrt(changed(parcelPage, $ => $('.table_stato_dati').first().find('tr').slice(1, 5).remove()), SHIPMENT);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-09-02T08:32:00+02:00' });
    expect(moving.last_update_local).toBeUndefined(); expect(moving.delivered_at).toBeUndefined();
  });

  it('keeps wall clocks at the DPD network\'s depots abroad and at places that are not BRT depots', () => {
    const at = (place: string) => parseBrt(edit($ => $('.table_stato_dati tr').eq(1).children('td').eq(2).text(place)), NUMBER);
    for (const place of ['DPD-XX IMPORT TEST (991)', 'DPD XX NORD (992)', 'DPD SAMPLE NORDICS (993)', 'DPD IRLANDA (994)',
      'SAMPLE REGNO UNITO (996)', 'PORTOGALLO/SPAGNA (997)', 'DPD STATI UNITI (998)', '', 'TEST DEPOT', 'TEST DEPOT (99)', 'TEST DEPOT (9900)']) {
      const result = at(place);
      expect(result, place).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-16T21:07:00' });
      expect(result.delivered_at, place).toBeUndefined();
      expect(result.events![0]!.time, place).toBeUndefined();
    }
    // A province's two letters are no country, and San Marino keeps Italy's clock.
    for (const place of ['NA-SAMPLETOWN (991)', 'SAMPLE S.G. TOWN (992)', 'SAN MARINO TEST (993)']) {
      expect(at(place), place).toMatchObject({ last_update: '2026-01-16T21:07:00+01:00', delivered_at: '2026-01-16T21:07:00+01:00' });
    }
  });

  it('dates scans at depots named after a country on Italy\'s clock, whichever of the two clocks BRT shows', () => {
    // Handed to a partner abroad: no arrival depot in Italy.
    const abroad = (place: string, date = '16.01.2026', clock = '21.07') => parseBrt(edit($ => {
      $('.table_dati_spedizione tr').last().remove();
      const first = $('.table_stato_dati tr').eq(1).children('td');
      first.eq(0).text(date); first.eq(1).text(clock); first.eq(2).text(place);
    }), NUMBER);
    for (const place of ['DPD-ROV-AUSTRIA (991)', 'DPD-ROV-GERMANIA (992)', 'BELGIO/LUSSEMBURGO (994)', 'FRANCIA SAMPLEVILLE (995)', 'GERMANY TEST (997)',
      'CHR-FR SAMPLE (998)', 'DPD AT TEST (999)']) {
      expect(abroad(place), place).toMatchObject({ status: 'delivered', last_update: '2026-01-16T21:07:00+01:00', delivered_at: '2026-01-16T21:07:00+01:00' });
      expect(abroad(place, '16.07.2026').last_update, place).toBe('2026-07-16T21:07:00+02:00');
      // The hour the change from summer time repeats stays local.
      expect(abroad(place, '25.10.2026', '02.30'), place).toMatchObject({ last_update: null, last_update_local: '2026-10-25T02:30:00' });
    }
    // A depot naming a country on another clock, or one of several zones, keeps its wall clock.
    for (const place of ['DPD IRLANDA (991)', 'AUSTRIA/REGNO UNITO (992)', 'DPD FRANCIA PORTOGALLO (993)', 'SAMPLE RUSSIA (994)']) {
      expect(abroad(place), place).toMatchObject({ last_update: null, last_update_local: '2026-01-16T21:07:00' });
    }
    // Two letters that are no single-zone country's code, or one on another clock: "GE" is Genoa's and Georgia's.
    for (const place of ['DPD-GE IMPORT TEST (995)', 'DPD-XX TEST (996)', 'CHR-FR XY (997)', 'SAMPLE US (998)', 'NA-SAMPLETOWN (999)']) {
      expect(abroad(place), place).toMatchObject({ last_update: null, last_update_local: '2026-01-16T21:07:00' });
    }
  });

  it('names the DPD network that delivers a parcel BRT sent abroad, under the DPD number its detail gives', () => {
    const DPD_NUMBER = '99000000000009';
    // No arrival depot in Italy, the parcel's DPD number, and BRT's copy of DPD's newest scan, dated alone.
    const sent = (place: string) => edit($ => {
      $('.table_dati_spedizione tr').last().remove();
      $('.table_dati_spedizione').append(`<tr><td class="bold">Parcel number dpd</td><td>${DPD_NUMBER}</td></tr>`);
      const first = $('.table_stato_dati tr').eq(1).children('td');
      first.eq(1).text(''); first.eq(2).text(place); first.eq(3).text('FOR DELIVERY');
    });
    const result = normalizeCarrierResult(parseBrt(sent('DPD DE SAMPLE (990)'), NUMBER));
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_update: null, delivery_carrier: 'dpd-de', delivery_tracking_number: DPD_NUMBER });
    expect(deliveryHandoff('brt', NUMBER, result)).toEqual({ carrier: 'dpd-de', number: DPD_NUMBER, basis: 'partner' });
    for (const [place, network] of [['DPD-ROV-GERMANIA (991)', 'dpd-de'], ['DPD FR NORD (992)', 'dpd-fr'], ['DPD-ROV-AUSTRIA (993)', 'dpd-at']] as const) {
      expect(parseBrt(sent(place), NUMBER).delivery_carrier, place).toBe(network);
    }
    // A depot naming no country, several, Italy, one without a DPD network (BRT's import depot at Genoa
    // reads as Georgia), or a depot that is not DPD's.
    for (const place of ['DPD XX NORD (991)', 'DPD FRANCIA PORTOGALLO (992)', 'DPD ITALIA (993)', 'DPD-GE IMPORT TEST (994)',
      'BELGIO/LUSSEMBURGO (995)', 'GERMANY TEST (996)', 'TEST DEPOT (997)']) {
      expect(parseBrt(sent(place), NUMBER).delivery_carrier, place).toBeUndefined();
    }
    // Several parcels, another number's shape, two DPD numbers, a delivery in Italy, or a parcel DPD brought to BRT.
    const page = sent('DPD DE SAMPLE (990)');
    for (const body of [page.replace('Colli: 1', 'Colli: 2'), page.replace(DPD_NUMBER, DPD_NUMBER.slice(1)),
      changed(page, $ => $('.table_dati_spedizione tr').last().clone().appendTo('.table_dati_spedizione')),
      changed(page, $ => $('.table_dati_spedizione').append('<tr><td class="bold">Filiale di arrivo</td><td>TEST DEPOT</td></tr>')),
      changed(page, $ => $('.table_stato_dati tr').last().children('td').eq(2).text('DPD SAMPLE (998)'))]) {
      const other = parseBrt(body, NUMBER);
      expect(other.delivery_carrier).toBeUndefined();
      expect(other.delivery_tracking_number).toBeUndefined();
    }
  });

  it('dates only the depot of origin of a shipment handed to a partner abroad', () => {
    // Without an arrival depot BRT delivers abroad, whatever its partner's depot is called.
    const result = parseBrt(edit($ => {
      $('.table_dati_spedizione tr').last().remove();
      $('.table_stato_dati tr').slice(1, 5).each((_, row) => { $(row).children('td').eq(2).text('SAMPLE PARTNER (990)'); });
      $('.table_stato_dati tr').slice(5).each((_, row) => { $(row).children('td').eq(2).text('TEST ORIGIN (991)'); });
    }), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-16T21:07:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(clocks(result.events)).toEqual(['local 2026-01-16T21:07:00', 'local 2026-01-14T15:49:00', 'local 2026-01-14', 'local 2026-01-14T08:32:00',
      '2026-01-13T21:00:00+01:00', '2026-01-13T18:00:00+01:00', '2026-01-10T14:57:00+01:00']);
  });

  it('keeps a clock the change to or from summer time repeats or skips as a local time', () => {
    const at = (date: string, clock: string) => parseBrt(edit($ => {
      const first = $('.table_stato_dati tr').eq(1).children('td');
      first.eq(0).text(date); first.eq(1).text(clock);
    }), NUMBER);
    for (const [date, clock, local] of [['25.10.2026', '02.30', '2026-10-25T02:30:00'], ['29.03.2026', '02.30', '2026-03-29T02:30:00']] as const) {
      const result = at(date, clock);
      expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: local });
      expect(result.delivered_at).toBeUndefined();
    }
    expect(at('25.10.2026', '01.59').last_update).toBe('2026-10-25T01:59:00+02:00');
    expect(at('25.10.2026', '03.00').last_update).toBe('2026-10-25T03:00:00+01:00');
    expect(at('29.03.2026', '03.00').last_update).toBe('2026-03-29T03:00:00+02:00');
  });

  it('reports only the scoped matching TIS0868 parcel-label negative', () => {
    expect(() => parseBrt(negative(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [negative(OTHER), negative().replace('TIS0868', 'TIS0000'), negative().replace('Errori riscontrati', 'Maintenance'),
      negative().replace('box_tool_content', 'hidden'), negative() + negative(), '<html>Parcel not found</html>',
      edit($ => $('.table_stato_dati').remove())]) {
      expect(() => parseBrt(body, NUMBER)).toThrow();
      expect(() => parseBrt(body, NUMBER)).not.toThrowError(expect.objectContaining({ kind: 'not_found' }));
    }
  });

  it('reads BRT\'s not-found-or-processing reply as an unknown shipment, never as absence', async () => {
    for (const number of [SHIPMENT, NUMBER, PARCEL_ID]) {
      expect(() => parseBrt(notFoundPage, number)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    }
    const fetcher = vi.fn<typeof fetch>(async () => new Response(Buffer.from(notFoundPage, 'latin1'),
      { headers: { 'Content-Type': 'text/html; charset=ISO-8859-1' } }));
    await expect(adapter(environment(fetcher)).track({ number: SHIPMENT, postcode: null }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    await expect(adapter(environment(fetcher)).recognize!(SHIPMENT)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    const page = (fn: (document: ReturnType<typeof load>) => void) => { const $ = load(notFoundPage); fn($); return $.html(); };
    for (const body of [notFoundPage.replace('TIS0564', 'TIS0565'), notFoundPage.replace('TIS0564 ', ''), notFoundPage.replace('still being processed', 'being processed'),
      notFoundPage.replace('Errori riscontrati</label>', 'Avviso</label>'), notFoundPage.replace('box_tool_content', 'hidden'),
      page($ => $('#box_contenuti td').append(' Try again tomorrow')), page($ => $('#box_contenuti').clone().appendTo('#box_tool_content')),
      notFoundPage.replace('</body>', `${html}</body>`), notFoundPage + notFoundPage]) {
      expect(() => parseBrt(body, SHIPMENT)).not.toThrowError(expect.objectContaining({ reason: 'portal_not_found' }));
    }
  });

  it('does not promote older dated delivery when the newest clock or wording is unresolved', () => {
    for (const [date, clock] of [['', ''], ['31.02.2026', ''], ['31.02.2026', '25.00'], ['16.01.2026', '09.99'], ['Tomorrow', 'Any time']] as const) {
      const result = parseBrt(edit($ => {
        const first = $('.table_stato_dati tr').eq(1).children('td');
        first.eq(0).text(date); first.eq(1).text(clock); first.eq(3).text('NEW PROVIDER STATUS');
        $('.table_stato_dati tr').eq(2).children('td').last().text('DELIVERED');
      }), NUMBER);
      expect(result).toMatchObject({ status: 'unknown', last_status_text: 'NEW PROVIDER STATUS', last_update: null });
      expect(result.current_stage).toBeUndefined(); expect(result.last_update_local).toBeUndefined(); expect(result.delivered_at).toBeUndefined();
      expect(result.events?.[0]!.provider_time_text).toBe([date, clock].filter(Boolean).join(' ') || undefined);
      expect(result.events?.[0]!.local_time).toBeUndefined();
    }
    const delivered = parseBrt(edit($ => $('.table_stato_dati tr').eq(1).children('td').eq(1).text('')), NUMBER);
    expect(delivered.status).toBe('delivered'); expect(delivered.last_update).toBeNull(); expect(delivered.delivered_at).toBeUndefined();
    expect(delivered.last_update_local).toBe('2026-01-16'); expect(delivered.events?.[0]!.local_time).toBe('2026-01-16');
  });

  it('keeps native newest-first position, equal clocks and repeated scans without inventing codes', () => {
    const body = edit($ => {
      const row = $('.table_stato_dati tr').eq(1);
      row.clone().insertAfter(row);
      $('.table_stato_dati tr').eq(2).children('td').last().text('FOR DELIVERY');
      row.clone().insertAfter($('.table_stato_dati tr').eq(2));
    });
    const result = parseBrt(body, NUMBER);
    expect(result.status).toBe('delivered');
    expect(result.events?.slice(0, 3).map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'delivered']);
  });

  it('rejects incomplete or oversized scan tables and bounds retained history', () => {
    for (const body of [edit($ => $('.table_stato_dati tr').first().children('td').last().text('Different heading')),
      edit($ => $('.table_stato_dati tr').eq(1).children('td').last().remove()),
      edit($ => $('.table_stato_dati tr').eq(1).children('td').last().text('')),
      edit($ => $('.table_stato_dati').append('<tr><td>x</td></tr>'.repeat(502)))]) {
      expect(() => parseBrt(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBrt(edit($ => $('.table_stato_dati tr').slice(1).remove()), NUMBER)).toThrow(NoHistoryError);
    const many = edit($ => $('.table_stato_dati').append($('.table_stato_dati tr').eq(1).prop('outerHTML')!.repeat(120)));
    expect(parseBrt(many, NUMBER).events).toHaveLength(100);
  });

  it('retains only positive, unambiguous explicit kilogram weights', () => {
    for (const weight of ['0', '-1', 'NaN', '100001', '1 lb', '0,2 Peso (kg): 0,3']) {
      const result = parseBrt(edit($ => $('.table_dati_spedizione tr').eq(5).children('td').last().text(`PACCHI Peso (kg): ${weight}`)), NUMBER);
      expect(result.weight_kg).toBeUndefined();
    }
    expect(parseBrt(edit($ => $('.table_dati_spedizione tr').eq(5).children('td').last().text('PACCHI Peso (kg): 1.25 Volume m³: 0.5')), NUMBER).weight_kg).toBe(1.25);
  });

  it('retrieves the exact linked public event page in one bounded request without credentials or postcode', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://vas.brt.it/vas/sped_det_new.htm?brtCode=${NUMBER}&lang=en`);
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).has('cookie')).toBe(false);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.body).toBeUndefined();
      return response();
    });
    expect(await adapter(environment(fetcher)).track({ number: NUMBER, postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recognizes matching history, ranked by its instants but not by local clocks, and propagates outages', async () => {
    const positive = vi.fn<typeof fetch>().mockResolvedValue(response());
    const instance = adapter(environment(positive));
    expect(await instance.recognize!('unsupported')).toEqual({ known: false }); expect(positive).not.toHaveBeenCalled();
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: '2026-01-16T20:07:00.000Z' });
    // Without an arrival depot in Italy, only the depot of origin is on Rome's clock.
    const abroad = vi.fn<typeof fetch>().mockResolvedValue(response(edit($ => $('.table_dati_spedizione tr').last().remove())));
    expect(await adapter(environment(abroad)).recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-16T21:07:00' });
    const absent = vi.fn<typeof fetch>().mockResolvedValue(response(negative()));
    expect(await adapter(environment(absent)).recognize!(NUMBER)).toEqual({ known: false });
    const outage = vi.fn<typeof fetch>().mockResolvedValue(response('<html>Unavailable</html>'));
    await expect(adapter(environment(outage)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('decodes the legacy page encoding while rejecting unknown encodings', async () => {
    const body = html.replaceAll('TEST DEPOT', 'TEST DÉPÔT');
    const latin = vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from(body, 'latin1')));
    expect((await new BrtTracker({ fetcher: latin }).fetch(NUMBER)).events?.[0]!.location).toBe('TEST DÉPÔT (990)');
    const changed = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-16' } }));
    await expect(new BrtTracker({ fetcher: changed }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('classifies HTTP failures without treating generic 404/410 or redirects as parcel absence', async () => {
    for (const [status, kind] of [[302, 'indeterminate'], [404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(negative(), { status }));
      await expect(new BrtTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    // While its tracker is down, BRT sends every page to a notice.
    const notice = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'manutenzione_new.htm' } }));
    await expect(new BrtTracker({ fetcher: notice }).fetch(NUMBER)).rejects.toBeInstanceOf(MaintenanceError);
    // Another redirect names its page, not its query, so an outage's notice can be told from a missing page.
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: '/web/avviso.htm?brtCode=1' } }));
    await expect(new BrtTracker({ fetcher: moved }).fetch(NUMBER)).rejects.toThrow('HTTP 302 to vas.brt.it/web/avviso.htm');
    const missing = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    await expect(new BrtTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toThrow(/unavailable: HTTP 404$/);
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_000_001)));
    await expect(new BrtTracker({ fetcher: oversized }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  it('preserves caller cancellation and rejects responses arriving after a fractional lookup budget', async () => {
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(new BrtTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new BrtTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const controller = new AbortController();
    const waiting = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise((_resolve, reject) => { init?.signal?.throwIfAborted(); init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); });
      return response();
    });
    const active = new BrtTracker({ fetcher: waiting }).fetch(NUMBER, { signal: controller.signal }); controller.abort();
    await expect(active).rejects.toMatchObject({ kind: 'transport' }); expect(waiting).toHaveBeenCalledTimes(1);
    const late = vi.fn<typeof fetch>(async () => { await new Promise(resolve => setTimeout(resolve, 35)); return response(); });
    await expect(new BrtTracker({ fetcher: late }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: 'budget' });
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('BRT in Italian', () => {
  // The fixture's history with each scan labelled as given, newest first.
  const labelled = (...labels: string[]) => edit($ => $('.table_stato_dati tr').slice(1).each((index, row) => {
    $(row).children('td').last().text(labels[index]!);
  }));
  const ENGLISH = ['COLLECTED AT BRT-fermopoint', 'ARRIVED AT BRT-fermopoint', 'FOR DELIVERY', 'ARRIVED AT DEPOT', 'DEPARTED', 'COLLECTED', 'SHIPPING INFO SENT TO BRT'];
  const ITALIAN = ['RITIRATA AL BRT-fermopoint', 'ARRIVATA AL BRT-fermopoint', 'IN CONSEGNA', 'ARRIVATA IN FILIALE', 'PARTITA', 'RITIRATA', 'DATI SPEDIZ. TRASMESSI A BRT'];
  const english = labelled(...ENGLISH);
  const italian = labelled(...ITALIAN);
  const unworded = (result: CarrierResult) => ({ ...result, last_status_text: undefined,
    events: result.events!.map(event => ({ ...event, description: undefined, provider_status: undefined })) });
  const languageOf = (url: unknown, init?: RequestInit) => new URL(String(url)).searchParams.get('lang') ?? new URLSearchParams(String(init?.body)).get('lang');

  it('reads the Italian page as it reads the English one', () => {
    const fromEnglish = parseBrt(english, NUMBER);
    const fromItalian = parseBrt(italian, NUMBER);
    expect(unworded(fromItalian)).toEqual(unworded(fromEnglish));
    expect(fromEnglish).toMatchObject({ status: 'delivered', last_status_text: 'Delivered' });
    expect(fromItalian).toMatchObject({ status: 'delivered', last_status_text: 'Consegnata' });
    expect(fromItalian.events!.map(event => event.provider_status)).toEqual(ITALIAN);
    for (const [en, it] of [['NOTICE OF ATTEMPTED DELIVERY', 'Destin.Assente:LASCIATO AVVISO'], ['UNKNOWN/INCOMPLETE CONSIGNEE', 'DESTINATAR.SCONOSC./INCOMPLETO'],
      ['TURMOIL', 'MANIFESTAZIONE PUBBLICA'], ['Redirect to BRT-fermopoint', 'REINDIRIZZATA A BRT-fermopoint']]) {
      expect(unworded(parseBrt(labelled(it!, ...ITALIAN.slice(1)), NUMBER))).toEqual(unworded(parseBrt(labelled(en!, ...ENGLISH.slice(1)), NUMBER)));
    }
    const returned = parseBrt(labelled('CONSEGNATA', 'RESO MITTENTE', ...ITALIAN.slice(2)), NUMBER);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Consegnata' });
  });

  it('asks for the Italian page for an Italian reader and for the English one otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => response(languageOf(url, init) === 'it' ? italian : english));
    const instance = adapter(environment(fetcher));
    for (const [language, asked] of [['it', 'it'], ['it-IT', 'it'], ['de', 'en'], [null, 'en']] as const) {
      fetcher.mockClear();
      const result = await instance.track({ number: NUMBER, postcode: null, language });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]![0])).toBe(`https://vas.brt.it/vas/sped_det_new.htm?brtCode=${NUMBER}&lang=${asked}`);
      expect(result.last_status_text).toBe(asked === 'it' ? 'Consegnata' : 'Delivered');
    }
    const shipmentPage = (page: string) => changed(page, $ => {
      const identity = $('.table_dati_spedizione tr').eq(1).children('td');
      identity.first().text('N. spedizione'); identity.last().text(SHIPMENT);
    });
    const posts = vi.fn<typeof fetch>(async (url, init) => response(shipmentPage(languageOf(url, init) === 'it' ? italian : english)));
    expect(await adapter(environment(posts)).track({ number: SHIPMENT, postcode: null, language: 'it' })).toMatchObject({ last_status_text: 'Consegnata' });
    const [url, init] = posts.mock.calls[0]!;
    expect(String(url)).toBe('https://vas.brt.it/vas/sped_det_show.hsm?lang=it');
    expect(new URLSearchParams(String(init?.body)).get('lang')).toBe('it');
  });

  it('asks again in English when the Italian page has a label the map has no English for', async () => {
    const unread = labelled('NUOVO EVENTO SINTETICO', ...ITALIAN.slice(1));
    const fetcher = vi.fn<typeof fetch>(async (url, init) => response(languageOf(url, init) === 'it' ? unread : english));
    expect(await adapter(environment(fetcher)).track({ number: NUMBER, postcode: null, language: 'it' })).toEqual(parseBrt(english, NUMBER));
    expect(fetcher.mock.calls.map(([url, init]) => languageOf(url, init))).toEqual(['it', 'en']);
    // Without the English page, the Italian one stands.
    const failing = vi.fn<typeof fetch>(async (url, init) => languageOf(url, init) === 'it' ? response(unread) : new Response('', { status: 503 }));
    expect(await adapter(environment(failing)).track({ number: NUMBER, postcode: null, language: 'it' })).toEqual(parseBrt(unread, NUMBER));
  });

  it('reads the Italian page\'s negative and its not-found-or-processing reply as it reads the English ones', () => {
    const negativeInItalian = negative().replace(`Parcel Label number ${NUMBER} not found`, `Parcel label number ${NUMBER} non trovato`);
    expect(() => parseBrt(negativeInItalian, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBrt(negativeInItalian.replaceAll(NUMBER, OTHER), NUMBER)).not.toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const processing = notFoundPage.replace('Shipment not found or still being processed in our systems. Correct the entered parameter or wait and then repeat the search',
      'Spedizione non trovata oppure ancora in elaborazione nei nostri sistemi. Correggere il parametro immesso oppure attendere e ripetere successivamente la ricerca');
    for (const number of [SHIPMENT, NUMBER, PARCEL_ID]) {
      expect(() => parseBrt(processing, number)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    }
    expect(() => parseBrt(processing.replace('TIS0564 ', ''), PARCEL_ID)).toThrowError(expect.objectContaining({ reason: 'portal_not_found' }));
    expect(() => parseBrt(processing.replace('TIS0564 ', ''), SHIPMENT)).not.toThrowError(expect.objectContaining({ reason: 'portal_not_found' }));
  });

  it('lets a scan labelled in one language take over the row stored with the other\'s label', () => {
    const policy = sameInstantIdentityPolicy('brt', { supportsScanMatching: true })!;
    const scan = (event: CarrierEvent) => ({ stage: event.stage ?? '', description: event.description ?? '', location: event.location ?? '', providerCode: '' });
    const fromEnglish = parseBrt(english, NUMBER).events!.map(scan);
    const fromItalian = parseBrt(italian, NUMBER).events!.map(scan);
    for (const [index, row] of fromEnglish.entries()) {
      expect(fromItalian.filter(incoming => policy.matches!(incoming, row)), String(index)).toEqual([fromItalian[index]]);
      expect(fromEnglish.filter(incoming => policy.matches!(incoming, fromItalian[index]!)), String(index)).toEqual([row]);
    }
    expect(policy.matches!({ ...fromItalian[4]!, location: 'OTHER DEPOT (992)' }, fromEnglish[4]!)).toBe(false);
    expect(policy.matches!(fromItalian[4]!, { ...fromEnglish[4]!, providerCode: 'X1' })).toBe(false);
  });
});

describe('BRT origin legs', () => {
  const scan = (description: string, clock: string, stage?: string): CarrierEvent => ({ description, ...(stage ? { stage } : {}),
    ...(clock.length > 19 ? { time: clock } : { local_time: clock }) });
  const brt = (events: CarrierEvent[], status: CarrierResult['status'] = 'in_transit'): CarrierResult => ({ status,
    current_stage: events[0]!.stage, last_status_text: events[0]!.description, last_update: events[0]!.time ?? null,
    ...(events[0]!.local_time ? { last_update_local: events[0]!.local_time } : {}), events });
  const partner = (...events: CarrierEvent[]): CarrierResult => ({ status: 'in_transit', current_stage: 'in_transit',
    last_status_text: events[0]!.description, last_update: events[0]!.time ?? null, history_truncated: true, events });
  const descriptions = (result: CarrierResult) => result.events!.map(event => event.description);
  const preAdvice = (clock: string) => scan('SHIPPING INFO SENT TO BRT', clock, 'registered');

  it('names the partner of a shipment whose oldest scan is at its import depot', () => {
    const at = (row: number, location: string) => readBrt(edit($ => $('.table_stato_dati tr').eq(row).children('td').eq(2).text(location)), NUMBER);
    const from = (location: string) => at(-1, location).partner;
    expect(from('CHR-FR SAMPLE (998)')).toBe('chronopost');
    expect(from('DPD SAMPLE (990)')).toBe('dpd');
    expect(from('DPD-ROV-SAMPLE (991)')).toBe('dpd');
    expect(from('DPD-COLISSIMO (999)')).toBe('dpd');
    for (const location of ['TEST DEPOT (990)', 'DPDSAMPLE (990)', 'SAMPLE DPD (990)', '']) expect(from(location), location).toBeNull();
    expect(at(1, 'DPD SAMPLE (990)').partner).toBeNull();
  });

  it('reads BRT\'s collection from a partner that brought the parcel from abroad as its hand-over, in transit', () => {
    const stages = (result: CarrierResult) => result.events!.map(event => event.stage);
    // Collected, and still at the partner's import depot.
    const collected = (origin: string) => parseBrt(edit($ => {
      $('.table_stato_dati tr').slice(1, 6).remove();
      $('.table_stato_dati tr').slice(1).each((_, row) => { $(row).children('td').eq(2).text(origin); });
    }), NUMBER);
    for (const origin of ['CHR-FR SAMPLE (998)', 'DPD SAMPLE (990)', 'DPD-COLISSIMO (999)']) {
      expect(collected(origin), origin).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'COLLECTED' });
      expect(stages(collected(origin)), origin).toEqual(['in_transit', 'registered']);
      expect(stages(parseBrt(edit($ => $('.table_stato_dati tr').slice(5).each((_, row) => { $(row).children('td').eq(2).text(origin); })), NUMBER)), origin)
        .toEqual(['delivered', 'ready_for_pickup', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'registered']);
    }
    // Wherever BRT records the collection: the partner accepted the parcel abroad.
    expect(stages(parseBrt(edit($ => {
      $('.table_stato_dati tr').slice(1, 6).remove();
      $('.table_stato_dati tr').last().children('td').eq(2).text('DPD SAMPLE (990)');
    }), NUMBER))).toEqual(['in_transit', 'registered']);
    // Collected in a shipment that starts at one of BRT's own depots, or at a depot only a later scan names a partner at, it is the acceptance.
    expect(collected('TEST ORIGIN (991)')).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
    expect(stages(parseBrt(html, NUMBER)).slice(-2)).toEqual(['accepted', 'registered']);
    expect(stages(parseBrt(edit($ => $('.table_stato_dati tr').eq(1).children('td').eq(2).text('DPD SAMPLE (990)')), NUMBER)).slice(-2))
      .toEqual(['accepted', 'registered']);
    // The partner's leg comes below BRT's hand-over.
    const leg = withOriginLeg(collected('DPD SAMPLE (990)'), { status: 'in_transit', events: [
      { description: 'Sample transit', stage: 'in_transit', time: '2026-01-12T20:00:00Z' },
      { description: 'Sample intake', stage: 'accepted', time: '2026-01-12T08:00:00Z' }] });
    expect(leg.events!.map(event => [event.description, event.stage])).toEqual([['COLLECTED', 'in_transit'], ['Sample transit', 'in_transit'],
      ['Sample intake', 'accepted'], ['SHIPPING INFO SENT TO BRT', 'registered']]);
  });

  it('gives no place to a depot named by carriers alone, and lets the scans stored there keep their rows', () => {
    const page = (origin: string) => edit($ => $('.table_stato_dati tr').slice(5).each((_, row) => { $(row).children('td').eq(2).text(origin); }));
    const result = readBrt(page('DPD-COLISSIMO (999)'), NUMBER);
    expect(result.partner).toBe('dpd');
    expect(result.result.events!.map(event => event.location)).toEqual([...Array(4).fill('TEST DEPOT (990)'), undefined, undefined, undefined]);
    // Its clocks stay wall clocks, as at the partner's other depots that name no country.
    expect(clocks(result.result.events).slice(-2)).toEqual(['local 2026-01-13T18:00:00', 'local 2026-01-10T14:57:00']);
    for (const place of ['DPD-COLISSIMO (999)', 'DPD COLISSIMO (999)', ' GLS-BRT (999) ']) expect(isBrtCarrierDepot(place), place).toBe(true);
    for (const place of ['DPD IRLANDA (991)', 'CHR-FR SAMPLE (998)', 'DPD-ROV-AUSTRIA (991)', 'DPDSAMPLE (990)', 'TEST DEPOT (990)', 'DPD-COLISSIMO', 'DPD', '']) {
      expect(isBrtCarrierDepot(place), place).toBe(false);
      expect(parseBrt(page(place), NUMBER).events!.at(-1)!.location, place).toBe(place || undefined);
    }
    // What an earlier release stored: the scans at that depot as its place, the collection as the acceptance.
    const policy = sameInstantIdentityPolicy('brt', { supportsScanMatching: true })!;
    expect(policy).toMatchObject({ storedSources: ['brt'], requireProviderCode: false, matchEachScan: true, matchWallClock: true });
    const scan = (event: CarrierEvent) => ({ stage: event.stage ?? '', description: event.description ?? '', location: event.location ?? '', providerCode: '' });
    const scans = result.result.events!.map(scan);
    const stored = parseBrt(page('DPD-COLISSIMO (999)'), NUMBER).events!.map(scan).map((row, index) =>
      index < 4 ? row : { ...row, location: 'DPD-COLISSIMO (999)', stage: row.description === 'COLLECTED' ? 'accepted' : row.stage });
    expect(stored.slice(-2).map(row => row.stage)).toEqual(['accepted', 'registered']);
    for (const [index, row] of stored.entries()) {
      expect(scans.filter(incoming => policy.matches!(incoming, row)), String(index)).toEqual([scans[index]]);
    }
    // Another scan, another stage, a place kept or a stored place that is a town is no such row.
    const [handover, data] = scans.slice(-2) as [ReturnType<typeof scan>, ReturnType<typeof scan>];
    const row = stored.at(-2)!;
    for (const other of [{ ...row, description: 'DEPARTED' }, { ...row, stage: 'registered' }, { ...row, location: 'TEST DEPOT (990)' }]) {
      expect(policy.matches!(handover, other)).toBe(false);
    }
    expect(policy.matches!({ ...handover, stage: 'accepted' }, { ...row, stage: 'in_transit' })).toBe(false);
    expect(policy.matches!({ ...handover, location: 'TEST DEPOT (990)' }, row)).toBe(false);
    expect(policy.matches!(data, { ...stored.at(-1)!, stage: 'accepted' })).toBe(false);
  });

  it('puts the partner\'s scans before BRT\'s first scan beyond its shipping data under BRT\'s, in time order', () => {
    const result = withOriginLeg(brt([scan('DEPARTED', '2026-01-13T21:00:00+01:00', 'in_transit'), scan('COLLECTED', '2026-01-13T18:00:00+01:00', 'accepted'),
      preAdvice('2026-01-12T18:02:00+01:00')]), partner(scan('Sample notice', '2026-01-14T19:00:00+01:00'), scan('Sample transit', '2026-01-13T15:58:00+01:00'),
      scan('Sample sort', '2026-01-12T18:11:00+01:00'), scan('Sample preparation', '2026-01-12T07:45:00+01:00')));
    expect(descriptions(result)).toEqual(['DEPARTED', 'COLLECTED', 'Sample transit', 'Sample sort', 'SHIPPING INFO SENT TO BRT', 'Sample preparation']);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'DEPARTED', last_update: '2026-01-13T21:00:00+01:00' });
    expect(result.history_truncated).toBeUndefined();
  });

  it('takes the partner\'s status while BRT has only the shipping data and the partner has scanned the parcel since', () => {
    const result = withOriginLeg(brt([preAdvice('2026-01-12T10:10:00')], 'pending'),
      partner(scan('Sample on its way', '2026-01-17T00:53:00+01:00'), scan('Sample handed over', '2026-01-12T15:50:00Z')));
    // BRT's wall clock cannot be placed among the partner's instants and stays last.
    expect(descriptions(result)).toEqual(['Sample on its way', 'Sample handed over', 'SHIPPING INFO SENT TO BRT']);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sample on its way', last_update: '2026-01-17T00:53:00+01:00' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.history_truncated).toBeUndefined();
    // Shipping data sent after the partner's last scan keeps BRT's status.
    const sent = withOriginLeg(brt([preAdvice('2026-01-12T18:02:00+01:00')], 'pending'), partner(scan('Sample preparation', '2026-01-12T07:45:00+01:00')));
    expect(descriptions(sent)).toEqual(['SHIPPING INFO SENT TO BRT', 'Sample preparation']);
    expect(sent).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: '2026-01-12T18:02:00+01:00' });
  });

  it('stages the DPD scans DPD\'s own map leaves without one, in the leg before BRT', () => {
    const coded = (code: string, description: string, clock: string, stage?: string) => ({ ...scan(description, clock, stage), provider_code: code });
    const leg = stagedDpdLeg(partner(coded('OTHER', 'Sample update', '2026-01-17T09:00:00+01:00'),
      coded('SPL', 'Your parcel is on its way', '2026-01-17T00:53:00+01:00'), coded('ORI', 'Your parcel arrived at our depot', '2026-01-12T15:50:00Z'),
      coded('PARCEL_HANDED', 'Parcel handed to DPD', '2026-01-12T15:50:00Z')));
    expect(leg.events!.map(event => event.stage)).toEqual([undefined, 'in_transit', 'accepted', 'accepted']);
    // After DPD's own transit or customs scan, an origin depot's intake is no longer the acceptance.
    const imported = stagedDpdLeg(partner(coded('ORI', 'Your parcel arrived at our depot', '2026-01-14T08:00:00Z'),
      coded('CUSTOMS', 'Sample customs', '2026-01-13T08:00:00Z', 'customs')));
    expect(imported.events!.map(event => event.stage)).toEqual(['in_transit', 'customs']);
    // DPD words SPL as moving the parcel on before its origin depot too.
    const early = stagedDpdLeg(partner(coded('ORI', 'Your parcel arrived at our depot', '2026-01-12T15:50:00Z'),
      coded('SPL', 'Your parcel is on its way', '2026-01-12T09:00:00Z')));
    expect(early.events!.map(event => event.stage)).toEqual(['accepted', undefined]);
    expect(stagedDpdLeg({ status: 'in_transit', events: [] })).toEqual({ status: 'in_transit', events: [] });
  });

  it("gives BRT's own scans the stage its status map gives their label", () => {
    const events = parseBrt(html, NUMBER).events!;
    expect(events.some((event) => event.stage === 'delivered')).toBe(true);
    for (const event of events) {
      expect(event.provider_code).toBeUndefined();
      expect(statusMap.stage(null, normalizeStatusWording(event.description ?? '')), event.description).toBe(event.stage);
    }
  });

  it('keeps only partner scans surely before a wall clock, and leaves a shipment without a dated leg as it was', () => {
    const local = brt([scan('COLLECTED', '2026-01-13T18:00:00', 'accepted'), preAdvice('2026-01-12T10:00:00')]);
    const result = withOriginLeg(local, partner(scan('Sample late', '2026-01-13T04:30:00Z'), scan('Sample early', '2026-01-13T03:30:00Z')));
    expect(descriptions(result)).toEqual(['COLLECTED', 'Sample early', 'SHIPPING INFO SENT TO BRT']);
    expect(withOriginLeg(local, partner(scan('Sample late', '2026-01-13T04:30:00Z')))).toBe(local);
    expect(withOriginLeg(local, partner(scan('Sample undated', '2026-01-10T08:00:00')))).toBe(local);
    expect(withOriginLeg(local, { status: 'in_transit', events: [] })).toBe(local);
  });

  it('asks the partner named by the oldest depot about the same BRTcode within the lookup budget', async () => {
    const page = (location: string) => edit($ => $('.table_stato_dati tr').last().children('td').eq(2).text(location));
    const dpd = vi.fn<BrtOriginLookup>(async () => partner(scan('Sample handed over', '2026-01-10T08:00:00Z')));
    const chronopost = vi.fn<BrtOriginLookup>();
    const tracker = (body: string) => new BrtTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body)), origins: { dpd, chronopost } });
    const result = await tracker(page('DPD SAMPLE (990)')).fetch(NUMBER, { budgetMs: 10_000 });
    expect(dpd).toHaveBeenCalledTimes(1);
    expect(dpd.mock.calls[0]![0]).toBe(NUMBER);
    expect(dpd.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(dpd.mock.calls[0]![1].budgetMs).toBeLessThan(10_000);
    expect(chronopost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-01-16T21:07:00+01:00' });
    expect(result.events!.map(event => event.description).slice(-3)).toEqual(['COLLECTED', 'Sample handed over', 'SHIPPING INFO SENT TO BRT']);
    // A shipment that started at one of BRT's depots, or a parcel the partner cannot answer for, keeps BRT's answer.
    expect(await tracker(html).fetch(NUMBER)).toEqual(parseBrt(html, NUMBER));
    expect(dpd).toHaveBeenCalledTimes(1);
    dpd.mockRejectedValueOnce(new IndeterminateError('DPD', 'Sample outage'));
    expect(await tracker(page('DPD SAMPLE (990)')).fetch(NUMBER)).toEqual(parseBrt(page('DPD SAMPLE (990)'), NUMBER));
    // The caller's cancellation still ends the lookup.
    const controller = new AbortController();
    dpd.mockImplementationOnce(async () => { controller.abort(); throw new Error('aborted'); });
    await expect(tracker(page('DPD SAMPLE (990)')).fetch(NUMBER, { signal: controller.signal })).rejects.toBeInstanceOf(Error);
  });

  it('takes a partner\'s answer for a BRTcode BRT has not processed only when it shows the parcel bound for Italy', () => {
    const placed = (location: string) => partnerShipment(partner({ ...scan('Sample transit', '2026-01-13T15:58:00+01:00'), location },
      scan('Sample preparation', '2026-01-12T07:45:00+01:00')));
    for (const location of ['Sample Town - IT (depot 82)', 'Sample Town - IT', 'Sample Town, IT', 'Italy']) {
      expect(placed(location), location).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sample transit',
        destination_country: 'IT', events: [expect.objectContaining({ location }), expect.anything()] });
    }
    const bound = partnerShipment({ ...partner(scan('Sample preparation', '2026-01-12T07:45:00+01:00')), destination_country: 'IT',
      delivery_carrier: 'dpd-de', delivery_tracking_number: OTHER });
    expect(bound).toMatchObject({ destination_country: 'IT', last_update: '2026-01-12T07:45:00+01:00' });
    expect(bound).not.toHaveProperty('delivery_carrier');
    expect(bound).not.toHaveProperty('delivery_tracking_number');
    expect(bound).not.toHaveProperty('history_truncated');
    // A scan elsewhere, a place without a country, another destination or no scan proves nothing.
    for (const location of ['Sample Town - FR (depot 82)', 'Sample Town, DE', 'SAMPLE ITALIA HUB', 'Sample IT Town', '']) expect(placed(location), location).toBeNull();
    expect(partnerShipment({ ...partner(scan('Sample transit', '2026-01-13T15:58:00+01:00')), destination_country: 'FR' })).toBeNull();
    expect(partnerShipment({ status: 'in_transit', destination_country: 'IT', events: [] })).toBeNull();
  });

  it('asks Chronopost, then DPD, about a BRTcode BRT has not processed, and keeps BRT\'s answer when neither shows Italy', async () => {
    const italian = partner({ ...scan('Sample transit', '2026-01-13T15:58:00+01:00'), location: 'Sample Town - IT (depot 82)' });
    const elsewhere = partner({ ...scan('Sample transit', '2026-01-13T15:58:00+01:00'), location: 'Sample Town - FR' });
    const chronopost = vi.fn<BrtOriginLookup>(async () => italian);
    const dpd = vi.fn<BrtOriginLookup>(async () => elsewhere);
    const tracker = (origins = { chronopost, dpd }) => new BrtTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(notFoundPage)), origins });
    expect(await tracker().fetch(NUMBER, { budgetMs: 10_000 })).toEqual(partnerShipment(italian));
    expect(chronopost.mock.calls[0]![0]).toBe(NUMBER);
    expect(chronopost.mock.calls[0]![1].budgetMs).toBeLessThan(10_000);
    expect(dpd).not.toHaveBeenCalled();
    chronopost.mockRejectedValueOnce(new IndeterminateError('Chronopost', 'Sample outage'));
    dpd.mockResolvedValueOnce(partner({ ...scan('Sample transit', '2026-01-13T15:58:00+01:00'), location: 'Sample Town, IT' }));
    expect(await tracker().fetch(NUMBER)).toMatchObject({ destination_country: 'IT', events: [expect.objectContaining({ location: 'Sample Town, IT' })] });
    chronopost.mockResolvedValueOnce(elsewhere);
    await expect(tracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found', provider: 'BRT' });
    expect(dpd).toHaveBeenCalledTimes(2);
    // Shipment numbers, a tracker without partners and BRT's other answers ask no one.
    chronopost.mockClear();
    await expect(tracker().fetch(SHIPMENT)).rejects.toMatchObject({ reason: 'portal_not_found' });
    await expect(new BrtTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(notFoundPage)) }).fetch(NUMBER))
      .rejects.toMatchObject({ reason: 'portal_not_found' });
    await expect(new BrtTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(negative())), origins: { chronopost, dpd } }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(chronopost).not.toHaveBeenCalled();
    // The caller's cancellation still ends the lookup.
    const controller = new AbortController();
    chronopost.mockImplementationOnce(async () => { controller.abort(); throw new Error('aborted'); });
    await expect(tracker().fetch(NUMBER, { signal: controller.signal })).rejects.not.toMatchObject({ reason: 'portal_not_found' });
  });

  it('wires Chronopost to its own endpoint for tracking, and recognizes from BRT alone', async () => {
    const body = edit($ => $('.table_stato_dati tr').last().children('td').eq(2).text('CHR-FR SAMPLE (998)'));
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).startsWith('https://vas.brt.it/') ? response(body) : new Response('', { status: 404 }));
    const instance = adapter(environment(fetcher));
    expect(await instance.recognize!(NUMBER)).toMatchObject({ known: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await instance.track({ number: NUMBER, postcode: null })).toEqual(parseBrt(body, NUMBER));
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url, init] = fetcher.mock.calls[2]!;
    expect(String(url)).toBe('https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS');
    expect(String(init?.body)).toContain(`<skybillNumber>${NUMBER}</skybillNumber>`);
  });
});

describe('BRT through the DPD group while its tracker is down', () => {
  const MAINTENANCE = () => new Response(null, { status: 302, headers: { Location: 'manutenzione_new.htm' } });
  const reply = () => JSON.parse(readFileSync(new URL('./fixtures/group-out-for-delivery.json', import.meta.url), 'utf8')) as
    Record<string, unknown> & { status: Record<string, unknown>; parcelHistory: Record<string, unknown>[] };
  const milestone = (code: string, description: string, time: string, stage?: string): CarrierEvent =>
    ({ time, location: '', description, provider_code: code, ...(stage ? { stage } : {}) });
  const answer = (...events: CarrierEvent[]): CarrierResult => ({ status: 'in_transit', last_status_text: events[0]!.description,
    last_update: events[0]!.time ?? null, history_truncated: true, events });

  it('stages each milestone as in DPD\'s leg, and names BRT as the one the parcel was handed to', () => {
    const handed = milestone('PARCEL_HANDED', 'Parcel handed to DPD', '2026-01-12T18:38:11+01:00');
    const result = groupShipment(answer(milestone('PARCEL_OUT_FOR_DELIVERY', 'Parcel out for delivery', '2026-01-14T08:50:13+01:00', 'out_for_delivery'),
      milestone('AT_DELIVERY_CENTER', 'At delivery center', '2026-01-14T07:43:09+01:00'),
      milestone('IN_TRANSIT', 'Your parcel is on its way', '2026-01-12T22:56:06+01:00'), handed));
    expect(result.events!.map(event => [event.description, event.stage])).toEqual([['Parcel out for delivery', 'out_for_delivery'],
      ['At delivery center', 'in_transit'], ['Your parcel is on its way', 'in_transit'], ['Parcel handed to BRT', 'accepted']]);
    expect(result).toMatchObject({ last_status_text: 'Parcel out for delivery', history_truncated: true });
    expect(groupShipment(answer(handed))).toMatchObject({ last_status_text: 'Parcel handed to BRT', events: [{ description: 'Parcel handed to BRT', stage: 'accepted' }] });
  });

  it('asks the group about a BRTcode only while BRT\'s tracker is down, and keeps the outage when the group cannot answer', async () => {
    const group = vi.fn<BrtOriginLookup>(async () => answer(milestone('IN_TRANSIT', 'Your parcel is on its way', '2026-01-12T22:56:06+01:00'),
      milestone('PARCEL_HANDED', 'Parcel handed to DPD', '2026-01-12T18:38:11+01:00')));
    const tracker = (reply = MAINTENANCE) => new BrtTracker({ fetcher: vi.fn<typeof fetch>(async () => reply()), group });
    const result = await tracker().fetch(NUMBER, { budgetMs: 10_000 });
    expect(group).toHaveBeenCalledTimes(1);
    expect(group.mock.calls[0]![0]).toBe(NUMBER);
    expect(group.mock.calls[0]![1].budgetMs).toBeLessThan(10_000);
    expect(result.events!.map(event => [event.description, event.stage])).toEqual([['Your parcel is on its way', 'in_transit'], ['Parcel handed to BRT', 'accepted']]);
    group.mockRejectedValueOnce(new IndeterminateError('BRT', 'DPD returned no Italian country evidence'));
    await expect(tracker().fetch(NUMBER)).rejects.toBeInstanceOf(MaintenanceError);
    // Shipment numbers, BRT's own answers and its other failures ask no one.
    group.mockClear();
    await expect(tracker().fetch(SHIPMENT)).rejects.toBeInstanceOf(MaintenanceError);
    expect(await tracker(() => response()).fetch(NUMBER)).toEqual(parseBrt(html, NUMBER));
    await expect(tracker(() => new Response('', { status: 404 })).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(group).not.toHaveBeenCalled();
  });

  it('reads the guest service as BRT\'s unit for a parcel DPD places in Italy, and nowhere else', async () => {
    const routed = (details: () => Response) => vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith('https://vas.brt.it/')) return MAINTENANCE();
      if (url.includes('firebaseinstallations')) return Response.json({ fid: 'synthetic-fid', authToken: { token: 'synthetic-installation', expiresIn: '604800s' } });
      if (url.includes('firebaseremoteconfig')) return Response.json({ entries: { basic_dpd_token: 'c3ludGhldGljOnRva2Vu' } }); // gitleaks:allow
      if (url.includes('/oauth/token')) return Response.json({ access_token: 'synthetic-access', expires_in: 3600 });
      return details();
    });
    const fetcher = routed(() => Response.json(reply()));
    const result = await adapter(environment(fetcher)).track({ number: NUMBER, postcode: null });
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-10-30T08:50:13+01:00',
      expected_delivery: '2026-10-30', history_truncated: true, tracking_url: `https://www.mybrt.it/it/mybrt/my-parcels/search?parcelNumber=${NUMBER}` });
    expect(result.events!.map(event => [event.provider_code, event.stage])).toEqual([['PARCEL_OUT_FOR_DELIVERY', 'out_for_delivery'],
      ['AT_DELIVERY_CENTER', 'in_transit'], ['IN_TRANSIT', 'in_transit'], ['PARCEL_HANDED', 'accepted']]);
    const details = new URL(String(fetcher.mock.calls.at(-1)![0]));
    expect(details.pathname).toBe(`/concept/webservice/v10/parcels/details/${NUMBER}`);
    expect(details.searchParams.get('businessUnit')).toBe('DPD-IT');
    // Placed in another country or in none, the parcel can be another unit's: BRT's outage stands.
    for (const countryCode of ['DE', null]) {
      const elsewhere = routed(() => Response.json({ ...reply(), status: { ...reply().status, countryCode } }));
      await expect(adapter(environment(elsewhere)).track({ number: NUMBER, postcode: null }), String(countryCode)).rejects.toBeInstanceOf(MaintenanceError);
    }
    // Recognition reads BRT alone.
    await expect(adapter(environment(routed(() => Response.json(reply())))).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'maintenance' });
  });
});

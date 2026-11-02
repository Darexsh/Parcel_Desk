import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NotFoundError, SchemaError, InvalidInputError } from '../../core/errors/index.js';
import {
  normalizePosteItalianeTrackingNumber,
  posteItalianeTrackingUrl,
  parsePosteItalianeTrackingResponse,
  PosteItalianeTracker,
  adapter,
  CAPTCHA_PAUSE_MS,
  HOURLY_SEARCHES,
} from './adapter.js';
import { trackingLocationCountry, trackingPlace } from '../../places/trackingLocation.js';
import { classifyPosteItalianeStatus } from './status.js';
import { sameInstantIdentityPolicy } from './identity.js';
import { TrawlClient, type TrawlCapturedResponse } from '../../core/transport/trawl.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fetchPosteItalianeInBrowser } from './browser.js';

vi.mock('./browser.js', () => ({ fetchPosteItalianeInBrowser: vi.fn() }));

// All identifiers and timestamps below are synthetic. Italian status wordings
// reuse the vendor's fixed texts confirmed against a real parcel by the
// prior-art client, so classification exercises production prose rather than
// paraphrases.
const TRACKING_NUMBER = 'RA00000000001';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function movement(wording: string, millis: number) {
  return { statoLavorazione: wording, dataOra: millis, luogo: 'Test Depot' };
}

function parcel(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(DELIVERED), ...overrides };
}

function response(value: unknown, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Poste Italiane tracking normalization', () => {
  it('accepts the detected Poste Italiane families and rejects the rest', () => {
    expect(normalizePosteItalianeTrackingNumber('ra00000000001')).toBe(TRACKING_NUMBER);
    expect(normalizePosteItalianeTrackingNumber('1UW1G2J193065')).toBe('1UW1G2J193065');
    expect(normalizePosteItalianeTrackingNumber('2IMA0051035900')).toBe('2IMA0051035900');
    expect(normalizePosteItalianeTrackingNumber('cw 123 456 785 it')).toBe('CW123456785IT');
    expect(normalizePosteItalianeTrackingNumber('CP123456785IT')).toBe('CP123456785IT');
    // International Express: ZC, nine digits and IT, whatever the last digit.
    expect(normalizePosteItalianeTrackingNumber('zc 900 000 001 it')).toBe('ZC900000001IT');
    // PROMOPACCO PLUS: F, three digits, D and eight digits.
    expect(normalizePosteItalianeTrackingNumber('f990d00000001')).toBe('F990D00000001');
    // D, five digits, a letter and six digits.
    expect(normalizePosteItalianeTrackingNumber('d99000a000001')).toBe('D99000A000001');
    // Registered mail: eleven digits and the check digit, printed after a dash or a space.
    expect(normalizePosteItalianeTrackingNumber('99000000001-0')).toBe('990000000010');
    expect(normalizePosteItalianeTrackingNumber('99000000001 0')).toBe('990000000010');
    for (const raw of ['12345', 'Z8328162951', 'CW123456780IT', 'CP123456780FR', 'ZD900000001IT', 'F990D0000001', 'F990E00000001',
      'D9900A000001', 'D990000000001', 'E99000A000001', '990000000011', '99000000001', '9900000000100', '']) {
      expect(() => normalizePosteItalianeTrackingNumber(raw)).toThrow(InvalidInputError);
    }
    expect(posteItalianeTrackingUrl(TRACKING_NUMBER)).toBe(
      'https://www.poste.it/cerca/index.html#/risultati-spedizioni/RA00000000001',
    );
  });

  it('claims the Poste Delivery Web and Express codes of parcels booked online, and nothing near them', () => {
    for (const number of ['GF00000000001', 'EF60000000001', 'EG00000000001', 'JG00000000001', 'LF40000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'poste-italiane', confidence: 'high' });
      expect(normalizePosteItalianeTrackingNumber(number.toLowerCase().replace(/^(..)/, '$1 ')), number).toBe(number);
    }
    for (const raw of ['GF0000000001', 'GF000000000001', 'GX00000000001', 'LG00000000001', 'EH00000000001', 'JG000000000001']) {
      expect(detectCarrierMatch(raw).candidates, raw).not.toContain('poste-italiane');
    }
  });

  it('suggests Poste first for a Deliverybox code, whose ninth digit is no S10 check, and claims Posta1 codes', () => {
    expect(detectCarrierMatch('XZ000000004IT')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['poste-italiane'], preferred: ['poste-italiane'] });
    expect(recognitionAskedCarriers('XZ000000004IT')[0]).toBe('poste-italiane');
    expect(normalizePosteItalianeTrackingNumber('xz 000 000 004 it')).toBe('XZ000000004IT');
    for (const raw of ['XR000000004IT', 'XZ000000004FR', 'XZ00000004IT']) {
      expect(detectCarrierMatch(raw).candidates, raw).not.toContain('poste-italiane');
    }
    for (const number of ['2IVC0000A00001', '2IVC0000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'poste-italiane', confidence: 'high' });
    }
    for (const raw of ['2IVC000000001', '2IVC00000AA001', '2IVD0000000001']) {
      expect(detectCarrierMatch(raw).carrier, raw).not.toBe('poste-italiane');
    }
  });

  it('claims Business Internazionale Plus codes and the plate wrapping a code, and nothing near them', () => {
    expect(normalizePosteItalianeTrackingNumber('8uw1a2b345678')).toBe('8UW1A2B345678');
    expect(normalizePosteItalianeTrackingNumber('jjita 8uw1a2b345678')).toBe('JJITA8UW1A2B345678');
    for (const number of ['8UW1A2B345678', 'JJITA8UW1A2B345678', 'JJITA1UW1G2J193065']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'poste-italiane', confidence: 'high' });
    }
    for (const raw of ['2UW1A2B345678', 'JJITA8UW1A2B34567', 'JJITA8UW1A2B3456789', 'JJITB8UW1A2B345678', 'JJD8UW1A2B345678']) {
      expect(() => normalizePosteItalianeTrackingNumber(raw), raw).toThrow(InvalidInputError);
      expect(detectCarrierMatch(raw).carrier, raw).not.toBe('poste-italiane');
    }
  });

  it('takes the S10 number of mail from abroad for a hand-off, which detection leaves to the sending post', () => {
    for (const number of ['RR123456785DE', 'LF123456785DE', 'CP123456785FR', 'LX123456785NL', 'RA123456785CN']) {
      expect(normalizePosteItalianeTrackingNumber(number.toLowerCase()), number).toBe(number);
      expect(detectCarrierMatch(number).candidates, number).not.toContain('poste-italiane');
    }
    for (const raw of ['RR123456780DE', 'RR12345678DE', 'RR1234567855DE', 'R1123456785DE']) {
      expect(() => normalizePosteItalianeTrackingNumber(raw), raw).toThrow(InvalidInputError);
    }
  });

  it('takes the DHL Parcel Connect plates partners hand over, which detection leaves to DHL', () => {
    expect(normalizePosteItalianeTrackingNumber('jjd 000000000000000000001')).toBe('JJD000000000000000000001');
    for (const raw of ['JJD00000000000000000001', 'JJD0000000000000000000001', 'JJD0000000000000001', 'JJD00000000000000000000A']) {
      expect(() => normalizePosteItalianeTrackingNumber(raw)).toThrow(InvalidInputError);
    }
    const detected = detectCarrierMatch('JJD000000000000000000001');
    expect(detected).toMatchObject({ carrier: 'dhl', confidence: 'high' });
    expect(detected.candidates).not.toContain('poste-italiane');
  });

  it('uses complete SDA candidates for the request and recognition identity', async () => {
    const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null,
      recorder: { step() {}, lookup() {} } });
    for (const number of ['990001A000001', '3C9900A000001', '1C9900A000001', '9C9900A000001', '990A00000001A']) {
      expect(normalizePosteItalianeTrackingNumber(number.toLowerCase())).toBe(number);
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        expect(JSON.parse(String(init?.body)).codiceSpedizione).toBe(number);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return response(parcel({ idTracciatura: number }));
      });
      expect(await adapter(environment(fetcher)).recognize!(number)).toEqual({ known: true, lastActivityAt: '2026-01-04T00:00:00.000Z' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const wrong = vi.fn<typeof fetch>().mockResolvedValue(response(parcel({ idTracciatura: TRACKING_NUMBER })));
      await expect(adapter(environment(wrong)).recognize!(number)).rejects.toMatchObject({ kind: 'schema' });
    }
    const empty = vi.fn<typeof fetch>().mockResolvedValue(response(parcel({ idTracciatura: '990001A000001', esitoRicerca: '2', listaMovimenti: [] })));
    expect(await adapter(environment(empty)).recognize!('990001A000001')).toEqual({ known: false });
    const letter = vi.fn<typeof fetch>().mockResolvedValue(response({ idTracciatura: '990000000010', tipoSpedizione: 'C', esitoRicerca: '3', stato: '1' }));
    expect(await adapter(environment(letter)).recognize!('990000000010')).toEqual({ known: false });
    const failedCheck = vi.fn<typeof fetch>();
    expect(await adapter(environment(failedCheck)).recognize!('990000000011')).toEqual({ known: false });
    expect(failedCheck).not.toHaveBeenCalled();
    for (const number of ['990001AA000001', '3C9900A0000010', '2C9900A000001', 'ABCDEF0000001']) {
      expect(() => normalizePosteItalianeTrackingNumber(number)).toThrow(InvalidInputError);
    }
  });
});

describe('Poste Italiane response parsing', () => {
  it('rejects identity-only shells and invalid-only history without reporting parcel absence', () => {
    for (const payload of [
      { idTracciatura: TRACKING_NUMBER },
      { idTracciatura: TRACKING_NUMBER, esitoRicerca: '3' },
      parcel({ listaMovimenti: [null, 'not a record', {}, movement('', 1767484800000), movement('Delivered', -1)] }),
      parcel({ listaMovimenti: [movement('Delivered', 1e100)] }),
      parcel({ esitoRicerca: 'unexpected', listaMovimenti: [] }),
    ]) {
      expect(() => parsePosteItalianeTrackingResponse(payload, TRACKING_NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePosteItalianeTrackingResponse({ idTracciatura: TRACKING_NUMBER, listaMovimenti: [] }, TRACKING_NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('uses scalar envelope codes without treating an array as delivered', () => {
    const active = { listaMovimenti: [movement('la spedizione è in transito presso', Date.UTC(2026, 0, 2))] };
    for (const stato of ['5', 5]) {
      expect(parsePosteItalianeTrackingResponse(parcel({ ...active, stato }), TRACKING_NUMBER).status).toBe('delivered');
    }
    for (const stato of [['5'], { value: '5' }]) {
      expect(parsePosteItalianeTrackingResponse(parcel({ ...active, stato }), TRACKING_NUMBER).status).toBe('in_transit');
    }
  });

  it('returns delivered history newest-first with UTC epoch times', () => {
    const result = parsePosteItalianeTrackingResponse(parcel(), TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'la spedizione è stata consegnata',
      last_update: '2026-01-04T00:00:00.000Z',
      // The estimate is meaningless once delivered, so it is cleared even though
      // the envelope carries dataPrevistaConsegna (checked on active parcels below).
      expected_delivery: null,
    });
    expect(result.events?.map((event) => [(event.description ?? '').slice(0, 30), event.stage, event.time])).toEqual([
      ['la spedizione è stata consegna', 'delivered', '2026-01-04T00:00:00.000Z'],
      ['la spedizione è in consegna', 'out_for_delivery', '2026-01-03T00:00:00.000Z'],
      ['la spedizione è in transito pr', 'in_transit', '2026-01-02T00:00:00.000Z'],
      ['la spedizione è stata presa in', 'accepted', '2026-01-01T00:00:00.000Z'],
    ]);
  });

  it('reads a delivery on the return trip as returned to the sender', () => {
    const trip = (flag: boolean | undefined) => ({ ...movement('la spedizione è stata consegnata', 1767657600000),
      ...(flag === undefined ? {} : { flagRitorno: flag }) });
    const history = (last: Record<string, unknown>) => [
      { ...movement('la spedizione è in transito', 1767312000000), flagRitorno: false },
      { ...movement('consegna non andata a buon fine perché l\'indirizzo del destinatario risulta errato o incompleto. Contatta Assistenza', 1767398400000), flagRitorno: false },
      { ...movement('in restituzione al mittente', 1767484800000), flagRitorno: true },
      { ...movement('la spedizione è in transito', 1767571200000), flagRitorno: true },
      last,
    ];
    const returned = parsePosteItalianeTrackingResponse(parcel({ flagRitorno: true, listaMovimenti: history(trip(true)) }), TRACKING_NUMBER);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned',
      last_status_text: 'la spedizione è stata consegnata', expected_delivery: null });
    expect(returned.events?.map((event) => event.stage)).toEqual(['delivered', 'in_transit', 'returned', 'failed_attempt', 'in_transit']);
    // Without per-movement flags, the envelope flag and the return scan decide.
    expect(parsePosteItalianeTrackingResponse(parcel({ flagRitorno: true, listaMovimenti: history(trip(undefined)) }), TRACKING_NUMBER))
      .toMatchObject({ status: 'exception', current_stage: 'returned' });
    // A delivery outside the return trip stays a delivery.
    expect(parsePosteItalianeTrackingResponse(parcel({ flagRitorno: true, listaMovimenti: history(trip(false)) }), TRACKING_NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parsePosteItalianeTrackingResponse(parcel({ flagRitorno: false, listaMovimenti: history(trip(undefined)) }), TRACKING_NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('maps documented wordings and reports unmapped ones as unknown', () => {
    const cases: Array<[string, string, string]> = [
      ['a seguito di acquisto da poste.it', 'pending', 'registered'],
      // ASCII-apostrophe variant observed live on a delivered parcel.
      ["la spedizione e' stata consegnata", 'delivered', 'delivered'],
      ['completata la fase di verifica per lo svincolo doganale', 'in_transit', 'in_transit'],
      ['consegna non andata a buon fine, riproveremo', 'exception', 'failed_attempt'],
      ['in restituzione al mittente', 'exception', 'returned'],
      ['disponibile per il ritiro dal giorno lavorativo successivo alla data indicata', 'out_for_delivery', 'ready_for_pickup'],
      ['Disponibile per il ritiro entro i termini indicati su SMS/email', 'out_for_delivery', 'ready_for_pickup'],
      ["all'estero", 'in_transit', 'in_transit'],
      ['sono in corso delle verifiche sulla spedizione. contatta assistenza', 'exception', 'failed_attempt'],
    ];
    for (const [wording, status, stage] of cases) {
      expect(classifyPosteItalianeStatus(wording)).toEqual({ status, stage });
      const result = parsePosteItalianeTrackingResponse(parcel({
        stato: '4',
        listaMovimenti: [movement(wording, 1767484800000)],
      }), TRACKING_NUMBER);
      expect(result).toMatchObject({ status, current_stage: stage });
    }
    // The Italian estimate text reduces to its local calendar day on active parcels.
    expect(parsePosteItalianeTrackingResponse(parcel({
      stato: '4',
      listaMovimenti: [movement('la spedizione è in consegna', 1767484800000)],
    }), TRACKING_NUMBER).expected_delivery).toBe('2026-01-02');
    expect(classifyPosteItalianeStatus('qualcosa di completamente nuovo')).toBeUndefined();
    const unknown = parsePosteItalianeTrackingResponse(parcel({
      stato: '4',
      listaMovimenti: [movement('qualcosa di completamente nuovo', 1767484800000)],
    }), TRACKING_NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'qualcosa di completamente nuovo' });
    // No explicit mapping means no stage at all: the sync classifies the raw
    // wording and records where the final stage came from.
    expect(unknown.events?.[0]).toMatchObject({ description: 'qualcosa di completamente nuovo' });
    expect(unknown.events?.[0]?.stage).toBeUndefined();
  });

  it('binds the idTracciatura echo and honors the esito envelope', () => {
    expect(() => parsePosteItalianeTrackingResponse(parcel({ idTracciatura: 'RA00000000002' }), TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parsePosteItalianeTrackingResponse(parcel({ idTracciatura: undefined }), TRACKING_NUMBER))
      .toThrow(SchemaError);
    // Documented unknown outcomes, with or without movements present.
    expect(() => parsePosteItalianeTrackingResponse(parcel({ esitoRicerca: '1', listaMovimenti: [] }), TRACKING_NUMBER))
      .toThrow(NotFoundError);
    expect(() => parsePosteItalianeTrackingResponse(parcel({ esitoRicerca: '2', listaMovimenti: [] }), TRACKING_NUMBER))
      .toThrow(NotFoundError);
    // Observed expired shape: no esitoRicerca, empty movements.
    expect(() => parsePosteItalianeTrackingResponse(
      { idTracciatura: TRACKING_NUMBER, tipoSpedizione: 'P', listaMovimenti: [] }, TRACKING_NUMBER,
    )).toThrow(NotFoundError);
    // Found parcel awaiting its first scan stays pending, not unknown.
    expect(parsePosteItalianeTrackingResponse(parcel({ stato: '4', listaMovimenti: [] }), TRACKING_NUMBER))
      .toMatchObject({ status: 'pending', current_stage: 'registered', events: [] });
    expect(() => parsePosteItalianeTrackingResponse(null, TRACKING_NUMBER)).toThrow(SchemaError);
    expect(() => parsePosteItalianeTrackingResponse(parcel({ listaMovimenti: {} }), TRACKING_NUMBER))
      .toThrow(SchemaError);
  });

  it('reads registered mail held at a post office for collection', () => {
    const REGISTERED = JSON.parse(readFileSync(new URL('./fixtures/registered-mail.json', import.meta.url), 'utf8')) as unknown;
    const result = parsePosteItalianeTrackingResponse(REGISTERED, '99000000001-0');
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'ready_for_pickup',
      last_update: '2026-01-03T08:00:00.000Z',
      service_name: 'RACC. GENERICHE',
    });
    expect(result.events?.map((event) => [event.stage, event.location, event.time])).toEqual([
      ['ready_for_pickup', 'PROVA CENTRO', '2026-01-03T08:00:00.000Z'],
      ['in_transit', 'CENTRO DI PROVA', '2026-01-02T21:30:00.000Z'],
      ['accepted', 'PROVA 99', '2026-01-01T10:00:00.000Z'],
    ]);
    // The movements' ends of sentences read after the label the page gives their box.
    expect(result.events?.map((event) => event.description)).toEqual([
      'la spedizione sarà disponibile per il ritiro presso l\'Ufficio Postale a partire dal 04/01/26',
      'In transito',
      'Presa in carico da un nostro operatore presso l\'Ufficio Postale',
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of ['VIA DI PROVA', '00000', '9999', '08:20', 'frazionario']) expect(serialized).not.toContain(secret);
  });

  it('words registered mail\'s movements as the official page heads them, by their box', () => {
    const REGISTERED = JSON.parse(readFileSync(new URL('./fixtures/registered-mail.json', import.meta.url), 'utf8')) as {
      listaMovimenti: Array<Record<string, unknown>>;
    };
    const [intake, sorted] = REGISTERED.listaMovimenti as [Record<string, unknown>, Record<string, unknown>];
    const read = (movements: Array<Record<string, unknown>>, stato = '5') => parsePosteItalianeTrackingResponse(
      { ...REGISTERED, stato, listaMovimenti: movements }, '99000000001-0');
    const delivered = read([
      { ...intake, statoLavorazione: 'a seguito di acquisto da poste.it' },
      sorted,
      { ...sorted, dataOra: 1767427200000, statoLavorazione: 'in data', box: '4' },
      { ...sorted, dataOra: 1767427215000, statoLavorazione: 'con successo in data', box: 5 },
    ]);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Consegnata con successo' });
    expect(delivered.events?.map((event) => [event.description, event.stage])).toEqual([
      ['Consegnata con successo', 'delivered'],
      ['In consegna', 'out_for_delivery'],
      ['In transito', 'in_transit'],
      ['Presa in carico a seguito di acquisto da poste.it', 'registered'],
    ]);
    expect(read([{ ...intake, statoLavorazione: 'da un nostro operatore' }, { ...sorted, statoLavorazione: 'presso il paese estero in data' }], '3')
      .events?.map((event) => [event.description, event.stage])).toEqual([
      ['In transito presso il paese estero', 'in_transit'],
      ['Presa in carico da un nostro operatore', 'accepted'],
    ]);
    // A full sentence, a fragment without a known box and an unknown box keep their wording.
    expect(read([
      { ...intake, statoLavorazione: 'la spedizione è in transito', box: '3' },
      { ...sorted, statoLavorazione: 'in data', box: undefined },
      { ...sorted, dataOra: 1767427200000, statoLavorazione: 'con successo in data', box: '9' },
    ], '3').events?.map((event) => event.description)).toEqual(['con successo in data', 'in data', 'la spedizione è in transito']);
  });

  it('lets a later return outrank a delivery, as for a parcel left at a pickup point and not collected', () => {
    const outbound = [
      movement('la spedizione è in consegna', 1767225600000),
      movement('la spedizione è stata consegnata', 1767312000000),
    ];
    for (const stato of ['5', '4', '6']) {
      // The return scan itself, or a movement on the way back, whatever the flags say.
      for (const back of [
        [movement('in restituzione al mittente', 1767398400000), movement('la spedizione è in consegna', 1767484800000)],
        [{ ...movement('la spedizione è in transito', 1767398400000), flagRitorno: true }],
      ]) {
        expect(parsePosteItalianeTrackingResponse(parcel({ stato, flagRitorno: false, listaMovimenti: [...outbound, ...back] }), TRACKING_NUMBER))
          .toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: back.at(-1)!.statoLavorazione, expected_delivery: null });
      }
    }
    // Movements before the delivery, or after it without a return, leave it delivered.
    const delivered = [movement('in restituzione al mittente', 1767139200000), ...outbound];
    expect(parsePosteItalianeTrackingResponse(parcel({ listaMovimenti: delivered }), TRACKING_NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parsePosteItalianeTrackingResponse(parcel({
      listaMovimenti: [...outbound, { ...movement('la spedizione è in transito', 1767398400000), flagRitorno: false }],
    }), TRACKING_NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('follows an item from abroad under the sending post\'s S10 number', async () => {
    const FROM_ABROAD = JSON.parse(readFileSync(new URL('./fixtures/from-abroad.json', import.meta.url), 'utf8')) as unknown;
    const result = parsePosteItalianeTrackingResponse(FROM_ABROAD, 'lx 123 456 785 jp');
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-01-03T00:00:00.000Z',
      expected_delivery: '2026-01-05',
    });
    expect(result.events?.map((event) => [event.stage, event.time])).toEqual([
      ['out_for_delivery', '2026-01-03T00:00:00.000Z'],
      ['in_transit', '2026-01-02T00:00:00.000Z'],
      ['in_transit', '2026-01-01T00:00:00.000Z'],
    ]);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).codiceSpedizione).toBe('LX123456785JP');
      return response(FROM_ABROAD);
    });
    expect(await new PosteItalianeTracker({ fetcher }).fetch('LX123456785JP')).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('passes on the import charges an item from abroad owes, in euros', () => {
    const FROM_ABROAD = JSON.parse(readFileSync(new URL('./fixtures/from-abroad.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const oneri = { importoDirittiDoganali: '1234', importoDirittiPostali: '2100', importoDirittiPostaliSmart: '1800' };
    expect(parsePosteItalianeTrackingResponse({ ...FROM_ABROAD, oneri: { ...oneri, statoOneri: 'PAGATO' } }, 'LX123456785JP').import_charges)
      .toEqual({ currency: 'EUR', customs: 12.34, carrier_fee: 21, carrier_fee_online: 18, paid: true, status_code: 'PAGATO' });
    // A closed payment window leaves the price on delivery, and says nothing sure about payment.
    expect(parsePosteItalianeTrackingResponse({ ...FROM_ABROAD, oneri: { ...oneri, statoOneri: 'FINESTRA_PAGAMENTO_CHIUSA' } }, 'LX123456785JP')
      .import_charges).toEqual({ currency: 'EUR', customs: 12.34, carrier_fee: 21, status_code: 'FINESTRA_PAGAMENTO_CHIUSA' });
    for (const empty of [undefined, null, {}, { importoDirittiDoganali: '12,34', statoOneri: '' }]) {
      expect(parsePosteItalianeTrackingResponse({ ...FROM_ABROAD, oneri: empty }, 'LX123456785JP')).not.toHaveProperty('import_charges');
    }
  });

  it('reads the bare letter-post answer for a code Poste does not know as not found', () => {
    const unknown = { idTracciatura: '990000000010', tipoSpedizione: 'C', esitoRicerca: '3', stato: '1', sintesiStato: '', azioni: '',
      actionsMap: {}, statoDaVerificare: false };
    expect(() => parsePosteItalianeTrackingResponse(unknown, '990000000010')).toThrow(NotFoundError);
    // A product, a movement list, another state or a parcel type is not that answer.
    for (const changed of [{ tipoProdotto: 'RACC. GENERICHE' }, { stato: '4' }, { tipoSpedizione: 'P' }, { esitoRicerca: undefined }]) {
      expect(() => parsePosteItalianeTrackingResponse({ ...unknown, ...changed }, '990000000010')).not.toThrow(NotFoundError);
    }
    expect(parsePosteItalianeTrackingResponse({ ...unknown, listaMovimenti: [] }, '990000000010'))
      .toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('skips unusable rows without losing the shipment', () => {
    const result = parsePosteItalianeTrackingResponse(parcel({
      listaMovimenti: [
        movement('la spedizione è stata consegnata', 1767484800000),
        movement('la spedizione è stata consegnata', 1767484800000),
        movement('', 1767484800000),
        movement('la spedizione è stata consegnata', -5),
        'not a record',
      ],
    }), TRACKING_NUMBER);
    expect(result.events).toHaveLength(1);
  });

  it('locates a post-office scan at its office without the office address, postcode or hours', () => {
    const result = parsePosteItalianeTrackingResponse(parcel({
      stato: '3',
      listaMovimenti: [
        { ...movement('la spedizione è stata presa in carico da un nostro operatore presso l\'Ufficio Postale', 1767225600000),
          idUfficio: '99999', denominazioneUfficio: 'UFFICIO DI PROVA', indirizzoUfficio: 'VIA DI PROVA 1', capUfficio: '00000',
          provinciaUfficio: 'XX', orarioLunedi: '08:20-13:35', frazionario: '99999' },
        movement('la spedizione è in transito', 1767312000000),
      ],
    }), TRACKING_NUMBER);
    expect(result.events?.map((event) => [event.stage, event.location])).toEqual([
      ['in_transit', ''],
      ['accepted', 'UFFICIO DI PROVA'],
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of ['VIA DI PROVA', '00000', '99999', '08:20', 'Test Depot']) expect(serialized).not.toContain(secret);
  });

  it('reads a drop-off at a Punto Poste as accepted', () => {
    const result = parsePosteItalianeTrackingResponse(parcel({ stato: '3', listaMovimenti: [
      movement('la spedizione è stata presa in carico presso il Punto Poste', 1767225600000),
    ] }), TRACKING_NUMBER);
    expect(result.events?.map((event) => event.stage)).toEqual(['accepted']);
    expect(result.current_stage).toBe('accepted');
  });

  it('reads the later of two movements sharing an instant as the newer', () => {
    const delivered = parsePosteItalianeTrackingResponse(parcel({ listaMovimenti: [
      movement('la spedizione è in consegna', 1767398400000),
      movement('la spedizione è stata consegnata', 1767398400000),
    ] }), TRACKING_NUMBER);
    expect(delivered.last_status_text).toBe('la spedizione è stata consegnata');
    const moving = parsePosteItalianeTrackingResponse(parcel({ stato: '4', listaMovimenti: [
      movement('la spedizione è in transito', 1767398400000),
      movement('la spedizione è in consegna', 1767398400000),
    ] }), TRACKING_NUMBER);
    expect(moving).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'la spedizione è in consegna' });
  });

  it('locates depot scans at their town and province and names the product', () => {
    const result = parsePosteItalianeTrackingResponse(parcel({
      tipoProdotto: 'CRONO ECONOMY',
      listaMovimenti: [
        { ...movement('la spedizione è in transito', 1767225600000), luogo: 'EXAMPLE TOWN (XX)' },
        { ...movement('la spedizione è in consegna', 1767312000000), luogo: 'SAN EXAMPLE DI PROVA XX' },
        { ...movement('la spedizione è stata consegnata', 1767398400000), luogo: 'dalla sede operativa di EXAMPLE TOWN (XX)' },
      ],
    }), TRACKING_NUMBER);
    expect(result.service_name).toBe('CRONO ECONOMY');
    expect(result.events?.map((event) => event.location)).toEqual(['EXAMPLE TOWN (XX), IT', 'SAN EXAMPLE DI PROVA (XX), IT', 'EXAMPLE TOWN (XX), IT']);
    const office = parsePosteItalianeTrackingResponse(parcel({
      tipoProdotto: TRACKING_NUMBER,
      listaMovimenti: [
        { ...movement('la spedizione è stata consegnata', 1767398400000), luogo: 'Ufficio Postale EXAMPLE VIA DI PROVA 1, 00000 EXAMPLE (XX)' },
      ],
    }), TRACKING_NUMBER);
    expect(office.service_name).toBeUndefined();
    expect(office.events?.[0]?.location).toBe('');
    expect(JSON.stringify(office)).not.toContain('VIA DI PROVA');
    // A street named with its province is an address, not a town.
    for (const street of ['VIA DI PROVA XX', 'PIAZZA EXAMPLE (XX)', 'CORSO EXAMPLE XX', 'LOCALITÀ EXAMPLE (XX)', 'dalla sede operativa di VIALE EXAMPLE (XX)']) {
      const scan = parsePosteItalianeTrackingResponse(parcel({
        listaMovimenti: [{ ...movement('la spedizione è in transito', 1767225600000), luogo: street }],
      }), TRACKING_NUMBER);
      expect(scan.events?.[0]?.location).toBe('');
    }
  });

  it('writes the country after a province that is also a country code', () => {
    // Turin's province is Tonga's code, Naples' Namibia's and Bologna's Bolivia's.
    const result = parsePosteItalianeTrackingResponse(parcel({
      listaMovimenti: ['TORINO (TO)', 'NAPOLI NA', 'BOLOGNA (BO)'].map((luogo, index) => (
        { ...movement('la spedizione è in transito', 1767225600000 + index * 3_600_000), luogo })),
    }), TRACKING_NUMBER);
    const locations = result.events!.map((event) => event.location!);
    expect(locations).toEqual(['BOLOGNA (BO), IT', 'NAPOLI (NA), IT', 'TORINO (TO), IT']);
    for (const location of locations) {
      expect(trackingPlace(location)).toEqual({ country: 'IT', place: location.slice(0, -4) });
      expect(trackingLocationCountry(location)).toBe('IT');
    }
  });

  it('never retains customer, dimension, office, place or estimate-source data', () => {
    const result = parsePosteItalianeTrackingResponse(parcel({
      nombre_cliente: 'Example Customer',
      nom_codired: 'OFICINA EXAMPLE',
      dataPrevistaConsegna: 'garbage',
    }), TRACKING_NUMBER);
    const serialized = JSON.stringify(result);
    for (const secret of [
      'Example Customer', 'OFICINA EXAMPLE', 'nombre_cliente', 'nom_codired', 'garbage',
      'Example Recipient', 'Via Esempio 1', 'Example Signature', 'UFFICIO ESEMPIO CENTRALE',
      'Example Sender S.p.A.', 'Test Depot', 'destinatario', 'firmaDestinatario', 'peso',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.expected_delivery).toBeNull();
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'eta', 'location', 'service_name', 'import_charges']);
    const delivered = parsePosteItalianeTrackingResponse(parcel(), TRACKING_NUMBER);
    expect(delivered.events?.length).toBeGreaterThan(0);
    expect(delivered.service_name).toBe('POSTEDELIVERY EUROPE');
    expect(parsePosteItalianeTrackingResponse(parcel({ oneri: { importoDirittiDoganali: '500' } }), TRACKING_NUMBER).import_charges)
      .toEqual({ currency: 'EUR', customs: 5 });
    const accepted = parsePosteItalianeTrackingResponse(parcel({ listaMovimenti: [
      { ...movement('la spedizione è stata presa in carico', 1767225600000), denominazioneUfficio: 'UFFICIO DI PROVA' },
    ] }), TRACKING_NUMBER);
    expect(accepted.events?.[0]?.location).toBe('UFFICIO DI PROVA');
    // The estimate only exists while the parcel is still moving.
    const active = parsePosteItalianeTrackingResponse(parcel({
      stato: '4',
      listaMovimenti: [movement('la spedizione è in consegna', 1767484800000)],
    }), TRACKING_NUMBER);
    expect(active.expected_delivery).toBe('2026-01-02');
  });
});

describe('Poste Italiane scan identity', () => {
  it('lets a registered-mail movement stored as the end of its sentence take the sentence in place', () => {
    const matches = sameInstantIdentityPolicy.matches!;
    const stored = { stage: 'registered', description: 'da un nostro operatore presso l\'Ufficio Postale', location: 'UFFICIO DI PROVA', providerCode: '' };
    const incoming = { ...stored, stage: 'accepted', description: 'Presa in carico da un nostro operatore presso l\'Ufficio Postale' };
    expect(matches(incoming, stored)).toBe(true);
    expect(matches(incoming, incoming)).toBe(true);
    const pairs: Array<[string, string]> = [['in data', 'In transito'], ['in data', 'In consegna'], ['con successo in data', 'Consegnata con successo']];
    for (const [fragment, sentence] of pairs) {
      expect(matches({ ...stored, description: sentence }, { ...stored, description: fragment })).toBe(true);
    }
    for (const different of [
      { ...stored, description: 'in data' },
      { ...stored, location: 'ALTRO UFFICIO' },
    ]) expect(matches(incoming, different)).toBe(false);
    // The sentence does not turn back into its fragment, nor into another box's sentence.
    expect(matches(stored, incoming)).toBe(false);
    expect(matches({ ...stored, description: 'Consegnata con successo' }, { ...stored, description: 'in data' })).toBe(false);
  });
});

describe('PosteItalianeTracker fetch', () => {
  it('tries the private guest browser only after the existing recovery is challenged', async () => {
    const gate = { tipo: 'error', descrizione: 'CAPTCHA required' };
    const service = browser([capture(gate, 400)]);
    vi.mocked(fetchPosteItalianeInBrowser).mockResolvedValueOnce(parcel());
    const step = vi.fn();
    const tracker = new PosteItalianeTracker({ fetcher: async () => response(gate, 400), trawl: service.trawl,
      browserWsEndpoint: 'ws://browser.test/private-path', recorder: { lookup() {}, step } });
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ events: expect.any(Array) });
    expect(fetchPosteItalianeInBrowser).toHaveBeenCalledOnce();
    expect(step.mock.calls.map(([event]) => event.step)).toEqual(['direct', 'trawl', 'browser']);
    expect(vi.mocked(fetchPosteItalianeInBrowser).mock.calls[0]?.[3]).toBeLessThanOrEqual(15000);
  });

  it.each([0, 1])('keeps the existing recovery chain with proxy share %s and records its dated history', async share => {
    const gate = { tipo: 'error', descrizione: 'CAPTCHA required' };
    const service = browser([capture(gate, 400)]), step = vi.fn();
    vi.mocked(fetchPosteItalianeInBrowser).mockClear().mockResolvedValueOnce(parcel());
    const tracker = new PosteItalianeTracker({ fetcher: async () => response(gate, 400), trawl: service.trawl,
      browserWsEndpoint: 'ws://browser.test/private-path', browserRetryProxy: 'http://guest:secret@proxy.test:8080',
      browserRetryShare: share, recorder: { lookup() {}, step } });
    const result = await tracker.fetch(TRACKING_NUMBER);
    expect(result.history_truncated).toBe(share ? true : undefined);
    const call = vi.mocked(fetchPosteItalianeInBrowser).mock.calls[0]!;
    expect(call[4]).toEqual(share ? { server: 'http://proxy.test:8080', username: 'guest', password: 'secret' } : null);
    expect(call[3]).toBeLessThanOrEqual(15000);
    expect(step.mock.calls.map(([event]) => event.step)).toEqual(['direct', 'trawl', 'browser']);
    expect(step.mock.calls[2]?.[0]).toMatchObject({ networkRoute: share ? 'residential' : 'default', networkAttempt: 'retry',
      networkFamily: 'unknown', historyAvailable: true, fallbackReason: 'challenge' });
    expect(JSON.stringify(step.mock.calls)).not.toContain('secret');
  });

  it('never spends the private browser on HTTP recognition or a paced search', async () => {
    vi.mocked(fetchPosteItalianeInBrowser).mockClear();
    const fetcher = async () => response({ tipo: 'error', descrizione: 'CAPTCHA required' }, 400);
    const entry = adapter({ fetcher, trawl: null, recorder: NOOP_RECORDER, browserExecutablePath: null,
      env: { POSTE_ITALIANE_BROWSER_WS_ENDPOINT: 'ws://browser.test/private-path' } });
    await expect(entry.recognize!(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(entry.track({ number: TRACKING_NUMBER })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetchPosteItalianeInBrowser).not.toHaveBeenCalled();
  });

  const gate = { id: 2, tipo: 'error', descrizione: 'CAPTCHA required' };
  const endpoint = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
  const capture = (payload: unknown, status = 200, url = endpoint): TrawlCapturedResponse => ({ url, status, body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' }, base64Encoded: false, truncated: false, error: null });
  const browser = (captures: ReturnType<typeof capture>[]) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ tier: 3, statusCode: 200, html: '', capturedResponses: captures }));
    return { fetcher, trawl: new TrawlClient('http://browser.test', fetcher) };
  };

  it('recovers only a challenge, retaining full history and recovery telemetry in one budget', async () => {
    const service = browser([capture(gate, 400), capture(parcel())]);
    const step = vi.fn();
    const tracker = new PosteItalianeTracker({ fetcher: async () => response(gate, 400), trawl: service.trawl,
      recorder: { lookup() {}, step } });
    expect(await tracker.fetch(TRACKING_NUMBER, { budgetMs: 20_000 })).toEqual(parsePosteItalianeTrackingResponse(parcel(), TRACKING_NUMBER));
    expect(step.mock.calls.map(([row]) => [row.step, row.outcome, row.fallbackReason])).toEqual([
      ['direct', 'challenge', null], ['trawl', 'ok', 'challenge'],
    ]);
    const request = JSON.parse(String(service.fetcher.mock.calls[0]![1]?.body));
    expect(request).toMatchObject({ url: posteItalianeTrackingUrl(TRACKING_NUMBER), skipHttp: true,
      maxTier: 3, captureResponses: [endpoint] });
    expect(request.maxTimeout).toBeLessThan(20_000);
  });

  it('keeps HTTP recognition, definite answers, rate limits and schema failures out of the browser', async () => {
    const service = browser([capture(parcel())]);
    const carrier = adapter({ fetcher: async () => response(gate, 400), trawl: service.trawl,
      recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
    await expect(carrier.recognize!(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    for (const reply of [response(parcel()), response(parcel({ esitoRicerca: '1' })), response({}, 429), response({}, 503), response({})]) {
      await new PosteItalianeTracker({ fetcher: async () => reply, trawl: service.trawl }).fetch(TRACKING_NUMBER).catch(() => {});
    }
    expect(service.fetcher).not.toHaveBeenCalled();
  });

  it('preserves final browser failures and rejects mismatched or incomplete captures', async () => {
    const cases: [ReturnType<typeof capture>[], string][] = [
      [[capture(gate, 400)], 'challenge'], [[capture({}, 429)], 'rate_limited'],
      [[capture(parcel({ idTracciatura: 'RA00000000002' }))], 'schema'],
      [[capture(parcel(), 200, endpoint + '/other')], 'challenge'],
      [[{ ...capture(parcel()), truncated: true }], 'transport'],
      [[capture(gate, 400), { ...capture({}, 0), body: null, error: 'Poste tracking request failed' }], 'transport'],
      [[capture(parcel()), { ...capture({}, 0), body: null, error: 'Poste tracking request unfinished' }], 'transport'],
      [[capture(parcel()), capture(gate, 400)], 'challenge'],
      [[capture(parcel({ esitoRicerca: '1' }))], 'not_found'],
    ];
    for (const [captures, kind] of cases) {
      const service = browser(captures);
      await expect(new PosteItalianeTracker({ fetcher: async () => response(gate, 400), trawl: service.trawl })
        .fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind });
    }
  });

  it('does not launch recovery without enough time or after cancellation', async () => {
    const service = browser([capture(parcel())]);
    const controller = new AbortController();
    await expect(new PosteItalianeTracker({ fetcher: async () => response(gate, 400), trawl: service.trawl })
      .fetch(TRACKING_NUMBER, { budgetMs: 7000 })).rejects.toMatchObject({ kind: 'challenge' });
    const fetcher = vi.fn<typeof fetch>(async () => { controller.abort(); return response(gate, 400); });
    await expect(new PosteItalianeTracker({ fetcher, trawl: service.trawl })
      .fetch(TRACKING_NUMBER, { signal: controller.signal })).rejects.toBeDefined();
    expect(service.fetcher).not.toHaveBeenCalled();
  });

  it('keeps recognition failures distinct from explicit native negatives and meaningful status summaries', async () => {
    const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null,
      recorder: { step() {}, lookup() {} } });
    for (const status of [404, 410]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ idTracciatura: TRACKING_NUMBER, esitoRicerca: '2' }, status));
      await expect(adapter(environment(fetcher)).recognize!(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'transport' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    for (const body of [
      { idTracciatura: TRACKING_NUMBER },
      parcel({ listaMovimenti: [movement('', 1767484800000)] }),
      parcel({ idTracciatura: 'RA00000000002', esitoRicerca: '2' }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body));
      await expect(adapter(environment(fetcher)).recognize!(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    }
    for (const esitoRicerca of ['1', '2']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ idTracciatura: TRACKING_NUMBER, esitoRicerca }));
      expect(await adapter(environment(fetcher)).recognize!(TRACKING_NUMBER)).toEqual({ known: false });
    }
    const expired = vi.fn<typeof fetch>().mockResolvedValue(response({ idTracciatura: TRACKING_NUMBER, tipoSpedizione: 'P', listaMovimenti: [] }));
    expect(await adapter(environment(expired)).recognize!(TRACKING_NUMBER)).toEqual({ known: false });
    const pending = vi.fn<typeof fetch>().mockResolvedValue(response(parcel({ stato: '4', listaMovimenti: [] })));
    expect(await adapter(environment(pending)).recognize!(TRACKING_NUMBER)).toEqual({ known: false, lastActivityAt: null });
    const summary = vi.fn<typeof fetch>().mockResolvedValue(response(parcel({ listaMovimenti: [] })));
    expect(await adapter(environment(summary)).recognize!(TRACKING_NUMBER)).toEqual({ known: true, lastActivityAt: null });
  });

  it('posts the DoveQuando body with web-channel headers', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      seen.push({ url: String(input), body: String(init?.body) });
      return response(parcel());
    });
    const result = await new PosteItalianeTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER);
    expect(result.status).toBe('delivered');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice');
    expect(JSON.parse(seen[0]!.body)).toEqual({
      codiceSpedizione: TRACKING_NUMBER, tipoRichiedente: 'WEB', periodoRicerca: 1,
    });
  });

  it('surfaces transport and schema failures distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 503));
    await expect(new PosteItalianeTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ id: '1', tipo: 'error', descrizione: 'Richiesta non valida' }, 400));
    await expect(new PosteItalianeTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', kind: 'transport', status: 400 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('not json', 200));
    await expect(new PosteItalianeTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow(TypeError);
    expect(() => new PosteItalianeTracker({ timeoutMs: 0 })).toThrow(TypeError);
    await expect(new PosteItalianeTracker({ timeoutMs: 1_000 }).fetch('nope'))
      .rejects.toThrow(InvalidInputError);
    // Last: the CAPTCHA pauses the global fetch's searches.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ id: '1', tipo: 'error',
      descrizione: "Non e' possibile effettuare ulteriori richieste senza specificare una captcha valida" }, 400));
    await expect(new PosteItalianeTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'ChallengeError', kind: 'challenge' });
  });

  it('paces the searches sent through one transport, recognition included, and pauses them after a CAPTCHA', async () => {
    let now = Date.parse('2026-01-05T08:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const service = browser([capture(parcel())]);
    const fetcher = vi.fn<typeof fetch>(async () => response(parcel()));
    const tracker = new PosteItalianeTracker({ fetcher, trawl: service.trawl });
    const recognition = adapter({ fetcher, trawl: null, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
    for (let search = 1; search < HOURLY_SEARCHES; search++) {
      await tracker.fetch(TRACKING_NUMBER);
      now += 60_000;
    }
    expect(await recognition.recognize!(TRACKING_NUMBER)).toMatchObject({ known: true });
    now += 60_000;
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 42 * 60_000, reason: 'self_paced' });
    await expect(recognition.recognize!(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(HOURLY_SEARCHES);
    now += 42 * 60_000;
    await tracker.fetch(TRACKING_NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(HOURLY_SEARCHES + 1);

    const refused = vi.fn<typeof fetch>(async () => response(gate, 400));
    const paused = new PosteItalianeTracker({ fetcher: refused, trawl: null });
    await expect(paused.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    now += CAPTCHA_PAUSE_MS - 1;
    await expect(paused.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1, reason: 'self_paced' });
    now += 1;
    await expect(paused.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(refused).toHaveBeenCalledTimes(2);
    expect(service.fetcher).not.toHaveBeenCalled();
  });

  it('waits out an HTTP 429 for its Retry-After, else the CAPTCHA pause, and passes the wait on', async () => {
    let now = Date.parse('2026-01-05T08:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const limited = (headers: Record<string, string>) => vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers })).mockResolvedValue(response(parcel()));
    const named = limited({ 'Retry-After': '120' });
    const tracker = new PosteItalianeTracker({ fetcher: named, trawl: null });
    // The service's own 429 carries no reason; the refusal the pause then makes without a request does.
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000, reason: undefined });
    now += 119_000;
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1000, reason: 'self_paced' });
    now += 1000;
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(named).toHaveBeenCalledTimes(2);

    const dated = limited({ 'Retry-After': new Date(now + 300_000).toUTCString() });
    await expect(new PosteItalianeTracker({ fetcher: dated, trawl: null }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 300_000 });
    const unnamed = limited({});
    const quiet = new PosteItalianeTracker({ fetcher: unnamed, trawl: null });
    await expect(quiet.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: CAPTCHA_PAUSE_MS });
    now += CAPTCHA_PAUSE_MS - 1;
    await expect(quiet.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1 });
    expect(unnamed).toHaveBeenCalledTimes(1);

    // The browser's 429 pauses the transport the same way, beyond the CAPTCHA that sent the lookup there.
    const gated = vi.fn<typeof fetch>(async () => response(gate, 400));
    const service = browser([{ ...capture({}, 429), headers: { 'retry-after': '3600' } }]);
    const recovering = new PosteItalianeTracker({ fetcher: gated, trawl: service.trawl });
    await expect(recovering.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_600_000 });
    now += CAPTCHA_PAUSE_MS;
    await expect(recovering.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_600_000 - CAPTCHA_PAUSE_MS });
    expect(gated).toHaveBeenCalledTimes(1);
    expect(service.fetcher).toHaveBeenCalledTimes(1);
  });
});

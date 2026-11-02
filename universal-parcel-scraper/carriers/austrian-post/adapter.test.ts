import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AustrianPostTracker, normalizeAustrianPostNumber, parseAustrianPostResponse } from './adapter.js';
import { austrianPostPlace } from './identity.js';
import { austrianPostEventStatus, austrianPostSummaryStatus, statusMap } from './status.js';
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { resultStage } from '../../core/result/resolve.js';

const NUMBER = '1000000000000000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
// A returned letter, scanned in the destination country under its delivery area.
const RETURNED = 'LP123456785AT';
const returned = () => JSON.parse(readFileSync(new URL('./fixtures/returned.json', import.meta.url), 'utf8'));
// A Hermes Austria parcel under Hermes's number, left in a Post Empfangsbox and taken out of it.
const HERMES = '10000000000005';
const receivingBox = () => JSON.parse(readFileSync(new URL('./fixtures/receiving-box.json', import.meta.url), 'utf8'));
// A parcel sent to Italy through EURODIS, which the reply names by the partner's barcode once the partner takes it over.
const ABROAD = '1000000000000000000003';
const EURODIS = '010000000000000000000001';
const eurodis = () => JSON.parse(readFileSync(new URL('./fixtures/eurodis.json', import.meta.url), 'utf8'));
// A letter Deutsche Post sends to Austria, put through the letterbox.
const INBOUND = 'LY000000005DE';
const inbound = () => JSON.parse(readFileSync(new URL('./fixtures/inbound.json', import.meta.url), 'utf8'));
// An item China Post sends to Austria, held in customs over its declaration.
const HELD = 'LM000000005CN';
const customs = () => JSON.parse(readFileSync(new URL('./fixtures/customs.json', import.meta.url), 'utf8'));

describe('Austrian Post public tracking', () => {
  it('binds history to the item and classifies scans independently of the summary', () => {
    const result = parseAustrianPostResponse(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', weight_kg: 0.45, last_update: '2026-03-29T13:00:00.747Z' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'failed_attempt', 'out_for_delivery', 'in_transit', 'registered']);
    expect(result.events?.[0]).toMatchObject({ location: 'Synthetic destination' });
  });

  it('reads the measured size, the delivery time and scan codes, and never a shipper', () => {
    const payload = fixture();
    payload.data.einzelsendung.dimensions = { length: 35, width: 31, height: 7 };
    payload.data.einzelsendung.shipper = { name: 'PRIVATE NAME', street: 'PRIVATE STREET', postalCode: 'PRIVATE CODE', city: 'PRIVATE CITY' };
    const result = parseAustrianPostResponse(payload, NUMBER);
    expect(result).toMatchObject({ dimensions_text: '35 × 31 × 7 cm', delivered_at: '2026-03-29T13:00:00.747Z' });
    expect(result.sender_name).toBeUndefined();
    expect(result.events?.map((event) => event.provider_code)).toEqual(['IZ', 'RU', 'AZT', 'BEI', 'AV']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    payload.data.einzelsendung.dimensions = { length: 35, width: 0, height: 7 };
    const unmeasured = parseAustrianPostResponse(payload, NUMBER);
    expect(unmeasured.dimensions_text).toBeUndefined();
  });

  it('never keeps a postcode as a scan place', () => {
    const payload = fixture();
    const scans: Array<{ status: string; eventPlaceName: string }> = payload.data.einzelsendung.sendungsEvents;
    scans.find((scan) => scan.status === 'IZ')!.eventPlaceName = 'PLZ 9873';
    scans.find((scan) => scan.status === 'AZT')!.eventPlaceName = 'Zustellbasis Beispielort, PLZ 8762';
    const result = parseAustrianPostResponse(payload, NUMBER);
    expect(result.events?.[0]).not.toHaveProperty('location');
    expect(result.events?.map((event) => event.location)).toContain('Zustellbasis Beispielort');
    expect(JSON.stringify(result)).not.toMatch(/PLZ|9873|8762/);
  });

  it('gives a scan no place rather than its delivery area abroad', () => {
    const result = parseAustrianPostResponse(returned(), RETURNED);
    expect(result.events?.map((event) => event.location)).toEqual([undefined, undefined, undefined, undefined, 'Synthetic logistics centre', undefined]);
    expect(JSON.stringify(result)).not.toContain('PLZ');
    for (const area of ['PLZ IT', 'plz at', 'PLZ FR 1', 'PLZ  NL  X', 'PLZ GB AB1 2CD', 'PLZ 12345']) expect(austrianPostPlace(area), area).toBe('');
    // A partner's scan abroad names the country after the delivery area.
    for (const area of ['PLZ 12345, Deutschland', 'plz 01234,  Italien', 'PLZ DE, Deutschland']) expect(austrianPostPlace(area), area).toBe('');
    // A place with the letters inside a word stays, and so does a depot the partner names after them.
    for (const place of [
      'Plzeň', 'PLZEN 1', 'Logistikzentrum Plzeňská', 'PLZ BEISPIELSTADT 2, Deutschland', 'PLZ Beispielort, Italien',
      'Logistikzentrum Beispielstadt, Deutschland',
    ]) expect(austrianPostPlace(place), place).toBe(place);
  });

  describe('a parcel in a Post Empfangsbox', () => {
    it('is ready for collection in the box and delivered once taken out, though that scan carries IZ', () => {
      const result = parseAustrianPostResponse(receivingBox(), HERMES);
      expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Sendung aus Postempfangsbox abgeholt',
        delivered_at: '2026-07-03T16:00:00Z', weight_kg: 2.5 });
      expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
        ['IZ', 'delivered'], ['PUG', 'ready_for_pickup'], ['ONT', 'out_for_delivery'], ['BEI', 'in_transit'],
        ['BAU', undefined], ['PUP', undefined], ['AN', 'accepted'], ['AV', 'registered'],
      ]);
      expect(JSON.stringify(result)).not.toContain('PLZ');
    });

    it('stays ready for collection until the recipient takes it out', () => {
      const payload = receivingBox();
      payload.data.einzelsendung.status = 'EB';
      payload.data.einzelsendung.sendungsEvents.pop();
      const result = parseAustrianPostResponse(payload, HERMES);
      expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Sendung in Postempfangsbox abholbereit',
        expected_delivery: null });
      expect(result).not.toHaveProperty('delivered_at');
    });

    it('reads the collection by its reason or its wording alone', () => {
      expect(austrianPostEventStatus('IZ', 'ZPB', 'Synthetic wording')?.stage).toBe('delivered');
      expect(austrianPostEventStatus('IZ', '', 'Sendung aus Postempfangsbox abgeholt')?.stage).toBe('delivered');
      expect(austrianPostEventStatus('PUG', '2034', 'Synthetic wording')?.stage).toBe('ready_for_pickup');
      expect(statusMap.stage('IZ', 'sendung aus postempfangsbox abgeholt')).toBe('delivered');
      expect(statusMap.stage(null, 'sendung wurde zugestellt')).toBe('delivered');
      // The reason decides a box scan's stage, so its wording alone does not.
      expect(statusMap.stage('PUG', 'sendung in postempfangsbox abholbereit')).toBeUndefined();
    });
  });

  it('reads a parcel sent abroad under the EURODIS barcode the reply names for its 22-digit number', () => {
    const payload = fixture();
    Object.assign(payload.data.einzelsendung, {
      sendungsnummer: '010000000000000000000001', activeIdentityCode: '010000000000000000000001', originalIdentityCode: NUMBER,
    });
    expect(parseAustrianPostResponse(payload, NUMBER)).toMatchObject({
      status: 'delivered', canonical_tracking_number: '010000000000000000000001',
    });
    expect(parseAustrianPostResponse(fixture(), NUMBER)).not.toHaveProperty('canonical_tracking_number');
    // A barcode alone, without the reply naming the number asked, is another item.
    const unbound = fixture();
    unbound.data.einzelsendung.sendungsnummer = '010000000000000000000001';
    expect(() => parseAustrianPostResponse(unbound, NUMBER)).toThrow('different shipment');
  });

  it('follows an item another post sends to Austria from its posting abroad to the letterbox', () => {
    const result = parseAustrianPostResponse(inbound(), INBOUND);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'eingeworfen',
      delivered_at: '2026-03-06T10:24:35.810Z' });
    expect(result.events?.map((event) => [event.description, event.stage])).toEqual([
      ['eingeworfen', 'delivered'],
      ['Sendung in Zustellung', 'out_for_delivery'],
      ['Sendung in Bearbeitung Österreich', 'in_transit'],
      ['Sendung in Österreich im Logistkzentrum eingetroffen', 'in_transit'],
      ['Sendung in Bearbeitung Aufgabeland', 'in_transit'],
      ['Sendung für Auslandstransport bereit', 'in_transit'],
      ['Sendung ins Zielland unterwegs', 'in_transit'],
      ['Postaufgabe im Ausland', 'accepted'],
    ]);
    expect(statusMap.stage('BNT', 'postaufgabe im ausland')).toBe('accepted');
    expect(statusMap.stage('EXP', 'sendung ins zielland unterwegs')).toBe('in_transit');
    expect(statusMap.stage('BNT', 'eingeworfen')).toBe('delivered');
    // Only the bare wording: a notice put through the letterbox is no delivery.
    expect(austrianPostEventStatus('BNT', '', 'Benachrichtigung eingeworfen')).toBeUndefined();
  });

  it('reads the customs scans of an item from abroad as customs, which give the parcel its stage', () => {
    const result = parseAustrianPostResponse(customs(), HELD);
    expect(result).toMatchObject({ status: 'unknown', expected_delivery: null,
      last_status_text: 'Zollanmeldungshindernis - Rückmeldung vom Empfänger eingelangt' });
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['SN', 'customs'], ['CUD', 'customs'], ['LAG', 'customs'], ['CUS', 'customs'], ['IMP', 'in_transit'], ['IMP', 'in_transit'],
    ]);
    expect(resultStage(result)).toBe('customs');
    expect(statusMap.stage('CUS', 'sendung im zollanmeldungsprozess. weitere info folgt.')).toBe('customs');
    expect(statusMap.stage('LAG', 'lagereingang - zollanmeldungshindernis')).toBe('customs');
    expect(statusMap.stage('SN', 'zollanmeldungshindernis - rückmeldung vom empfänger eingelangt')).toBe('customs');
    // The delay names its reason, whichever it is.
    expect(statusMap.stage('CUD', 'sendung ist im zollprozess verzögert. grund: unplausibler warenwert.')).toBe('customs');
    expect(austrianPostEventStatus('CUD', '', 'Sendung ist im Zollprozess verzögert. Grund: Synthetic reason.')?.stage).toBe('customs');
    expect(austrianPostEventStatus('CUD', '', 'Sendung ist im Zollprozess verzögert.')).toBeUndefined();
  });

  it('rejects a different returned item', () => {
    const payload = fixture();
    payload.data.einzelsendung.sendungsnummer = '1000000000000000000002';
    expect(() => parseAustrianPostResponse(payload, NUMBER)).toThrow('different shipment');
    // Only a 22-digit number may answer under a 24-digit barcode.
    for (const [asked, answered] of [[NUMBER, '01000000000000000000001'], [NUMBER, '0100000000000000000000001'], ['010000000000000000000001', NUMBER]] as const) {
      const other = fixture();
      other.data.einzelsendung.sendungsnummer = answered;
      expect(() => parseAustrianPostResponse(other, asked), answered).toThrow('different shipment');
    }
    // A Hermes number binds the whole reply's number too.
    const box = receivingBox();
    box.data.einzelsendung.sendungsnummer = `00000000${HERMES}`;
    expect(() => parseAustrianPostResponse(box, HERMES)).toThrow('different shipment');
  });

  it('follows a parcel the reply names by its partner’s barcode abroad, under the number Austrian Post gave it', () => {
    const result = parseAustrianPostResponse(eurodis(), ABROAD);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-03-12T10:15:00Z' });
    expect(result.events?.map((event) => [event.provider_code, event.stage, event.location])).toEqual([
      ['IZ', 'delivered', undefined], ['AZT', 'out_for_delivery', undefined], ['IMP', 'in_transit', 'PLZ Eurodis, Italien'],
      ['PUG', 'in_transit', 'Synthetic logistics centre'], ['BEI', 'in_transit', 'Synthetic logistics centre'], ['AV', 'registered', undefined],
    ]);
    // The partner's barcode answers for the same parcel.
    expect(parseAustrianPostResponse(eurodis(), EURODIS)).toMatchObject({ status: 'delivered' });
    // Another parcel's original number binds nothing.
    const other = eurodis();
    other.data.einzelsendung.originalIdentityCode = '1000000000000000000002';
    expect(() => parseAustrianPostResponse(other, ABROAD)).toThrow('different shipment');
  });

  it('separates positive not-found from missing data, query errors and a shipment without scans', () => {
    expect(() => parseAustrianPostResponse({ data: { einzelsendung: null } }, NUMBER)).toThrow('could not locate');
    expect(() => parseAustrianPostResponse({ data: {} }, NUMBER)).toThrow('invalid tracking response');
    expect(() => parseAustrianPostResponse({ data: { einzelsendung: null }, errors: [{ message: 'Unavailable' }] }, NUMBER)).toThrow('could not complete');
    const payload = fixture();
    payload.data.einzelsendung.sendungsEvents = [];
    expect(() => parseAustrianPostResponse(payload, NUMBER)).toThrow(NoHistoryError);
  });

  it('requires explicit timestamp offsets', () => {
    const payload = fixture();
    payload.data.einzelsendung.sendungsEvents[0].timestamp = '2026-03-28T12:00:00';
    expect(() => parseAustrianPostResponse(payload, NUMBER)).toThrow('incomplete scan');
  });

  describe('a scan without wording', () => {
    // The returned letter's history holds an EXP scan without wording, as the page lists it.
    const wordless = (payload: ReturnType<typeof returned>) => payload.data.einzelsendung.sendungsEvents[2];

    it('keeps its code, with no stage and no wording', () => {
      const result = parseAustrianPostResponse(returned(), RETURNED);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Empfängeradresse ungenügend',
        last_update: '2026-03-04T08:45:00Z', expected_delivery: null, weight_kg: 0.02 });
      expect(result.events?.map((event) => event.provider_code)).toEqual(['RU', 'AZT', 'BNT', 'EXP', 'IV', 'BNT']);
      expect(result.events?.[3]).toEqual({ time: '2026-03-03T03:10:45Z', provider_code: 'EXP' });
    });

    it('never gives the status text, even as the newest scan', () => {
      const payload = returned();
      wordless(payload).timestamp = '2026-03-05T07:00:00.000+00:00';
      const result = parseAustrianPostResponse(payload, RETURNED);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Empfängeradresse ungenügend',
        last_update: '2026-03-05T07:00:00Z' });
      expect(result.events?.[0]).toEqual({ time: '2026-03-05T07:00:00Z', provider_code: 'EXP' });
      for (const scan of payload.data.einzelsendung.sendungsEvents) scan.trackingDesc = null;
      const silent = parseAustrianPostResponse(payload, RETURNED);
      expect(silent).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: null });
      expect(silent.events?.some((event) => event.description || event.stage)).toBe(false);
    });

    it("is in transit as the arrival in the destination country (IMP), in Austrian Post's wording for it", () => {
      const payload = returned();
      wordless(payload).status = 'IMP';
      const result = parseAustrianPostResponse(payload, RETURNED);
      expect(result.events?.[3]).toEqual({ time: '2026-03-03T03:10:45Z', description: 'Sendung im Zielland angekommen',
        stage: 'in_transit', provider_code: 'IMP' });
      expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Empfängeradresse ungenügend' });
      wordless(payload).timestamp = '2026-03-05T07:00:00.000+00:00';
      expect(parseAustrianPostResponse(payload, RETURNED).last_status_text).toBe('Sendung im Zielland angekommen');
    });

    it('is skipped without a code', () => {
      const payload = returned();
      wordless(payload).status = '';
      const result = parseAustrianPostResponse(payload, RETURNED);
      expect(result.events?.map((event) => event.provider_code)).toEqual(['RU', 'AZT', 'BNT', 'IV', 'BNT']);
      expect(result.events?.every((event) => event.description)).toBe(true);
    });
  });

  it('deduplicates scans and keeps unfamiliar stages unresolved', () => {
    const payload = fixture();
    payload.data.einzelsendung.status = 'NEW';
    payload.data.einzelsendung.sendungsEvents.push({ ...payload.data.einzelsendung.sendungsEvents[4] });
    payload.data.einzelsendung.sendungsEvents[0].status = 'NEW';
    payload.data.einzelsendung.sendungsEvents[0].trackingDesc = 'New milestone';
    expect(parseAustrianPostResponse(payload, NUMBER)).toMatchObject({ status: 'unknown', events: expect.any(Array) });
    expect(parseAustrianPostResponse(payload, NUMBER).events).toHaveLength(5);
    expect(parseAustrianPostResponse(payload, NUMBER).events?.[4]).not.toHaveProperty('stage');
  });

  describe('delivery estimate', () => {
    // Out for delivery since 13:00 on 28 March, Vienna time (CET).
    const outForDelivery = (estimatedDelivery: unknown, summary = 'IZ') => {
      const payload = fixture();
      payload.data.einzelsendung.status = summary;
      payload.data.einzelsendung.sendungsEvents = payload.data.einzelsendung.sendungsEvents.slice(0, 3);
      payload.data.einzelsendung.estimatedDelivery = estimatedDelivery;
      return payload;
    };
    const day = { startDate: '2026-03-28T00:00:00', endDate: '2026-03-28T00:00:00', startTime: null, endTime: null };
    const window = { ...day, startTime: '2026-03-28T13:00:00.000+01:00', endTime: '2026-03-28T17:00:00.000+01:00' };

    it('reads the window between its start and end times', () => {
      const result = parseAustrianPostResponse(outForDelivery(window), NUMBER);
      expect(result).toMatchObject({ status: 'out_for_delivery', expected_delivery_from: '2026-03-28T13:00:00+01:00', expected_delivery: '2026-03-28T17:00:00+01:00' });
    });

    it('reads dates as Vienna days, and a range of them', () => {
      expect(parseAustrianPostResponse(outForDelivery(day), NUMBER)).toMatchObject({ expected_delivery: '2026-03-28' });
      expect(parseAustrianPostResponse(outForDelivery(day), NUMBER)).not.toHaveProperty('expected_delivery_from');
      const midnight = { ...day, startDate: '2026-03-27T23:00:00.000Z', endDate: '2026-03-27T23:00:00.000+00:00' };
      expect(parseAustrianPostResponse(outForDelivery(midnight), NUMBER).expected_delivery).toBe('2026-03-28');
      const range = parseAustrianPostResponse(outForDelivery({ ...day, endDate: '2026-03-30', startTime: null }, 'IV'), NUMBER);
      expect(range).toMatchObject({ status: 'in_transit', expected_delivery_from: '2026-03-28', expected_delivery: '2026-03-30' });
    });

    it('keeps only the days when the times fall on other days', () => {
      const result = parseAustrianPostResponse(outForDelivery({ ...window, startTime: '0001-01-01T13:00:00+01:00' }), NUMBER);
      expect(result.expected_delivery).toBe('2026-03-28');
      expect(result).not.toHaveProperty('expected_delivery_from');
    });

    it('drops an estimate that does not read', () => {
      for (const estimate of [null, 'tomorrow', { ...day, startDate: 'Samstag' }, { ...day, endDate: '2026-03-27T00:00:00' }]) {
        const result = parseAustrianPostResponse(outForDelivery(estimate), NUMBER);
        expect(result.expected_delivery).toBeNull();
        expect(result).not.toHaveProperty('expected_delivery_from');
      }
    });

    it('shows the estimate only where the tracking page does', () => {
      for (const summary of ['AV', 'EB', 'RE', 'ZU']) {
        expect(parseAustrianPostResponse(outForDelivery(window, summary), NUMBER).expected_delivery).toBeNull();
      }
      const reason = (code: string, summary = 'IZ') => {
        const payload = outForDelivery(window, summary);
        payload.data.einzelsendung.sendungsEvents[2].reasontypecode = code;
        return parseAustrianPostResponse(payload, NUMBER).expected_delivery;
      };
      // A missed delivery out for delivery, a delay and a problem to resolve hide it.
      expect([reason('BN'), reason('FL'), reason('NZ')]).toEqual([null, null, null]);
      expect(reason('BN', 'IV')).toBe('2026-03-28T17:00:00+01:00');
    });

    it('drops an estimate a later scan has passed', () => {
      const payload = outForDelivery(window);
      payload.data.einzelsendung.sendungsEvents[2].timestamp = '2026-03-28T16:30:00+00:00';
      expect(parseAustrianPostResponse(payload, NUMBER).expected_delivery).toBeNull();
      const days = outForDelivery({ ...day, endDate: '2026-03-29T00:00:00' });
      days.data.einzelsendung.sendungsEvents[2].timestamp = '2026-03-29T16:30:00+00:00';
      expect(parseAustrianPostResponse(days, NUMBER).expected_delivery).toBe('2026-03-29');
      days.data.einzelsendung.sendungsEvents[2].timestamp = '2026-03-29T22:30:00+00:00';
      expect(parseAustrianPostResponse(days, NUMBER).expected_delivery).toBeNull();
    });
  });

  it('separates summary and scan vocabularies for pickup, returns and delivery', () => {
    expect(austrianPostSummaryStatus('IZ')?.stage).toBe('out_for_delivery');
    expect(austrianPostEventStatus('IZ', 'ZA', '')?.stage).toBe('delivered');
    expect(austrianPostEventStatus('TRA', '', 'Konsolidierung für Export')?.stage).toBe('in_transit');
    expect(austrianPostEventStatus('TRA', '', 'Synthetic transit wording')).toBeUndefined();
    expect(statusMap.stage('TRA', 'konsolidierung für export')).toBe('in_transit');
    expect(austrianPostEventStatus('TRA', '', 'Transit')?.stage).toBe('in_transit');
    expect(statusMap.stage('TRA', 'transit')).toBe('in_transit');
    // The arrival's code yields to a return or a delivery round its wording names, as the scan does.
    expect(statusMap.stage('IMP', 'sendung im zielland angekommen')).toBe('in_transit');
    expect(statusMap.stage('IMP', '')).toBe('in_transit');
    expect(austrianPostEventStatus('IMP', '', 'Rücksendung an den Absender')?.stage).toBe('returned');
    expect(statusMap.stage('IMP', 'rücksendung an den absender')).toBeUndefined();
    expect(austrianPostEventStatus('IMP', '', 'Sendung in Zustellung')?.stage).toBe('out_for_delivery');
    expect(statusMap.stage('IMP', 'sendung in zustellung')).toBeUndefined();
    // A code alone says nothing the reason could not change.
    expect(statusMap.stage('IZ', 'sendung in zustellung')).toBeUndefined();
    expect(austrianPostEventStatus('IZ', 'BH', '')?.stage).toBe('failed_attempt');
    expect(austrianPostEventStatus('IZ', 'HO', '')?.stage).toBe('ready_for_pickup');
    expect(austrianPostSummaryStatus('RE')?.stage).toBe('returned');
  });

  it('makes one anonymous bounded query and honors caller cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    await new AustrianPostTracker({ fetcher }).fetch(NUMBER, { budgetMs: 900.5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.post.at/sendungen/sv/graphqlPublic');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    const query = String(JSON.parse(String(init?.body)).query);
    expect(query).toContain(`sendungsnummer: "${NUMBER}"`);
    expect(query).toContain('sendungsnummer activeIdentityCode originalIdentityCode status');
    expect(query).toContain('estimatedDelivery { startDate endDate startTime endTime }');
    // The public page shows the sender only after sign-in; nothing about the recipient either.
    expect(query).not.toContain('shipper');
    expect(query).not.toMatch(/street|postalCode|deliveryAddress/);
    expect(init?.headers).not.toHaveProperty('Authorization');
    const cancelled = AbortSignal.abort();
    await expect(new AustrianPostTracker({ fetcher }).fetch(NUMBER, { signal: cancelled })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unavailable endpoint as an unknown parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    await expect(new AustrianPostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('rejects invalid input before network and exposes recognition for ambiguous digits', async () => {
    expect(normalizeAustrianPostNumber(` ${NUMBER} `)).toBe(NUMBER);
    expect(normalizeAustrianPostNumber(`${NUMBER}00`)).toBe(`${NUMBER}00`);
    expect(() => normalizeAustrianPostNumber(`${NUMBER}0`)).toThrow(InvalidInputError);
    expect(() => normalizeAustrianPostNumber(`${NUMBER}"}`)).toThrow(InvalidInputError);
    // Hermes Austria's fourteen-digit numbers, whole.
    expect(normalizeAustrianPostNumber(HERMES)).toBe(HERMES);
    for (const near of [HERMES.slice(1), `${HERMES}0`, `H${HERMES}`]) expect(() => normalizeAustrianPostNumber(near), near).toThrow(InvalidInputError);
    // S10 numbers of its own and of mail from abroad, with a valid check digit.
    expect(normalizeAustrianPostNumber(INBOUND.toLowerCase())).toBe(INBOUND);
    expect(() => normalizeAustrianPostNumber('LY000000006DE')).toThrow(InvalidInputError);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(tracker.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });
});

describe('Austrian Post detection', () => {
  it('is listed first for the twenty-two-digit numbers that start like its parcel numbers, and only for those', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low',
      candidates: ['austrian-post', 'usps', 'estafeta'], preferred: ['austrian-post'] });
    expect(recognitionCandidates(ABROAD)[0]).toMatchObject({ carrier: 'austrian-post', preferred: true });
    const other = detectCarrierMatch('5000000000000000000001');
    expect(other.candidates).toContain('austrian-post');
    expect(other.preferred).not.toContain('austrian-post');
    expect(detectCarrierMatch('9400100000000000000001').preferred).not.toContain('austrian-post');
    expect(detectCarrierMatch('10000000000000000000001').candidates).not.toContain('austrian-post');
  });
});

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import {
  adapter,
  MondialRelayTracker,
  mondialRelayTrackingUrl,
  normalizeMondialRelayCredential,
  parseMondialRelayTrackingResponse,
} from './adapter.js';
import { classifyStatus } from './status.js';

// Public fixture provenance:
// - 17185966 is the shipment in Mondial Relay's official Permalinks v2.1 PDF:
//   https://www.mondialrelay.fr/media/123677/permalinks-v211.pdf
// - 76434219 / 59650 are the example values rendered by the official tracking page:
//   https://www.mondialrelay.fr/suivi-de-colis/
// - 887368516605 is the 12-digit ID in an official Belgian tracking permalink:
//   https://www.mondialrelay.be/fr-be/suivi-de-colis?numeroExpedition=88.73685.166.05
// Mondial Relay's official CONNECT guide documents the 8/10/12 digit formats:
//   https://www.mondialrelay.fr/media/124728/fr-documentation-utilisateur-connect-v-12.pdf
// The two France fixtures now return the official no-result response, so the
// successful response body in fixtures/ is an explicitly synthetic schema
// fixture. No mailbox or recipient-derived identifier is retained in this file.
const OFFICIAL_PDF_SHIPMENT = '17185966';
const OFFICIAL_PAGE_SHIPMENT = '76434219';
const OFFICIAL_PAGE_POSTCODE = '59650';
const OFFICIAL_TWELVE_DIGIT_SHIPMENT = '887368516605';
const SYNTHETIC_TEN_DIGIT_BOUNDARY = '1000000000';
const PUBLIC_CREDENTIAL = `${OFFICIAL_PDF_SHIPMENT}${OFFICIAL_PAGE_POSTCODE}`;
const TRACKING_PAGE = 'https://www.mondialrelay.fr/suivi-de-colis/';
const TEST_TOKEN = 'PUBLIC_TEST_TOKEN_1234567890';
// What the browser hands back once the Vue app has replaced the server-rendered
// root: the token only survives in the captured response body.
const VUE_PAGE = '<html><body>Vue replaced the tracking root</body></html>';

const SUCCESS_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/available-at-relay.json', import.meta.url), 'utf8'),
) as { Expedition: Record<string, unknown> };
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function apiUrl(shipment = OFFICIAL_PDF_SHIPMENT, postcode = OFFICIAL_PAGE_POSTCODE): string {
  const url = new URL('https://www.mondialrelay.fr/api/tracking');
  url.searchParams.set('shipment', shipment);
  url.searchParams.set('postcode', postcode);
  url.searchParams.set('brand', '');
  url.searchParams.set('codePays', 'fr');
  return url.toString();
}

function tokenPage(): string {
  return `<!doctype html><html><body>
    <div id="tracking" token="${TEST_TOKEN}" minLengthNumExpe="4"
      maxLengthNumExpe="16"></div>
  </body></html>`;
}

function syntheticSuccessFixture(shipment = OFFICIAL_PDF_SHIPMENT): Record<string, unknown> {
  const fixture = structuredClone(SUCCESS_FIXTURE);
  fixture.Expedition.Numero = shipment;
  return fixture;
}

function numericByteObject(value: string): Record<string, number> {
  return Object.fromEntries(
    [...new TextEncoder().encode(value)].map((byte, index) => [String(index), byte]),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

afterEach(() => vi.restoreAllMocks());

describe('Mondial Relay tracking input', () => {
  it('accepts documented separate and combined formats and builds a postcode-free permalink', () => {
    expect(normalizeMondialRelayCredential(PUBLIC_CREDENTIAL)).toEqual({
      shipment: OFFICIAL_PDF_SHIPMENT,
      postcode: OFFICIAL_PAGE_POSTCODE,
    });
    expect(normalizeMondialRelayCredential(
      OFFICIAL_PAGE_SHIPMENT,
      OFFICIAL_PAGE_POSTCODE,
    )).toEqual({
      shipment: OFFICIAL_PAGE_SHIPMENT,
      postcode: OFFICIAL_PAGE_POSTCODE,
    });
    // The brand forms are found without a postcode, so an appended one is not sent.
    expect(normalizeMondialRelayCredential(
      `${SYNTHETIC_TEN_DIGIT_BOUNDARY}${OFFICIAL_PAGE_POSTCODE}`,
    )).toEqual({
      shipment: SYNTHETIC_TEN_DIGIT_BOUNDARY,
      postcode: '',
      canonicalShipment: '00000000',
    });
    expect(normalizeMondialRelayCredential(
      `${OFFICIAL_TWELVE_DIGIT_SHIPMENT}${OFFICIAL_PAGE_POSTCODE}`,
    )).toEqual({
      shipment: OFFICIAL_TWELVE_DIGIT_SHIPMENT,
      postcode: '',
      canonicalShipment: '73685166',
    });
    expect(mondialRelayTrackingUrl(PUBLIC_CREDENTIAL)).toBe(
      `${TRACKING_PAGE}?numeroExpedition=${OFFICIAL_PDF_SHIPMENT}`,
    );
    const publicUrl = new URL(mondialRelayTrackingUrl(PUBLIC_CREDENTIAL));
    expect(publicUrl.searchParams.has('codePostal')).toBe(false);
    expect(publicUrl.searchParams.has('postcode')).toBe(false);
  });

  it.each([['1000', '1000'], [' 1012 ab ', '1012 AB'], ['1000-001', '1000-001'], ['L-1234', 'L-1234'], ['28001', '28001']])(
    'takes the recipient postcode of any country for an 8-digit shipment: %s',
    (typed, sent) => {
      expect(normalizeMondialRelayCredential(OFFICIAL_PDF_SHIPMENT, typed)).toEqual({ shipment: OFFICIAL_PDF_SHIPMENT, postcode: sent });
    },
  );

  // Synthetic postcodes in Portugal's shape (four digits, then three), which Mondial Relay holds hyphenated.
  it.each([
    ['1000-001', '', '1000-001'],
    ['1000001', '', '1000-001'],
    ['1000 001', 'PT', '1000-001'],
    ['1000001', ' pt ', '1000-001'],
    ['1000001', 'IL', '1000001'],
    ['1000', 'BE', '1000'],
    ['75001', 'PT', '75001'],
  ])('sends a Portuguese postcode as Mondial Relay holds it: %s from %j', (typed, country, sent) => {
    expect(normalizeMondialRelayCredential(OFFICIAL_PDF_SHIPMENT, typed, country)).toEqual({ shipment: OFFICIAL_PDF_SHIPMENT, postcode: sent });
  });

  it('asks again for a Portuguese postcode given by its first four digits, before any request', async () => {
    expect(() => normalizeMondialRelayCredential(OFFICIAL_PDF_SHIPMENT, '1000', 'PT'))
      .toThrow(expect.objectContaining({ kind: 'input_required', reason: 'postcode_incomplete' }));
    // The brand forms are found without a postcode, so theirs is not checked.
    expect(normalizeMondialRelayCredential(SYNTHETIC_TEN_DIGIT_BOUNDARY, '1000', 'PT')).toMatchObject({ postcode: '' });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
    const tracker = adapter({ trawl: new TrawlClient('http://trawl.internal:8191'), browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: OFFICIAL_PDF_SHIPMENT, postcode: '1000', postcodeCountry: 'PT' }, {}))
      .rejects.toMatchObject({ kind: 'input_required', reason: 'postcode_incomplete' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks the 10- and 12-digit forms without a postcode, even one typed for them', () => {
    for (const postcode of ['', OFFICIAL_PAGE_POSTCODE]) {
      expect(normalizeMondialRelayCredential(SYNTHETIC_TEN_DIGIT_BOUNDARY, postcode))
        .toEqual({ shipment: SYNTHETIC_TEN_DIGIT_BOUNDARY, postcode: '', canonicalShipment: '00000000' });
      expect(normalizeMondialRelayCredential(OFFICIAL_TWELVE_DIGIT_SHIPMENT, postcode))
        .toEqual({ shipment: OFFICIAL_TWELVE_DIGIT_SHIPMENT, postcode: '', canonicalShipment: '73685166' });
    }
  });

  it('rejects incomplete credentials, invalid postcodes, and parameter injection', () => {
    // An 8-digit shipment lacks only its postcode; any other number is one Mondial Relay does not issue.
    for (const [shipment, postcode, kind] of [
      [OFFICIAL_PDF_SHIPMENT, '', 'input_required'],
      ['1718596', OFFICIAL_PAGE_POSTCODE, 'invalid_input'],
      ['17185966000', OFFICIAL_PAGE_POSTCODE, 'invalid_input'],
      [OFFICIAL_PDF_SHIPMENT, '12', 'input_required'],
      [OFFICIAL_PDF_SHIPMENT, 'ABCDE', 'input_required'],
      [OFFICIAL_PDF_SHIPMENT, '75001/2', 'input_required'],
      [OFFICIAL_PDF_SHIPMENT, '1'.repeat(13), 'input_required'],
      // Only a French postcode is read off the end of a number.
      [`${OFFICIAL_PDF_SHIPMENT}96000`, '', 'invalid_input'],
      [`${PUBLIC_CREDENTIAL}&admin=true`, '', 'invalid_input'],
      ['1718596É', OFFICIAL_PAGE_POSTCODE, 'invalid_input'],
    ] as const) {
      expect(() => normalizeMondialRelayCredential(shipment, postcode))
        .toThrow('10- or 12-digit shipment number');
      expect(() => normalizeMondialRelayCredential(shipment, postcode))
        .toThrow(expect.objectContaining({ kind }));
    }
  });

  it('reads pasted links from the French, Belgian, Dutch and international trackers, and serves the Netherlands', () => {
    for (const link of [
      `${TRACKING_PAGE}?numeroExpedition=${OFFICIAL_PDF_SHIPMENT}`,
      `https://www.mondialrelay.be/fr-be/suivi-de-colis/?numeroExpedition=${OFFICIAL_PDF_SHIPMENT}`,
      `https://www.mondialrelay.be/nl-be/mijn-mondial-relay-pakje-opvolgen/?numeroExpedition=${OFFICIAL_PDF_SHIPMENT}`,
      `https://www.mondialrelay.nl/mijn-mondial-relay-pakket-volgen/?numeroExpedition=${OFFICIAL_PDF_SHIPMENT}`,
      `https://www.mondialrelay.com/en-gb/parcel-tracking/?exp=${OFFICIAL_PDF_SHIPMENT}&ens=EXAMPLE1&country=NL`,
    ]) {
      expect(parseTrackingInput(link), link)
        .toMatchObject({ trackingNumber: OFFICIAL_PDF_SHIPMENT, carrier: 'mondial-relay', source: 'link' });
    }
    expect(parseTrackingInput('https://widget.mondialrelay.com/parcelshop-picker/version').source).toBe('none');
    expect(CARRIER_DEFINITIONS['mondial-relay'].countries).toEqual(expect.arrayContaining(['FR', 'BE', 'LU', 'NL']));
  });

  it('rejects a number Mondial Relay does not issue before any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
    await expect(new MondialRelayTracker({ trawl: new TrawlClient('http://trawl.internal:8191') }).fetch('1718596', OFFICIAL_PAGE_POSTCODE))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    // Before the lookup waits for its turn, so an ended signal does not hide it.
    await expect(new MondialRelayTracker({ trawl: new TrawlClient('http://trawl.internal:8191') })
      .fetch('1718596', OFFICIAL_PAGE_POSTCODE, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Mondial Relay response normalization', () => {
  it('verifies identity, maps history, and projects the relay but no contact or recipient data', () => {
    const result = parseMondialRelayTrackingResponse(
      syntheticSuccessFixture(),
      PUBLIC_CREDENTIAL,
    );

    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'ready_for_pickup',
      last_status_text: 'Votre colis est disponible dans votre Point Relais®',
      last_update: '2026-08-30T10:30:00+02:00',
      expected_delivery: '2026-08-31',
      pickup_point: 'EXAMPLE RELAY\n1 EXAMPLE STREET\n00000 EXAMPLE CITY',
      timezone: 'Europe/Paris',
      source: 'mondial_relay_public_web',
    });
    expect(result.events).toEqual([
      {
        time: '2026-08-30T10:30:00+02:00',
        location: '',
        description: 'Votre colis est disponible dans votre Point Relais®',
        stage: 'ready_for_pickup',
      },
      {
        time: '2026-08-29T14:00:00+02:00',
        location: '',
        description: "Votre colis est en cours d'acheminement",
        stage: 'in_transit',
      },
    ]);

    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE OPENING',
      'PRIVATE CLOSING',
      'PRIVATE SERVICE',
      'PRIVATE PHONE',
      'private@example.test',
      'PRIVATE LATITUDE',
      'PRIVATE LONGITUDE',
      'PRIVATE INFO',
      'PRIVATE RECIPIENT',
      'PRIVATE DEPOT ADDRESS',
      'PRIVATE REPLACEMENT ADDRESS',
      'private-replacement@example.test',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('keeps terminal statuses distinct and clears estimates for them', () => {
    const delivered = syntheticSuccessFixture();
    const deliveredExpedition = delivered.Expedition as Record<string, unknown>;
    deliveredExpedition.SuiviContextuel = 'Votre colis a été remis au destinataire';
    deliveredExpedition.Evenements = [{
      Date: '2026-08-30T12:00:00',
      Libelle: 'Votre colis a été remis au destinataire',
    }];
    expect(parseMondialRelayTrackingResponse(delivered, PUBLIC_CREDENTIAL)).toMatchObject({
      status: 'delivered',
      expected_delivery: null,
      events: [{ stage: 'delivered' }],
    });

    const returned = syntheticSuccessFixture();
    const returnedExpedition = returned.Expedition as Record<string, unknown>;
    returnedExpedition.SuiviContextuel = "Votre colis est retourné à l'expéditeur";
    returnedExpedition.Evenements = [{
      Date: '2026-08-30T12:00:00',
      Libelle: "Votre colis est retourné à l'expéditeur",
    }];
    expect(parseMondialRelayTrackingResponse(returned, PUBLIC_CREDENTIAL)).toMatchObject({
      status: 'exception',
      expected_delivery: null,
      events: [{ stage: 'returned' }],
    });
  });

  it('strictly accepts and verifies the official public 12-digit form', () => {
    expect(parseMondialRelayTrackingResponse(
      syntheticSuccessFixture(OFFICIAL_TWELVE_DIGIT_SHIPMENT),
      OFFICIAL_TWELVE_DIGIT_SHIPMENT,
      OFFICIAL_PAGE_POSTCODE,
    )).toMatchObject({ status: 'out_for_delivery' });
  });

  it('accepts the 8-digit shipment the API echoes for the longer forms', () => {
    // The reply names the shipment without its 2-digit brand prefix (and,
    // for the 12-digit form, without the parcel sequence).
    const branded = `12${OFFICIAL_PDF_SHIPMENT}`;
    expect(parseMondialRelayTrackingResponse(
      syntheticSuccessFixture(OFFICIAL_PDF_SHIPMENT),
      branded,
      OFFICIAL_PAGE_POSTCODE,
    )).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(parseMondialRelayTrackingResponse(
      syntheticSuccessFixture('73685166'),
      OFFICIAL_TWELVE_DIGIT_SHIPMENT,
      OFFICIAL_PAGE_POSTCODE,
    )).toMatchObject({ status: 'out_for_delivery' });
    for (const [returned, requested] of [
      ['17185967', branded],
      [OFFICIAL_PDF_SHIPMENT, `${OFFICIAL_PDF_SHIPMENT}12`],
      ['12171859', branded],
      ['73685167', OFFICIAL_TWELVE_DIGIT_SHIPMENT],
    ] as const) {
      expect(() => parseMondialRelayTrackingResponse(
        syntheticSuccessFixture(returned),
        requested,
        OFFICIAL_PAGE_POSTCODE,
      )).toThrow('different shipment');
    }
  });

  it('declares a locker pickup instead of leaving the sync to read it as out for delivery', () => {
    const fixture = syntheticSuccessFixture();
    const expedition = fixture.Expedition as Record<string, unknown>;
    expedition.SuiviContextuel = 'Colis disponible au Locker';
    expect(parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL)).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'ready_for_pickup',
      last_status_text: 'Colis disponible au Locker',
    });

    expedition.SuiviContextuel = 'Mise à jour de votre suivi';
    expedition.Evenements = [{ Date: '2026-08-30T12:00:00', Libelle: 'Colis pris en charge en Locker' }];
    expect(parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
  });

  it('uses reached official milestones only when contextual history is inconclusive', () => {
    const fixture = syntheticSuccessFixture();
    const expedition = fixture.Expedition as Record<string, unknown>;
    expedition.SuiviContextuel = 'Mise à jour de votre suivi';
    expedition.Evenements = [];

    expect(parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL)).toMatchObject({
      status: 'out_for_delivery',
      last_update: null,
      events: [],
    });
  });

  it('fails closed on no-result, incomplete, and mismatched responses', () => {
    expect(() => parseMondialRelayTrackingResponse({
      status: [{
        state: 'warn',
        message: 'Il n’existe pas de colis pour ces critères de recherche',
      }],
    }, PUBLIC_CREDENTIAL)).toThrow(NotFoundError);

    expect(() => parseMondialRelayTrackingResponse({ status: [] }, PUBLIC_CREDENTIAL))
      .toThrow('incomplete tracking details');
    expect(() => parseMondialRelayTrackingResponse(
      syntheticSuccessFixture('17185967'),
      PUBLIC_CREDENTIAL,
    )).toThrow('different shipment');

    try {
      parseMondialRelayTrackingResponse({
        status: [{ state: 'warn', message: 'PRIVATE PROVIDER QUERY ECHO' }],
      }, PUBLIC_CREDENTIAL);
      throw new Error('Expected no-result error');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'NotFoundError',
        status: 404,
        message: 'Mondial Relay could not locate the shipment',
      });
      expect(String(error)).not.toContain('PRIVATE PROVIDER QUERY ECHO');
    }
  });

  it('produces every capability carrier.json declares', () => {
    const fixture = syntheticSuccessFixture();
    ((fixture.Expedition as Record<string, unknown>).Evenements as unknown[])
      .push({ Date: '2026-08-29T09:00:00', Libelle: 'Colis expédié depuis le site EXAMPLE TOWN' });
    const result = parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL);
    expect(CAPABILITIES).toEqual(['history', 'location', 'eta', 'pickup_point', 'delivered_at']);
    expect(result.pickup_point).toBeTruthy();
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.at(-1)?.location).toBe('EXAMPLE TOWN');
    expect(result.expected_delivery).toBe('2026-08-31');
  });

  it('names the relay holding the parcel only while it waits there', () => {
    const relay = (Libelle: string, AdresseLigne1 = '', Ville = '') => ({ Numero: 1,
      Adresse: { Libelle, LibelleComplement: '', AdresseLigne1, AdresseLigne2: '', CodePostal: '00000', Ville, CodePays: 'FR' } });
    const parse = (headline: string, ...Evenements: unknown[]) => {
      const fixture = syntheticSuccessFixture();
      Object.assign(fixture.Expedition as Record<string, unknown>, { SuiviContextuel: headline, Evenements });
      return parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL);
    };
    const droppedOff = { Date: '2026-08-27T18:00:00', Libelle: 'Colis pris en charge en Locker',
      DetailPointRelais: relay('EXAMPLE DROP-OFF LOCKER', '2 EXAMPLE ROAD', 'EXAMPLE TOWN') };
    const countdown = { Date: '2026-08-30T08:00:00', Libelle: '5 jours restants pour retirer le colis en Locker' };
    const waiting = (detail: unknown) => parse('Colis disponible au Locker', { ...countdown, DetailPointRelais: detail }, droppedOff);
    expect(waiting(relay('EXAMPLE LOCKER', '1 EXAMPLE STREET', 'EXAMPLE CITY')).pickup_point)
      .toBe('EXAMPLE LOCKER\n1 EXAMPLE STREET\n00000 EXAMPLE CITY');
    // Without its street or town the relay keeps its name; without a name it is none.
    expect(waiting(relay('EXAMPLE LOCKER', '1 EXAMPLE STREET')).pickup_point).toBe('EXAMPLE LOCKER');
    expect(waiting(relay('', '1 EXAMPLE STREET', 'EXAMPLE CITY')).pickup_point).toBeUndefined();
    // The sender's drop-off relay, named before the parcel reached its pickup point, is not where it waits.
    expect(parse('Colis disponible au Locker', countdown, droppedOff).pickup_point).toBeUndefined();
    // The relay named on the arrival still counts once the countdown follows it.
    const arrived = { Date: '2026-08-29T10:00:00', Libelle: 'Colis disponible au Locker',
      DetailPointRelais: relay('EXAMPLE LOCKER', '1 EXAMPLE STREET', 'EXAMPLE CITY') };
    expect(parse('Colis disponible au Locker', countdown, arrived, droppedOff).pickup_point)
      .toBe('EXAMPLE LOCKER\n1 EXAMPLE STREET\n00000 EXAMPLE CITY');
    const collected = { Date: '2026-08-31T12:00:00', Libelle: 'Colis livré au destinataire',
      DetailPointRelais: relay('EXAMPLE LOCKER', '1 EXAMPLE STREET', 'EXAMPLE CITY') };
    expect(parse('Colis livré au destinataire', collected, countdown, droppedOff)).toMatchObject({ current_stage: 'delivered' });
    expect(parse('Colis livré au destinataire', collected, countdown, droppedOff).pickup_point).toBeUndefined();
  });

  it('places a scan at the logistics site its wording names, and nowhere else', () => {
    const located = (Libelle: string) => {
      const fixture = syntheticSuccessFixture();
      (fixture.Expedition as Record<string, unknown>).Evenements = [{ Date: '2026-08-29T09:00:00', Libelle }];
      return parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL).events?.[0];
    };
    expect(located('Prise en charge de votre colis sur notre site logistique de EXAMPLE TOWN.'))
      .toEqual({ time: '2026-08-29T09:00:00+02:00', location: 'EXAMPLE TOWN',
        description: 'Prise en charge de votre colis sur notre site logistique de EXAMPLE TOWN.', stage: 'in_transit' });
    expect(located('Colis en cours de traitement sur le site HUB de Example-Ville')?.location).toBe('HUB de Example-Ville');
    expect(located('Colis expédié depuis le site EXAMPLE TOWN')?.location).toBe('EXAMPLE TOWN');
    // A site the parcel heads for, the generic site, codes and other wording name no place.
    for (const wording of ['Colis expédié depuis le site logistique', 'Colis en cours de traitement sur le site logistique',
      'Colis expédié vers le site EXAMPLE TOWN', 'Colis en cours de traitement sur le site TEST_DEPOT',
      'Prise en charge de votre colis sur notre site logistique EXAMPLE TOWN',
      'Colis en route vers le point de livraison', 'Colis pris en charge en Locker']) {
      expect(located(wording)?.location).toBe('');
    }
  });

  it('maps the wording it claims and leaves everything else to the sync', () => {
    expect(classifyStatus("Votre colis est retourné à l'expéditeur"))
      .toEqual({ status: 'exception', stage: 'returned' });
    expect(classifyStatus('Colis pris en charge en Point Relais'))
      .toEqual({ status: 'in_transit', stage: 'accepted' });
    expect(classifyStatus('Prise en charge de votre colis sur notre site logistique'))
      .toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(classifyStatus('Mise à jour de votre suivi'))
      .toEqual({ status: 'unknown', stage: 'in_transit' });
  });

  it('reads a returned merchant delivery as delivered and a replacement relay as movement', () => {
    expect(classifyStatus("Votre colis a été livré à l'enseigne."))
      .toEqual({ status: 'delivered', stage: 'delivered' });
    for (const wording of ['Sollicitation Client pour replace colis', 'Relais de substitution choisi']) {
      expect(classifyStatus(wording)).toEqual({ status: 'in_transit', stage: 'in_transit' });
    }
  });

  it('reads the last leg of a home delivery as out for delivery where its milestone is dated', () => {
    const fixture = syntheticSuccessFixture();
    const expedition = fixture.Expedition as Record<string, unknown>;
    expedition.SuiviContextuel = 'Colis livré au destinataire';
    expedition.DeliveryCountryParcel = 'FR';
    expedition.Evenements = [
      { Date: '2026-08-28T09:00:00.5', Libelle: 'Colis expédié depuis le site EXAMPLE TOWN' },
      { Date: '2026-08-29T08:10:11.25', Libelle: 'Colis en route vers le point de livraison' },
      { Date: '2026-08-29T11:42:00', Libelle: 'Colis livré au destinataire' },
    ];
    expedition.SuiviParEtapes = {
      3: { Numero: 3, Libelle: "Colis sur l'agence de livraison", Evenement: { Date: '2026-08-28T09:00:00.5' } },
      4: { Numero: 4, Libelle: 'Colis en cours de livraison', Evenement: { Date: '2026-08-29T08:10:11.250' } },
      5: { Numero: 5, Libelle: 'Colis livré au destinataire', Evenement: { Date: '2026-08-29T11:42:00' } },
    };
    const result = parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL);
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit']);
    expect(result).toMatchObject({
      status: 'delivered', delivered_at: '2026-08-29T11:42:00+02:00', destination_country: 'FR', expected_delivery: null,
    });

    // A relay delivery dates its fourth milestone at the parcel's arrival there.
    (expedition.SuiviParEtapes as Record<string, Record<string, unknown>>)[4]!.Libelle = 'Colis disponible au point de retrait';
    expedition.SuiviContextuel = 'Colis en route vers le point de livraison';
    expedition.DeliveryCountryParcel = 'Belgique';
    expedition.Evenements = (expedition.Evenements as unknown[]).slice(0, 2);
    const relay = parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL);
    expect(relay.events?.map((event) => event.stage)).toEqual(['in_transit', 'in_transit']);
    expect(relay).toMatchObject({ status: 'in_transit' });
    expect(relay).not.toHaveProperty('delivered_at');
    expect(relay).not.toHaveProperty('destination_country');
  });

  it('restages only the last-leg scan its out-for-delivery milestone is dated at', () => {
    const fixture = syntheticSuccessFixture();
    const expedition = fixture.Expedition as Record<string, unknown>;
    expedition.SuiviContextuel = 'Colis livré au destinataire';
    const stages = (events: Array<{ Date: string; Libelle: string }>, milestone: string) => {
      expedition.Evenements = events;
      expedition.SuiviParEtapes = {
        4: { Numero: 4, Libelle: 'Colis en cours de livraison', Evenement: { Date: milestone } },
        5: { Numero: 5, Libelle: 'Colis livré au destinataire', Evenement: { Date: '2026-08-29T11:42:00' } },
      };
      return parseMondialRelayTrackingResponse(fixture, PUBLIC_CREDENTIAL).events
        ?.map((event) => [event.description, event.stage]);
    };

    // Another scan in the same second stays movement.
    expect(stages([
      { Date: '2026-08-29T08:10:11', Libelle: 'Colis expédié depuis le site EXAMPLE TOWN' },
      { Date: '2026-08-29T08:10:11', Libelle: 'Colis en route vers le point de livraison' },
      { Date: '2026-08-29T11:42:00', Libelle: 'Colis livré au destinataire' },
    ], '2026-08-29T08:10:11')).toEqual([
      ['Colis livré au destinataire', 'delivered'],
      ['Colis en route vers le point de livraison', 'out_for_delivery'],
      ['Colis expédié depuis le site EXAMPLE TOWN', 'in_transit'],
    ]);
    expect(stages([
      { Date: '2026-08-29T08:10:11', Libelle: 'Colis expédié depuis le site EXAMPLE TOWN' },
    ], '2026-08-29T08:10:11')).toEqual([['Colis expédié depuis le site EXAMPLE TOWN', 'in_transit']]);

    // After a failed attempt, only the leg the milestone is dated at reads out for delivery.
    expect(stages([
      { Date: '2026-08-28T08:00:00', Libelle: 'Colis en route vers le point de livraison' },
      { Date: '2026-08-28T15:00:00', Libelle: 'Échec de livraison' },
      { Date: '2026-08-29T08:10:11', Libelle: 'Colis en route vers le point de livraison' },
      { Date: '2026-08-29T11:42:00', Libelle: 'Colis livré au destinataire' },
    ], '2026-08-29T08:10:11')?.map(([, stage]) => stage)).toEqual(['delivered', 'out_for_delivery', 'failed_attempt', 'in_transit']);
  });

  it('restores the leading zeroes of a shipment echoed as a JSON number', () => {
    const fixture = syntheticSuccessFixture();
    (fixture.Expedition as Record<string, unknown>).Numero = 1234567;
    expect(parseMondialRelayTrackingResponse(fixture, '01234567', OFFICIAL_PAGE_POSTCODE))
      .toMatchObject({ status: 'out_for_delivery' });
    (fixture.Expedition as Record<string, unknown>).Numero = '1234567';
    expect(() => parseMondialRelayTrackingResponse(fixture, '01234567', OFFICIAL_PAGE_POSTCODE))
      .toThrow('invalid shipment number');
    (fixture.Expedition as Record<string, unknown>).Numero = 1234568;
    expect(() => parseMondialRelayTrackingResponse(fixture, '01234567', OFFICIAL_PAGE_POSTCODE))
      .toThrow('different shipment');
  });

  it('reads the locker countdown as ready for pickup and the site scans as movement', () => {
    expect(classifyStatus('5 jours restants pour retirer le colis en Locker'))
      .toEqual({ status: 'out_for_delivery', stage: 'ready_for_pickup' });
    expect(classifyStatus('1 jour restant pour retirer le colis en Locker'))
      .toEqual({ status: 'out_for_delivery', stage: 'ready_for_pickup' });
    for (const wording of ['Colis disponible au Locker', 'Colis disponible au point de retrait']) {
      expect(classifyStatus(wording)).toEqual({ status: 'out_for_delivery', stage: 'ready_for_pickup' });
    }
    for (const wording of [
      'Colis expédié depuis le site logistique', 'Colis en cours de traitement sur le site logistique',
      'Colis en route vers le point de livraison',
    ]) expect(classifyStatus(wording)).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(classifyStatus("Colis en préparation chez l'expéditeur"))
      .toEqual({ status: 'pending', stage: 'registered' });
  });
});

describe('Mondial Relay web session', () => {
  it('goes straight to TRAWL without a direct attempt', async () => {
    const bootstrap = {
      tier: 3,
      statusCode: 200,
      url: TRACKING_PAGE,
      html: VUE_PAGE,
      body: numericByteObject(tokenPage()),
    };
    const tracked = {
      tier: 2,
      statusCode: 200,
      url: apiUrl(),
      html: `<html><body><pre>${escapeHtml(
        JSON.stringify(syntheticSuccessFixture()),
      )}</pre></body></html>`,
    };
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(bootstrap), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(tracked), {
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(new MondialRelayTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawl: new TrawlClient('http://trawl.internal:8191/v1'),
    }).fetch(PUBLIC_CREDENTIAL)).resolves.toMatchObject({
      status: 'out_for_delivery',
      tracking_url: mondialRelayTrackingUrl(PUBLIC_CREDENTIAL),
      tracking_source: 'browser-session-response',
    });

    // Both requests go to TRAWL; nothing hits Mondial Relay directly.
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) {
      expect(String(call[0])).toBe('http://trawl.internal:8191/scrape');
    }
    const bootstrapRequest = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(bootstrapRequest).toEqual({
      url: TRACKING_PAGE,
      skipHttp: true,
      maxTier: 3,
      maxTimeout: expect.any(Number),
    });
    const trackingRequest = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(trackingRequest).toMatchObject({
      url: apiUrl(),
      skipHttp: true,
      maxTier: 3,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: TRACKING_PAGE,
        RequestVerificationToken: TEST_TOKEN,
      },
    });
    // Both requests share the 2 s lookup budget: each is given what is left of it.
    expect(bootstrapRequest.maxTimeout).toBeLessThanOrEqual(2_000);
    expect(trackingRequest.maxTimeout).toBeGreaterThan(0);
    expect(trackingRequest.maxTimeout).toBeLessThanOrEqual(bootstrapRequest.maxTimeout);
  });

  it('asks the website with a Portuguese postcode in the form it holds, 1234-567', async () => {
    const reply = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ tier: 3, statusCode: 200, url: TRACKING_PAGE, html: VUE_PAGE, body: numericByteObject(tokenPage()) }))
      .mockResolvedValueOnce(reply({
        tier: 3, statusCode: 200, url: apiUrl(OFFICIAL_PDF_SHIPMENT, '1000-001'), html: VUE_PAGE,
        body: numericByteObject(JSON.stringify(syntheticSuccessFixture())),
      }));
    const tracker = adapter({ trawl: new TrawlClient('http://trawl.internal:8191'), browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: OFFICIAL_PDF_SHIPMENT, postcode: '1000 001', postcodeCountry: 'PT' }, { budgetMs: 2_000 }))
      .resolves.toMatchObject({ tracking_source: 'browser-session-response' });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).url).toBe(apiUrl(OFFICIAL_PDF_SHIPMENT, '1000-001'));
  });

  it.each(['numeric-object', 'buffer'] as const)('uses TRAWL %s bodies for the token/API sequence', async (format) => {
    const bootstrap = {
      tier: 3,
      statusCode: 200,
      url: TRACKING_PAGE,
      html: VUE_PAGE,
      body: format === 'buffer' ? Buffer.from(tokenPage()).toJSON() : numericByteObject(tokenPage()),
    };
    const tracked = {
      tier: 2,
      statusCode: 200,
      url: apiUrl(),
      ...(format === 'buffer' ? { body: Buffer.from(JSON.stringify(syntheticSuccessFixture())).toJSON() } : {}),
      html: `<html><body><pre>${escapeHtml(
        JSON.stringify(syntheticSuccessFixture()),
      )}</pre></body></html>`,
    };
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(bootstrap), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(tracked), {
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(new MondialRelayTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawl: new TrawlClient('http://trawl.internal:8191/v1'),
    }).fetch(PUBLIC_CREDENTIAL)).resolves.toMatchObject({
      status: 'out_for_delivery',
      tracking_source: 'browser-session-response',
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://trawl.internal:8191/scrape');
    expect(String(fetcher.mock.calls[1]![0])).toBe('http://trawl.internal:8191/scrape');
    const bootstrapRequest = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(bootstrapRequest).toEqual({
      url: TRACKING_PAGE,
      skipHttp: true,
      maxTier: 3,
      maxTimeout: expect.any(Number),
    });
    const trackingRequest = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(trackingRequest).toMatchObject({
      url: apiUrl(),
      skipHttp: true,
      maxTier: 3,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: TRACKING_PAGE,
        RequestVerificationToken: TEST_TOKEN,
      },
    });
    // Both requests share the 2 s lookup budget: each is given what is left of it.
    expect(bootstrapRequest.maxTimeout).toBeLessThanOrEqual(2_000);
    expect(trackingRequest.maxTimeout).toBeGreaterThan(0);
    expect(trackingRequest.maxTimeout).toBeLessThanOrEqual(bootstrapRequest.maxTimeout);
  });

  it('fails closed when no browser session exists or TRAWL changes shipment', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch directly'));
    await expect(new MondialRelayTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawl: null,
    }).fetch(PUBLIC_CREDENTIAL)).rejects.toThrow('configure FLARESOLVERR_URL');
    expect(fetcher).not.toHaveBeenCalled();

    fetcher
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: TRACKING_PAGE,
        html: VUE_PAGE,
        body: numericByteObject(tokenPage()),
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: apiUrl('17185967'),
        html: VUE_PAGE,
        body: numericByteObject(JSON.stringify(syntheticSuccessFixture('17185967'))),
      })));
    await expect(new MondialRelayTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawl: new TrawlClient('http://trawl.internal:8191/scrape'),
    }).fetch(PUBLIC_CREDENTIAL)).rejects.toThrow('different shipment');
  });

  it('answers a cancelled lookup at once, queued or in flight, and leaves the next one alone', async () => {
    const reply = (payload: unknown) => new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
    });
    const bootstrap = () => reply({
      tier: 3, statusCode: 200, url: TRACKING_PAGE, html: VUE_PAGE, body: numericByteObject(tokenPage()),
    });
    let reached!: () => void;
    const apiRequest = new Promise<void>((resolve) => { reached = resolve; });
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bootstrap())
      .mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        reached();
      }))
      .mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(reply({
        tier: 3, statusCode: 200, url: apiUrl(), html: VUE_PAGE,
        body: numericByteObject(JSON.stringify(syntheticSuccessFixture())),
      }));
    const tracker = new MondialRelayTracker({ trawl: new TrawlClient('http://trawl.internal:8191/scrape') });
    const inFlight = new AbortController();
    const queued = new AbortController();
    const stopped = new Error('caller stopped');
    const cancelled = new Error('caller cancelled');

    const first = tracker.fetch(PUBLIC_CREDENTIAL, '', { signal: inFlight.signal });
    const second = tracker.fetch(PUBLIC_CREDENTIAL, '', { signal: queued.signal });
    const third = tracker.fetch(PUBLIC_CREDENTIAL);
    await apiRequest;

    queued.abort(cancelled);
    await expect(second).rejects.toBe(cancelled);
    expect(fetcher).toHaveBeenCalledTimes(2);

    inFlight.abort(stopped);
    await expect(first).rejects.toBe(stopped);
    expect(fetcher.mock.calls[1]![1]?.signal?.aborted).toBe(true);

    // The cancelled turn passes without a request; the next lookup is served.
    await expect(third).resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});


describe('documented Mondial Relay 26-digit label barcode', () => {
  const barcode = '12123456780101006623123454';
  it('keeps carrier acceptance distinct from electronic registration and hub scans', () => {
    const result = parseMondialRelayTrackingResponse({ Expedition: {
      Numero: '12345678',
      SuiviContextuel: 'Prise en charge de votre colis sur notre site logistique TEST_DEPOT',
      Evenements: [
        { Date: '2026-01-03T10:00:00', Libelle: 'Prise en charge de votre colis sur notre site logistique TEST_DEPOT' },
        { Date: '2026-01-02T10:00:00', Libelle: 'Colis pris en charge en Locker' },
        { Date: '2026-01-01T10:00:00', Libelle: "Colis en cours de préparation par l'expéditeur" },
      ],
    } }, barcode);
    expect(result.status).toBe('in_transit');
    expect(result.events?.map((event) => event.stage)).toEqual(['in_transit', 'accepted', 'registered']);
  });
  it('uses the public alias without deriving a postcode from routing digits', () => {
    expect(normalizeMondialRelayCredential(barcode)).toEqual({ shipment: '121234567801', postcode: '', canonicalShipment: '12345678', barcode: true });
    expect(mondialRelayTrackingUrl(barcode)).toBe(`${TRACKING_PAGE}?numeroExpedition=121234567801`);
    expect(() => normalizeMondialRelayCredential(barcode.slice(0, -1) + '5')).toThrow('Invalid Mondial Relay barcode');
    expect(() => normalizeMondialRelayCredential(barcode.slice(0, 14) + '1' + barcode.slice(15))).toThrow('Invalid Mondial Relay barcode');
    expect(() => normalizeMondialRelayCredential(barcode.slice(0, -1) + '5')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
  it('requires returned shipment identity to match the documented embedded number', () => {
    expect(parseMondialRelayTrackingResponse(syntheticSuccessFixture('12345678'), barcode)).toMatchObject({ status: 'out_for_delivery' });
    expect(() => parseMondialRelayTrackingResponse(syntheticSuccessFixture('87654321'), barcode)).toThrow('different shipment');
  });
  it('fetches the public alias and accepts only its canonical shipment', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: TRACKING_PAGE,
        html: VUE_PAGE,
        body: numericByteObject(tokenPage()),
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: apiUrl('121234567801', ''),
        html: VUE_PAGE,
        body: numericByteObject(JSON.stringify(syntheticSuccessFixture('12345678'))),
      }), { headers: { 'Content-Type': 'application/json' } }));
    const result = await new MondialRelayTracker({
      trawl: new TrawlClient('http://trawl.internal:8191/scrape'),
    }).fetch(barcode);
    expect(String(fetcher.mock.calls[1]![0])).toBe('http://trawl.internal:8191/scrape');
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({
      url: apiUrl('121234567801', ''),
    });
    expect(result.tracking_url).toBe(`${TRACKING_PAGE}?numeroExpedition=121234567801`);
  });
});

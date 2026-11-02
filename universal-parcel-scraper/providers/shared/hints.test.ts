import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { checksumRejections } from '../../core/detection/index.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { ADAPTER_CHECKED_RULES, brandCarrierForNumber, universalCarrierHints } from './hints.js';

/** Synthetic numbers that fit each adapter-checked rule but fail its check digit. */
const FAILING: Record<string, string> = {
  'dhl-express-waybill': '1234567890', 'gls-fr-4': '123456789010', 'mondial-relay-1': '12345678901234567890123450',
  'fedex-3': '9611020987654312345673', 'fedex-label-barcode': '9622001560001234567100794808390595',
  'fedex-4': '4200000000000000000000700000000022',
  'an-post-1': 'RR123456789IE', 'austrian-post-2': 'RR123456789AT', 'bpost-3': 'RR123456789BE', 'bring-posten-1': 'RR123456789NO',
  'canada-post-2': 'RR123456789CA', 'china-post-1': 'RR123456789CN', 'correios-br-1': 'RR123456789BR', 'correos-chile-2': 'RR123456789CL',
  'ctt-1': 'RR123456789PT', 'hongkong-post-1': 'RR123456789HK', 'india-post-1': 'RR123456789IN',
  'japan-post-1': 'RR123456789JP', 'nz-post-1': 'RR123456789NZ', 'poczta-polska-s10': 'RR123456789PL',
  'postnord-2': 'RR123456789SE', 'thailand-post-1': 'RR123456789TH', 'ukrposhta-s10': 'RR123456789UA',
  'usps-s10': 'RR123456789US',
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('carrier names reported by universal providers', () => {
  it('resolves a bare brand only when the number leaves one of its networks', () => {
    // DPD's depot prefix: 0600-0619 Switzerland, most of 0620-0649 Austria, 10xx France (ex-Exapaq).
    expect(brandCarrierForNumber('DPD Group', '06080000000002')).toBe('dpd');
    expect(brandCarrierForNumber('DPD Group', '06200000000002')).toBe('dpd-at');
    expect(brandCarrierForNumber('DPD Group', '06030000000002')).toBe('dpd');
    expect(brandCarrierForNumber('dpd', '10000000000001')).toBe('dpd-fr');
    // A DPD France 250… number is its own high-confidence shape.
    expect(brandCarrierForNumber('DPD', '250000000000000')).toBe('dpd-fr');
    // DPD Poland's waybill, thirteen digits and a letter, and its 13xx depot range.
    expect(brandCarrierForNumber('DPD', '1000000000002U')).toBe('dpd-pl');
    expect(brandCarrierForNumber('DPD Group', '13000000000002')).toBe('dpd-pl');
    // Both DPD networks match and neither is preferred.
    expect(brandCarrierForNumber('DPD Group', '06460000000002')).toBeUndefined();
    // Germany and the UK share the number shape; the bare brand cannot pick a country.
    expect(brandCarrierForNumber('DPD Group', '20000000000002')).toBeUndefined();
    // The number is no network of the brand at all.
    expect(brandCarrierForNumber('GLS', '06080000000002')).toBeUndefined();
    // Not a bare brand.
    expect(brandCarrierForNumber('Swiss Post', '06080000000002')).toBeUndefined();
  });

  it('proposes the carrier a single name resolves to', () => {
    expect(universalCarrierHints(['DPD Group'], '06080000000002')).toEqual({
      reported_carriers: ['DPD Group'], discovered_carrier: 'dpd',
    });
    // Without the number a brand stays a hint, as before.
    expect(universalCarrierHints(['DPD Group'])).toEqual({ reported_carriers: ['DPD Group'] });
    expect(universalCarrierHints(['DPD Group', 'DPD Group ', 7, null], '06080000000002').discovered_carrier).toBe('dpd');
    // 17TRACK's country for a DPD parcel can be another network's: recognition names it.
    expect(universalCarrierHints(['DPD (BE)'], '06080000000002').discovered_carrier).toBeUndefined();
  });

  it('proposes the carrier whose leg of the journey the number belongs to', () => {
    // The number fits DPD's rules and no Swiss Post one.
    expect(universalCarrierHints(['Swiss Post', 'DPD Group'], '06080000000002')).toEqual({
      reported_carriers: ['Swiss Post', 'DPD Group'], discovered_carrier: 'dpd',
    });
    // GOFO's rules fit none of Nova Poshta's digits.
    expect(universalCarrierHints(['Nova Poshta', 'GoFo Express'], '59500000000012').discovered_carrier).toBe('nova-poshta');
    // Both fit a run of digits; Nova Poshta's preferred rule backs it.
    expect(universalCarrierHints(['DPD Germany', 'Nova Poshta'], '59500000000012').discovered_carrier).toBe('nova-poshta');
    expect(universalCarrierHints(['DPD Germany', 'Seur'], '59500000000012').discovered_carrier).toBeUndefined();
    // DHLink's rule fits its line provider's EYT number and no SwiftX one.
    expect(universalCarrierHints(['DHLink', 'SwiftX'], 'EYT0000000000HZ')).toEqual({
      reported_carriers: ['DHLink', 'SwiftX'], discovered_carrier: 'dhlink',
    });
    expect(universalCarrierHints(['DHLink', 'Nova Poshta'], 'EYT0000000000HZ').discovered_carrier).toBe('dhlink');
    // No rule fits the origin's number. SwiftX's numbers are all SWX and eighteen digits, so
    // SwiftX is named for the last leg and DHLink, whose numbers have no layout of their own, is left.
    expect(universalCarrierHints(['DHLink', 'SwiftX'], 'QQT0000000000HZ').discovered_carrier).toBe('dhlink');
    expect(universalCarrierHints(['DHLink', 'SwiftX'], 'SWX000000000000000000').discovered_carrier).toBe('swiftx');
    // Two carriers without a layout of their own, a name outside the catalog, or no number: no hint.
    expect(universalCarrierHints(['DHLink', 'Nova Poshta'], 'QQT0000000000HZ').discovered_carrier).toBeUndefined();
    expect(universalCarrierHints(['Some Forwarder', 'SwiftX'], 'EYT0000000000HZ').discovered_carrier).toBeUndefined();
    expect(universalCarrierHints(['DHLink', 'SwiftX']).discovered_carrier).toBeUndefined();
  });

  it('names the brand network that delivers a parcel Cainiao brings from abroad', () => {
    // An Evri barcode without A, C or D in the sixth place fits Evri International and Evri UK alike.
    const barcode = 'H00A0B0000000003';
    expect(brandCarrierForNumber('Evri Group', barcode)).toBeUndefined();
    // A or D there backs Evri UK, and C Evri International.
    expect(brandCarrierForNumber('Evri Group', 'H00A0A0000000002')).toBe('evri-uk');
    expect(brandCarrierForNumber('Evri Group', 'H00A0C0000000004')).toBe('evri');
    expect(universalCarrierHints(['Evri Group'], barcode).discovered_carrier).toBeUndefined();
    // Evri International hands parcels to partners abroad, so beside Cainiao the leg is Evri UK's.
    for (const names of [['Evri Group', 'Cainiao'], ['Cainiao', 'Evri Group']]) {
      expect(universalCarrierHints(names, barcode)).toEqual({ reported_carriers: names, discovered_carrier: 'evri-uk' });
    }
    // A number of neither network is Cainiao's own, as beside any group name.
    expect(universalCarrierHints(['Evri Group', 'Cainiao'], 'LP00000000000001').discovered_carrier).toBe('aliexpress');
    // Without Cainiao another name is no reason to rule a network out.
    expect(universalCarrierHints(['Evri Group', 'Royal Mail'], barcode).discovered_carrier).toBeUndefined();
    // Plain "Evri" is Evri UK's name; providers name Evri International in full.
    expect(universalCarrierHints(['Evri'], barcode).discovered_carrier).toBe('evri-uk');
  });

  it('reads a bare brand none of whose networks fits the number as a group name', () => {
    // DHLink tracks its line provider XZG's numbers; no DPD network has their layout.
    expect(universalCarrierHints(['XZG', 'DHLink', 'DPD Group'], 'XZG000000001WL')).toEqual({
      reported_carriers: ['XZG', 'DHLink', 'DPD Group'], discovered_carrier: 'dhlink',
    });
    expect(universalCarrierHints(['GLS', 'FedEx'], '000000000000').discovered_carrier).toBe('fedex');
    // Beside a name outside the catalog, or a carrier none of whose rules fits either, no hint.
    expect(universalCarrierHints(['Some Forwarder', 'DPD Group', 'DHLink'], 'XZG000000001WL').discovered_carrier).toBeUndefined();
    expect(universalCarrierHints(['DPD Group', 'Royal Mail'], 'QQ000000000QQ').discovered_carrier).toBeUndefined();
    // A network of the brand that fits keeps it a name of its own.
    expect(universalCarrierHints(['Evri Group', 'Royal Mail'], 'H00A0B0000000003').discovered_carrier).toBeUndefined();
  });

  it('prefers a carrier named in full to a network a bare brand leaves to the number', () => {
    // BRT is DPD's network in Italy; fifteen digits fit BRT's rule and a broad DPD France one.
    expect(universalCarrierHints(['BRT Bartolini (Parcel ID)', 'DPD Group'], '012000000000001').discovered_carrier).toBe('brt');
    expect(universalCarrierHints(['DPD Group'], '012000000000001').discovered_carrier).toBe('dpd-fr');
    // Two carriers named in full still leave the number to their rules.
    expect(universalCarrierHints(['BRT Bartolini (Parcel ID)', 'DPD France'], '012000000000001').discovered_carrier).toBeUndefined();
  });

  it('names the network of a brand the number points to when the one named has no rule for it', () => {
    // A DPD UK depot's number with its check character, which DPD France's numbers never carry.
    expect(universalCarrierHints(['DPD France'], '15501000324679R')).toEqual({ reported_carriers: ['DPD France'], discovered_carrier: 'dpd-uk' });
    // Without the check character DPD France's rule fits the number too, so its name stands.
    expect(universalCarrierHints(['DPD France'], '15501000324679').discovered_carrier).toBe('dpd-fr');
    // A network whose rule fits keeps its name.
    expect(universalCarrierHints(['DPD Germany'], '15501000324679R').discovered_carrier).toBe('dpd-de');
  });

  it('names the carrier beside Cainiao for a number no rule of either fits', () => {
    // Cainiao follows a parcel under its delivery carrier's number, here one only postal
    // detection takes.
    for (const names of [['MailAmericas', 'Cainiao'], ['Cainiao', 'MailAmericas']]) {
      expect(universalCarrierHints(names, 'RR123456785EE').discovered_carrier).toBe('mailamericas');
    }
    // A number of Cainiao's own stays Cainiao's.
    expect(universalCarrierHints(['MailAmericas', 'Cainiao'], 'LP00000000000001').discovered_carrier).toBe('aliexpress');
    // Two carriers beside Cainiao leave no single one.
    expect(universalCarrierHints(['MailAmericas', 'Cainiao', 'Correos Spain'], 'RR123456785EE').discovered_carrier).toBeUndefined();
  });

  it('names MailAmericas for a Marshall Islands number, which its own rule fits', () => {
    expect(universalCarrierHints(['MailAmericas', 'Cainiao', 'Correos Spain'], 'RR123456785MH').discovered_carrier).toBe('mailamericas');
  });

  it('keeps the postal union\'s feed among the reported names, where it proposes no carrier', () => {
    // An S10 number with a valid check digit.
    const finnish = 'RR123456785FI';
    expect(universalCarrierHints(['Finland Post'], finnish)).toEqual({ reported_carriers: ['Finland Post'], discovered_carrier: 'posti' });
    // The feed is no carrier, but it still counts as a name: two names propose nothing.
    expect(universalCarrierHints(['UPU', 'Finland Post'], finnish)).toEqual({ reported_carriers: ['UPU', 'Finland Post'] });
    expect(universalCarrierHints(['Universal Postal Union'], finnish)).toEqual({ reported_carriers: ['Universal Postal Union'] });
  });

  it('gives a partner its own number when a tracker that also knows it is named', () => {
    // GlobalEco is Evri International's tracker; it also answers the number Paack gives the parcel.
    for (const name of ['Global Eco', 'GlobalEco', 'Evri International']) {
      expect(universalCarrierHints([name], 'H000000000000001')).toEqual({ reported_carriers: [name], discovered_carrier: 'evri' });
      expect(universalCarrierHints([name], 'PK000000000000000001')).toEqual({ reported_carriers: [name], discovered_carrier: 'paack' });
    }
    expect(universalCarrierHints(['Paack'], 'PK000000000000000001').discovered_carrier).toBe('paack');
  });

  it('proposes no carrier whose adapter would refuse the number for its check digit', () => {
    expect(universalCarrierHints(['DHL Express'], '1234567890')).toEqual({ reported_carriers: ['DHL Express'] });
    expect(universalCarrierHints(['DHL Express'], '1234567891')).toEqual({ reported_carriers: ['DHL Express'], discovered_carrier: 'dhl-express' });
    expect(universalCarrierHints(['bpost'], 'RR123456789BE')).toEqual({ reported_carriers: ['bpost'] });
    expect(universalCarrierHints(['bpost'], 'RR123456785BE').discovered_carrier).toBe('bpost');
    // Yamato's adapter does not apply its detection rule's check, so Yamato may still know the number.
    expect(checksumRejections('123456789012').map(({ rule }) => rule)).toContain('yamato-1');
    expect(universalCarrierHints(['Yamato Transport'], '123456789012').discovered_carrier).toBe('yamato');
    // Without the number nothing is ruled out.
    expect(universalCarrierHints(['DHL Express']).discovered_carrier).toBe('dhl-express');
  });

  it('proposes no FedEx for twelve digits that fail its check, though its adapter tracks them', () => {
    // A DHL Paket identcode that a provider files as FedEx's.
    expect(checksumRejections('100000237570').map(({ rule }) => rule)).toContain('fedex-1');
    expect(universalCarrierHints(['FedEx'], '100000237570')).toEqual({ reported_carriers: ['FedEx'] });
    expect(universalCarrierHints(['FedEx'], '100000039595').discovered_carrier).toBe('fedex');
  });

  it('proposes no such carrier when another carrier claims the number with high confidence', async () => {
    // No catalog rule claims ten or twelve digits with high confidence yet. A
    // synthetic one hides the failed waybill and GLS France checks from the
    // suggestions and the rejections, both low-confidence, but their adapters
    // still refuse the number.
    vi.resetModules();
    vi.doMock('../../core/catalog/definitions.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../core/catalog/definitions.js')>();
      const packeta = actual.CARRIER_DEFINITIONS.packeta;
      return { ...actual, CARRIER_DEFINITIONS: { ...actual.CARRIER_DEFINITIONS, packeta: {
        // First, ahead of Packeta's own low rule for its bare packet IDs.
        ...packeta, detectionRules: [{ pattern: '^(?:\\d{10}|\\d{12})$', confidence: 'high' }, ...packeta.detectionRules],
      } } };
    });
    try {
      const detection = await import('../../core/detection/index.js');
      const { universalCarrierHints: hints } = await import('./hints.js');
      for (const [name, rule] of [['DHL Express', 'dhl-express-waybill'], ['GLS France', 'gls-fr-4']] as const) {
        const number = FAILING[rule]!;
        expect(detection.detectCarrierMatch(number)).toMatchObject({ carrier: 'packeta', confidence: 'high' });
        expect(detection.checksumRejections(number)).toEqual([]);
        expect(hints([name], number)).toEqual({ reported_carriers: [name] });
      }
      expect(hints(['DHL Express'], '1234567891').discovered_carrier).toBe('dhl-express');
    } finally {
      vi.doUnmock('../../core/catalog/definitions.js');
      vi.resetModules();
    }
  });

  it('holds a failing number for every adapter-checked rule', () => {
    expect(Object.keys(FAILING).sort()).toEqual([...ADAPTER_CHECKED_RULES].sort());
  });

  it.each(Object.entries(FAILING))('has %s refused by its carrier\'s adapter before any request', async (rule, number) => {
    const rejection = checksumRejections(number).find((item) => item.rule === rule);
    expect(rejection).toBeDefined();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const adapter = registry.for(rejection!.carrier)!;
    // Some adapters refuse synchronously, before returning a promise.
    const error = await (async () => adapter.track({ number, postcode: null }, { budgetMs: 2_000 }))().catch((caught: unknown) => caught);
    expect(carrierErrorKind(error)).toBe('invalid_input');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

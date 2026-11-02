import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryHandoff, hasDirectHandoffAdapter } from './handoff.js';
import { followsPartnerNumbers, partnerNumberOwner } from './partners.js';
import { requiredRequirements } from './definitions.js';
import { recognitionAskedCarriers } from './recognition.js';
import { AdapterRegistry } from '../adapter/index.js';
import { detectCarrierMatch } from '../detection/index.js';
import { carrierErrorKind } from '../errors/index.js';
import { normalizeCarrierResult, type CarrierResult } from '../result/index.js';
import { NOOP_RECORDER } from '../telemetry/index.js';
import { REGISTRY } from '../../generated/registry.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('general delivery handoff candidates', () => {
  it('keeps tracking history when optional partner evidence is malformed', () => {
    expect(normalizeCarrierResult({ delivery_carrier: 'posti', destination_country: 'FI' }))
      .toMatchObject({ delivery_carrier: 'posti', destination_country: 'FI' });
    for (const hints of [
      { delivery_carrier: 'unregistered-carrier', delivery_tracking_number: 'LOCAL12345' },
      { delivery_carrier: 123 },
      { delivery_carrier: 'posti', delivery_tracking_number: { invalid: true } },
      { delivery_carrier: 'posti', delivery_tracking_number: 'bad?number' },
      { destination_country: 'Finland' },
      { destination_country: 123 },
    ]) {
      const result = normalizeCarrierResult({ status: 'delivered', events: [{ description: 'Delivered' }], ...hints });
      expect(result).toMatchObject({ status: 'delivered', events: [{ description: 'Delivered' }] });
      expect(result.delivery_carrier).toBeUndefined();
      expect(result.delivery_tracking_number).toBeUndefined();
      expect(result.destination_country).toBeUndefined();
    }
  });
  it('chooses the declared delivery partner, including a distinct local number', () => {
    expect(deliveryHandoff('la-poste', 'CW123456785FR', {
      destination_country: 'FI', delivery_carrier: 'posti', delivery_tracking_number: 'LOCAL12345',
    })).toEqual({ carrier: 'posti', number: 'LOCAL12345', basis: 'partner' });
    expect(deliveryHandoff('la-poste', 'CW123456785FR', { delivery_carrier: 'usps' })?.carrier).toBe('usps');
  });
  it.each(['XX', 'IN', undefined])('does not guess an operator without a supported destination: %s', (destination_country) => {
    for (const number of ['CW123456785FR', 'LX123456785CH', '1234567890']) {
      expect(deliveryHandoff('la-poste', number, { destination_country })).toBeNull();
    }
  });
  it.each([['FI', 'posti'], ['CH', 'swiss-post'], ['FR', 'la-poste'], ['US', 'usps'], ['SE', 'postnord'], ['Sweden', 'postnord'],
    ['AU', 'australia-post'], ['Australia', 'australia-post'], ['PL', 'poczta-polska'], ['Poland', 'poczta-polska'],
    ['UA', 'ukrposhta'], ['Ukraine', 'ukrposhta'], ['IT', 'poste-italiane'], ['Italy', 'poste-italiane'],
    ['TW', 'chunghwa-post'], ['Taiwan', 'chunghwa-post'], ['RS', 'posta-srbije'], ['Serbia', 'posta-srbije'],
    ['IL', 'israel-post'], ['Israel', 'israel-post']])(
    'proposes one national post for a checksum-valid postal reference going to %s', (destination_country, target) => {
      expect(deliveryHandoff('spring-gds', 'LX123456785NL', { destination_country }))
        .toEqual({ carrier: target, number: 'LX123456785NL', basis: 'destination' });
    },
  );
  it('proposes a national post only for a postal number its adapter looks up', async () => {
    const regions = Array.from({ length: 26 * 26 }, (_, index) => String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)));
    // Registered, tracked letter, parcel, EMS and customs-label items issued abroad.
    const proposals = regions.flatMap((destination_country) => ['RA', 'LX', 'CP', 'EA', 'UA'].map((service) =>
      deliveryHandoff('aliexpress', `${service}123456799CN`, { destination_country }))).filter((proposal) => proposal !== null);
    expect(proposals.map(({ carrier }) => carrier)).toContain('australia-post');
    for (const { carrier, number } of proposals) {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
      vi.stubGlobal('fetch', fetcher);
      const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
      expect(registry.has(carrier), carrier).toBe(true);
      // Some adapters refuse synchronously, before returning a promise.
      const error = await (async () => registry.for(carrier)!.track({ number, postcode: null }, { budgetMs: 2_000 }))()
        .catch((caught: unknown) => caught);
      // Offline, a lookup fails on its request or on a missing browser service, never on the number.
      expect(carrierErrorKind(error), `${carrier} ${number}`).not.toBeNull();
      expect(carrierErrorKind(error), `${carrier} ${number}`).not.toBe('invalid_input');
    }
  });
  it('hands no post a waybill that only takes the S10 layout', () => {
    // Morning Global's BR…MG waybill passing the check digit, and Madagascar's own item.
    expect(deliveryHandoff('morning-global', 'BR123456785MG', { destination_country: 'CA' })).toBeNull();
    expect(deliveryHandoff('morning-global', 'BR123456785MG', {}, 'FR')).toBeNull();
    // M-ONE's parcel in Pošta Srbije's layout, which M-ONE delivers.
    expect(deliveryHandoff('m-one', 'PL123456785RS', { destination_country: 'RS' })).toBeNull();
    expect(deliveryHandoff('m-one', 'PL123456785RS', {}, 'DE')).toBeNull();
    expect(deliveryHandoff('aliexpress', 'RR123456785MG', { destination_country: 'CA' }))
      .toEqual({ carrier: 'canada-post', number: 'RR123456785MG', basis: 'destination' });
  });
  it('hands Japan Post no customs label, which it does not track', () => {
    expect(deliveryHandoff('aliexpress', 'RA123456785CN', { destination_country: 'JP' }))
      .toEqual({ carrier: 'japan-post', number: 'RA123456785CN', basis: 'destination' });
    expect(deliveryHandoff('aliexpress', 'UA123456785CN', { destination_country: 'JP' })).toBeNull();
    expect(deliveryHandoff('aliexpress', 'UA123456785CN', { destination_country: 'FR' }))
      .toEqual({ carrier: 'la-poste', number: 'UA123456785CN', basis: 'destination' });
  });
  it('hands EMS from abroad to Parcelforce, the UK EMS operator, and other mail to Royal Mail', () => {
    expect(deliveryHandoff('japan-post', 'EA123456785JP', { destination_country: 'GB' }))
      .toEqual({ carrier: 'parcelforce', number: 'EA123456785JP', basis: 'destination' });
    expect(deliveryHandoff('japan-post', 'EA123456785JP', {}, 'GB'))
      .toEqual({ carrier: 'parcelforce', number: 'EA123456785JP', basis: 'destination' });
    expect(deliveryHandoff('japan-post', 'RA123456785JP', { destination_country: 'GB' }))
      .toEqual({ carrier: 'royal-mail', number: 'RA123456785JP', basis: 'destination' });
  });
  it('hands mail from abroad to New Zealand to NZ Post', () => {
    expect(deliveryHandoff('japan-post', 'RA123456785JP', {}, 'NZ'))
      .toEqual({ carrier: 'nz-post', number: 'RA123456785JP', basis: 'destination' });
    expect(deliveryHandoff('japan-post', 'EA123456785JP', { destination_country: 'New Zealand' }))
      .toEqual({ carrier: 'nz-post', number: 'EA123456785JP', basis: 'destination' });
  });
  it.each(['LX123456789NL', '1234567890', '3SABC12345678', 'LP00000000000001'])(
    'does not try a national post for a non-postal or invalid reference: %s', (number) => {
      expect(deliveryHandoff('spring-gds', number, { destination_country: 'CH' })).toBeNull();
    },
  );
  it('asks the post of the country a postal item from abroad is looked up from, when nothing names its destination', () => {
    for (const hint of ['FI', ' fi ']) {
      expect(deliveryHandoff('an-post', 'LX123456785IE', { status: 'in_transit' }, hint))
        .toEqual({ carrier: 'posti', number: 'LX123456785IE', basis: 'destination' });
    }
    // Chunghwa Post follows a tracked letter from abroad under the sending post's number.
    expect(deliveryHandoff('lietuvos-pastas', 'LX123456785LT', { status: 'in_transit' }, 'TW'))
      .toEqual({ carrier: 'chunghwa-post', number: 'LX123456785LT', basis: 'destination' });
    expect(deliveryHandoff('lietuvos-pastas', 'UA123456785LT', { status: 'in_transit' }, 'TW')).toBeNull();
    // A reported destination or partner comes first, even one no post answers for.
    expect(deliveryHandoff('an-post', 'LX123456785IE', { destination_country: 'SE' }, 'FI')?.carrier).toBe('postnord');
    expect(deliveryHandoff('an-post', 'LX123456785IE', { destination_country: 'Estonia' })?.carrier).toBe('omniva');
    for (const [destination, post] of [['KG', 'kyrgyz-post'], ['Pakistan', 'pakistan-post'], ['PE', 'serpost'], ['Indonesia', 'pos-indonesia']]) {
      expect(deliveryHandoff('an-post', 'LX123456785IE', { destination_country: destination })).toEqual({ carrier: post, number: 'LX123456785IE', basis: 'destination' });
    }
    expect(deliveryHandoff('an-post', 'LX123456785IE', { destination_country: 'IN' }, 'FI')).toBeNull();
    expect(deliveryHandoff('an-post', 'LX123456785IE', { delivery_carrier: 'usps' }, 'FI')?.carrier).toBe('usps');
    // Not from the issuer's own country, a country no post answers for, a name, or no hint.
    for (const hint of ['IE', 'XX', 'Finland', '', null, undefined]) {
      expect(deliveryHandoff('an-post', 'LX123456785IE', {}, hint), String(hint)).toBeNull();
    }
    // Nor for a number that is no postal item, nor the post the parcel is already filed under.
    expect(deliveryHandoff('la-poste', '1234567890', {}, 'FI')).toBeNull();
    expect(deliveryHandoff('posti', 'LX123456785IE', {}, 'FI')).toBeNull();
  });
  it('asks the lookup country\'s post about a Deutsche Post item DHL holds no scan for', () => {
    // DHL's answer for an item Deutsche Post does not scan: no history, no destination.
    const unscanned: CarrierResult = { status: 'unknown', last_update: null, expected_delivery: null, events: [] };
    expect(detectCarrierMatch('UL123456785DE')).toMatchObject({ carrier: 'dhl', confidence: 'high' });
    expect(deliveryHandoff('dhl', 'UL123456785DE', unscanned, 'FR'))
      .toEqual({ carrier: 'la-poste', number: 'UL123456785DE', basis: 'destination' });
    for (const hint of ['DE', null]) expect(deliveryHandoff('dhl', 'UL123456785DE', unscanned, hint), String(hint)).toBeNull();
  });

  it('leaves Chronopost the codes, French items and EMS it delivers itself', () => {
    for (const number of ['XW123456785TS', 'NP123456785JB', 'XY123456785DE', 'CW123456785FR', 'EE123456785CN']) {
      expect(deliveryHandoff('chronopost', number, { destination_country: 'FR' }, 'FR'), number).toBeNull();
      expect(deliveryHandoff('chronopost', number, {}, 'FR'), number).toBeNull();
    }
    expect(deliveryHandoff('chronopost', 'RR123456785TW', { destination_country: 'FI' }))
      .toEqual({ carrier: 'posti', number: 'RR123456785TW', basis: 'destination' });
  });

  it('uses the destination instead of treating a postal reference’s issuer as its delivery operator', () => {
    expect(deliveryHandoff('aliexpress', 'LP00000000000001', {
      destination_country_name: 'Finland', delivery_tracking_number: 'RA123456785CH',
    })).toEqual({ carrier: 'posti', number: 'RA123456785CH', basis: 'destination' });
    expect(deliveryHandoff('spring-gds', 'LX123456785NL', { destination_country: 'NL' })).toBeNull();
  });
  it('uses the reported operator even when the destination also has another carrier', () => {
    expect(deliveryHandoff('la-poste', 'CW123456785FR', { destination_country: 'FI', delivery_carrier: 'ups' }))
      .toEqual({ carrier: 'ups', number: 'CW123456785FR', basis: 'partner' });
    expect(deliveryHandoff('spring-gds', 'LX123456785NL', {
      destination_country: 'FI', last_status_text: 'Delivery partner: https://www.post.ch/',
    })).toEqual({ carrier: 'swiss-post', number: 'LX123456785NL', basis: 'partner' });
  });
  it.each([
    ['RA123456785CH', 'swiss-post'], ['1Z1234567890123454', 'ups'], ['CW123456785FR', 'la-poste'],
  ])('preserves an independently reported reference and proposes its catalog carrier: %s', (reference, carrier) => {
    const result = normalizeCarrierResult({ status: 'in_transit', delivery_tracking_number: reference });
    expect(result.delivery_tracking_number).toBe(reference);
    expect(result.delivery_carrier).toBeUndefined();
    expect(deliveryHandoff('aliexpress', 'LP00000000000001', result)).toEqual({ carrier, number: reference, basis: 'reference' });
  });
  it.each(['LOCAL12345', '1234567890', 'RA123456789CH', 'bad?number'])('does not guess from an unrecognized, ambiguous or invalid reference: %s', (reference) => {
    expect(deliveryHandoff('aliexpress', 'LP00000000000001', { delivery_tracking_number: reference })).toBeNull();
  });
  it('lets a reported partner take precedence over number detection', () => {
    expect(deliveryHandoff('aliexpress', 'LX123456785CH', { delivery_tracking_number: 'RA123456785CH', delivery_carrier: 'posti' }))
      .toEqual({ carrier: 'posti', number: 'RA123456785CH', basis: 'partner' });
  });
  it('limits the historical Swiss probe to its known route and respects a different destination', () => {
    expect(deliveryHandoff('aliexpress', 'LX123456785CH', {})).toEqual({ carrier: 'swiss-post', number: 'LX123456785CH', basis: 'reference' });
    for (const number of ['LX123456789CH', 'LX123456785NL', 'LP00000000000001']) {
      expect(deliveryHandoff('aliexpress', number, {})).toBeNull();
    }
    expect(deliveryHandoff('aliexpress', 'LX123456785CH', { destination_country: 'FI' }))
      .toEqual({ carrier: 'posti', number: 'LX123456785CH', basis: 'destination' });
    expect(deliveryHandoff('aliexpress', 'LX123456785CH', { destination_country_name: 'Finland' }))
      .toEqual({ carrier: 'posti', number: 'LX123456785CH', basis: 'destination' });
    expect(deliveryHandoff('aliexpress', 'LX123456785CH', { delivery_carrier: 'postnord' }))
      .toEqual({ carrier: 'postnord', number: 'LX123456785CH', basis: 'partner' });
  });
  it('ignores malformed persisted hints without throwing during origin recovery', () => {
    expect(deliveryHandoff('aliexpress', 'LX123456785CH', { delivery_tracking_number: 123 } as unknown as CarrierResult)).toBeNull();
    expect(deliveryHandoff('aliexpress', 'LX123456785CH', { destination_country: 123 } as unknown as CarrierResult))
      .toEqual({ carrier: 'swiss-post', number: 'LX123456785CH', basis: 'reference' });
  });
  it('requires a dedicated adapter and never borrows another carrier’s credentials', () => {
    for (const delivery_carrier of ['dpd', 'amazon-logistics', 'not-a-carrier', 'la-poste']) {
      expect(deliveryHandoff('la-poste', 'CW123456785FR', { delivery_carrier, destination_country: 'FI' })).toBeNull();
    }
    expect(deliveryHandoff('la-poste', 'CW123456785FR', { delivery_carrier: 'posti', delivery_tracking_number: 'bad?number' })).toBeNull();
    expect(deliveryHandoff('la-poste', 'CW123456785FR', { delivery_carrier: 'bpost' }))
      .toEqual({ carrier: 'bpost', number: 'CW123456785FR', basis: 'partner' });
  });
});

describe('an origin that follows the parcel under its delivery carrier\'s number', () => {
  // AliExpress shows the buyer SDA's waybill, so Cainiao and Poste Italiane know the same number.
  const waybill = '000D00000001F';

  it('proposes the carrier of the destination country that issues the number', () => {
    expect(followsPartnerNumbers('aliexpress')).toBe(true);
    for (const destination of [{ destination_country_name: 'Italy' }, { destination_country: 'IT' }]) {
      expect(deliveryHandoff('aliexpress', waybill, normalizeCarrierResult({ status: 'in_transit', ...destination })))
        .toEqual({ carrier: 'poste-italiane', number: waybill, basis: 'reference' });
    }
  });
  it('proposes nobody without that destination', () => {
    for (const destination of [{}, { destination_country_name: 'France' }, { destination_country: 'CH' }]) {
      expect(deliveryHandoff('aliexpress', waybill, destination)).toBeNull();
    }
  });
  it('proposes nobody for a shape the origin is not known to show', () => {
    // Other SDA shapes fit Poste Italiane alone, and a Cainiao number fits no Italian carrier.
    for (const number of ['990001A000001', '3C9900A000001', 'LP00000000000001']) {
      expect(deliveryHandoff('aliexpress', number, { destination_country: 'IT' })).toBeNull();
    }
  });
  it('proposes the carrier that alone issues the number, where it delivers', () => {
    // Cainiao also follows Ecoscooting's Portuguese references before Ecoscooting has the parcel.
    const reference = 'CNPRT00000001234000000001';
    for (const destination of [{ destination_country_name: 'Portugal' }, { destination_country: 'ES' }]) {
      expect(deliveryHandoff('aliexpress', reference, destination))
        .toEqual({ carrier: 'ecoscooting', number: reference, basis: 'reference' });
    }
    for (const destination of [{}, { destination_country_name: 'France' }]) {
      expect(deliveryHandoff('aliexpress', reference, destination)).toBeNull();
    }
    expect(deliveryHandoff('aliexpress', 'DOFR0000000000001HD', { destination_country: 'FR' })).toBeNull();
  });
  it('leaves carriers that track only their own numbers alone', () => {
    for (const carrier of ['poste-italiane', 'four-px', 'la-poste']) {
      expect(followsPartnerNumbers(carrier)).toBe(false);
      expect(deliveryHandoff(carrier, waybill, { destination_country: 'IT' })).toBeNull();
    }
  });
  it('keeps a partner or a second reference the origin names', () => {
    expect(deliveryHandoff('aliexpress', waybill, { destination_country: 'IT', delivery_carrier: 'ups' }))
      .toEqual({ carrier: 'ups', number: waybill, basis: 'partner' });
    expect(deliveryHandoff('aliexpress', waybill, { destination_country: 'IT', delivery_tracking_number: '1Z1234567890123454' }))
      .toEqual({ carrier: 'ups', number: '1Z1234567890123454', basis: 'reference' });
  });
});

describe('delivery partners with an optional input', () => {
  it('hands DPD only a reference of its own shape, and never its postcode', () => {
    expect(hasDirectHandoffAdapter('dpd', '06080000000002')).toBe(true);
    expect(hasDirectHandoffAdapter('dpd', 'CW123456785FR')).toBe(false);
    // A required postcode still rules a partner out.
    expect(hasDirectHandoffAdapter('gls-ch', '123456789012')).toBe(false);
    expect(deliveryHandoff('la-poste', 'CW123456785FR', { delivery_carrier: 'dpd', delivery_tracking_number: '06080000000002' }))
      .toEqual({ carrier: 'dpd', number: '06080000000002', basis: 'partner' });
    // Without its own number the partner would be asked about the postal one.
    expect(deliveryHandoff('la-poste', 'CW123456785FR', { delivery_carrier: 'dpd' })).toBeNull();
  });
});

describe('delivery partners that look up only their own references', () => {
  it('asks Poste Italiane about its own numbers, the partner plates it takes over and S10 items from abroad', async () => {
    // DHL names Poste Italiane for parcels bound for Italy, under DHL's own postal number.
    expect(deliveryHandoff('dhl', 'LF123456785DE', { destination_country: 'IT', delivery_carrier: 'poste-italiane' }))
      .toEqual({ carrier: 'poste-italiane', number: 'LF123456785DE', basis: 'partner' });
    expect(deliveryHandoff('dhl', 'LF123456780DE', { destination_country: 'IT', delivery_carrier: 'poste-italiane' })).toBeNull();
    const plate = 'JJD000000000000000000001';
    expect(deliveryHandoff('ppl', plate, { destination_country: 'IT', delivery_carrier: 'poste-italiane' }))
      .toEqual({ carrier: 'poste-italiane', number: plate, basis: 'partner' });
    expect(hasDirectHandoffAdapter('poste-italiane', '990001A000001')).toBe(true);
    // The check mirrors the adapter, which refuses any other reference before a request.
    for (const number of ['LF123456790DE', '1Z1234567890123454']) expect(hasDirectHandoffAdapter('poste-italiane', number)).toBe(false);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const outcome = (number: string) => (async () => registry.for('poste-italiane')!.track({ number, postcode: null }, { budgetMs: 2_000 }))()
      .then(() => null, (caught: unknown) => carrierErrorKind(caught));
    for (const number of ['LF123456790DE', '1Z1234567890123454']) expect(await outcome(number)).toBe('invalid_input');
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of [plate, '990001A000001', 'LF123456799DE']) expect(await outcome(number)).not.toBe('invalid_input');
    expect(fetcher).toHaveBeenCalled();
  });

  it('asks DHL Express only about its waybills and pieces, never about DHL Paket’s postal number', async () => {
    expect(deliveryHandoff('dhl', 'CX123456785DE', { delivery_carrier: 'dhl-express' })).toBeNull();
    expect(deliveryHandoff('dhl', 'CX123456785DE', { delivery_carrier: 'dhl-express', delivery_tracking_number: '1234567891' }))
      .toEqual({ carrier: 'dhl-express', number: '1234567891', basis: 'partner' });
    for (const piece of ['JD014600000000000001', 'JJD014600000000000001', 'JD014600000000000001J']) expect(hasDirectHandoffAdapter('dhl-express', piece)).toBe(true);
    for (const number of ['1234567890', 'CX123456785DE']) expect(hasDirectHandoffAdapter('dhl-express', number)).toBe(false);
    // The check mirrors the adapter, which refuses any other reference before a request.
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const error = await (async () => registry.for('dhl-express')!.track({ number: 'CX123456785DE', postcode: null }, { budgetMs: 2_000 }))()
      .catch((caught: unknown) => caught);
    expect(carrierErrorKind(error)).toBe('invalid_input');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('asks Blue Dart only about its eleven-digit waybills', async () => {
    expect(deliveryHandoff('icc-worldwide', '12345678901', { delivery_carrier: 'blue-dart', delivery_tracking_number: '69000000011' }))
      .toEqual({ carrier: 'blue-dart', number: '69000000011', basis: 'partner' });
    expect(deliveryHandoff('icc-worldwide', '12345678901', { delivery_carrier: 'blue-dart', delivery_tracking_number: 'SYNTH1234' })).toBeNull();
    // The check mirrors the adapter, which refuses any other reference before a request.
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const error = await (async () => registry.for('blue-dart')!.track({ number: 'SYNTH1234', postcode: null }, { budgetMs: 2_000 }))()
      .catch((caught: unknown) => caught);
    expect(carrierErrorKind(error)).toBe('invalid_input');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('asks ACS only about its ten-digit vouchers and Correos de Chile only about its own numbers', async () => {
    expect(deliveryHandoff('dpd-ro', '80000000002', { delivery_carrier: 'acs-courier', delivery_tracking_number: '9900000001' }))
      .toEqual({ carrier: 'acs-courier', number: '9900000001', basis: 'partner' });
    expect(deliveryHandoff('dpd-ro', '80000000002', { delivery_carrier: 'acs-courier', delivery_tracking_number: 'SYNTH1234' })).toBeNull();
    expect(deliveryHandoff('aliexpress', 'LX123456785CN', { destination_country: 'CL', delivery_carrier: 'correos-chile' })).toBeNull();
    for (const number of ['1234567890123', 'RR123456785CL']) expect(hasDirectHandoffAdapter('correos-chile', number)).toBe(true);
    // The check mirrors the adapters, which refuse any other reference before a request.
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const outcome = (carrier: string, number: string) => (async () => registry.for(carrier)!.track({ number, postcode: null }, { budgetMs: 2_000 }))()
      .then(() => null, (caught: unknown) => carrierErrorKind(caught));
    expect(await outcome('acs-courier', 'SYNTH1234')).toBe('invalid_input');
    for (const number of ['LX123456785CN', 'RR123456780CL']) expect(await outcome('correos-chile', number)).toBe('invalid_input');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('a partner number another tracker also knows', () => {
  // Synthetic: an Evri barcode, and a number Paack gives a parcel from Evri International.
  const barcode = 'H000000000000001';
  const paack = 'PK000000000000000001';
  it('belongs to the partner: detection offers Paack alone, so recognition asks nobody', () => {
    expect(detectCarrierMatch(paack)).toMatchObject({ carrier: 'paack', confidence: 'high' });
    expect(recognitionAskedCarriers(paack)).toEqual([]);
    expect(partnerNumberOwner('evri', paack)).toBe('paack');
    expect(partnerNumberOwner('evri', barcode)).toBeUndefined();
    // Only a tracker known to answer its partners' numbers gives them up.
    expect(partnerNumberOwner('aliexpress', paack)).toBeUndefined();
  });
  it('hands the Paack number to Paack, which needs no postcode for it', () => {
    expect(requiredRequirements('paack', paack)).toEqual([]);
    expect(hasDirectHandoffAdapter('paack', paack)).toBe(true);
    expect(deliveryHandoff('evri', barcode, { delivery_carrier: 'paack', delivery_tracking_number: paack }))
      .toEqual({ carrier: 'paack', number: paack, basis: 'partner' });
    // Paack's other numbers have no shape of their own and are never asked about the Evri barcode.
    expect(hasDirectHandoffAdapter('paack', 'PAACK12345')).toBe(false);
    expect(deliveryHandoff('evri', barcode, { delivery_carrier: 'paack' })).toBeNull();
  });
});

describe('partner link handoff candidates', () => {
  it('uses a provider-supplied delivery reference', () => {
    expect(deliveryHandoff('gls-de', '123456789011', {
      delivery_carrier: 'swiss-post', delivery_tracking_number: '12345678901',
    })).toEqual({ carrier: 'swiss-post', number: '12345678901', basis: 'partner' });
  });
  it.each([
    ['aliexpress', 'https://service.post.ch/ekp-web/ui/list', 'swiss-post'],
    ['dhl', 'https://www.posti.fi/en/tracking', 'posti'],
    ['la-poste', 'https://tools.usps.com/go/TrackConfirmAction', 'usps'],
    ['aliexpress', 'https://tracking.postnord.com/en/', 'postnord'],
  ])('uses the catalog to resolve %s partner link %s', (carrier, url, target) => {
    expect(deliveryHandoff(carrier, 'OTHER12345', {
      events: [{ description: `Delivery partner tracking: ${url}` }],
    })).toEqual({ carrier: target, number: 'OTHER12345', basis: 'partner' });
  });
  it.each(['https://post.ch.evil.test', 'https://post.ch@evil.test', 'https://evil.test/post.ch', 'Swiss Post maybe'])('does not trust ambiguous partner text: %s', (description) => {
    expect(deliveryHandoff('aliexpress', 'OTHER12345', { last_status_text: description })).toBeNull();
  });
  it('ignores self-links and conflicting partner links', () => {
    expect(deliveryHandoff('posti', 'OTHER12345', { last_status_text: 'https://www.posti.fi/en/tracking' })).toBeNull();
    expect(deliveryHandoff('la-poste', 'OTHER12345', { last_status_text: 'https://www.posti.fi/ and https://www.post.ch/' })).toBeNull();
    expect(deliveryHandoff('spring-gds', 'LX123456785NL', {
      destination_country: 'CH', last_status_text: 'https://www.posti.fi/ and https://www.post.ch/',
    })).toBeNull();
  });
});

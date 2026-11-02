import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_CARRIER_IDS,
  CARRIERS,
  CARRIER_NAMES,
  SELECTABLE_CARRIERS,
  TRACKING_LINK_RULES,
  activeRequirements,
  carrierAdapter,
  carrierDefinition,
  carrierInfo,
  carrierLinkRules,
  carrierRequirements,
  carrierTimezone,
  localizedCarrierUrl,
  requirementSatisfied,
  tracksAutomatically,
  trackingNumberForLink,
} from './index.js';
import { parcelTrackingLinks } from './parcel.js';

/**
 * Per-carrier expectations stay in src/lib/carriers.test.ts. What this file
 * covers is the derivation itself: the fields `CARRIERS` computes from the
 * generated catalog and the lookups the server reads from it.
 */
describe('the derived CARRIERS record', () => {
  it('carries the catalog fields and a portal link built from the template', () => {
    expect(CARRIERS['swiss-post']).toMatchObject({
      id: 'swiss-post',
      name: 'Swiss Post',
      capabilities: { selectable: true, timezone: 'Europe/Zurich', tracking: { mode: 'automatic', adapter: 'swiss-post' } },
    });
    expect(CARRIERS['swiss-post'].trackingUrl?.('RA123456785CH'))
      .toBe('https://service.post.ch/ekp-web/ui/entry/search/RA123456785CH');
    expect(CARRIERS['swiss-post'].trackingSearchUrl).toBe('https://www.post.ch/de/empfangen/sendung-verfolgen');
    expect(CARRIERS['swiss-post'].helpUrl).toBe('https://www.post.ch/de/hilfe-und-kontakt/empfangen');
    expect(SELECTABLE_CARRIERS.every((carrier) => carrier.capabilities.selectable)).toBe(true);
    expect(tracksAutomatically('swiss-post')).toBe(true);
  });

  it('says which numbers a carrier tracks no further than its own country', () => {
    // PostNL's tracker names no carrier in the destination country for Spring's 18-digit numbers;
    // an S10 number goes on to the destination post under the same number.
    expect(CARRIERS['spring-gds'].hidesDestinationLeg?.('100000000000000001')).toBe(true);
    expect(CARRIERS['spring-gds'].hidesDestinationLeg?.('RR123456785NL')).toBe(false);
    expect(CARRIERS['swiss-post'].hidesDestinationLeg).toBeUndefined();
  });

  it('translates the placeholder carrier names and falls back to the unknown carrier', () => {
    expect(carrierInfo('unknown', 'fr').name).toBe('Transporteur inconnu');
    expect(carrierInfo('unknown').name).toBe(CARRIERS.unknown.name);
    expect(carrierInfo('not-a-carrier' as 'unknown').id).toBe('unknown');
  });

  it('shortens the numbers whose portal expects a different form', () => {
    expect(trackingNumberForLink('mondial-relay', '12123456780101006623123454')).toBe('121234567801');
    // Border Express's tracker takes the consignment a unit's barcode is read into.
    expect(trackingNumberForLink('border-express', 'ZZZZBX00000010000001')).toBe('ZZZZ010000');
    expect(trackingNumberForLink('border-express', '00000001')).toBe('00000001');
    expect(trackingNumberForLink('c-chez-vous', 'ABC12345678-75001')).toBe('ABC12345678--75001');
    expect(trackingNumberForLink('the-courier-guy', 'ld 000001')).toBe('LD-000001');
    expect(trackingNumberForLink('the-courier-guy', 'DD-000001')).toBe('DD-000001');
    expect(trackingNumberForLink('the-courier-guy', 'TESTA1')).toBe('TESTA1');
    expect(trackingNumberForLink('swiss-post', 'RA123456785CH')).toBe('RA123456785CH');
    expect(trackingNumberForLink('postlogistics', '12345678001')).toBe('12345678-001');
    expect(trackingNumberForLink('cdl', '1000000010')).toBe('100000001-0');
    expect(trackingNumberForLink('cdl', '100000001-0')).toBe('100000001-0');
    expect(trackingNumberForLink('cdl', 'CDL00000000001')).toBe('CDL00000000001');
    // tnt.it finds a waybill without the check digit its label prints after a dash, tnt.com a consignment without GE and WW.
    expect(trackingNumberForLink('tnt-it', 'ZZ00000001-7')).toBe('ZZ00000001');
    expect(trackingNumberForLink('tnt-it', 'ZZ00000001')).toBe('ZZ00000001');
    // TForce Freight's page takes the PRO a PARS number carries.
    expect(trackingNumberForLink('tforce-freight', '2205123456782')).toBe('123456782');
    expect(trackingNumberForLink('tforce-freight', '123456782')).toBe('123456782');
    expect(trackingNumberForLink('tforce-freight', '2205123456780')).toBe('2205123456780');
    expect(trackingNumberForLink('tnt', 'GE123456785WW')).toBe('123456785');
    expect(trackingNumberForLink('tnt', '123456785')).toBe('123456785');
    // Pack-Man's page finds a voucher only with the hyphen after its letter.
    expect(trackingNumberForLink('pack-man', 'A00000017')).toBe('A-00000017');
    expect(trackingNumberForLink('pack-man', 'a-00000017')).toBe('A-00000017');
    expect(trackingNumberForLink('pack-man', 'SAMPLE')).toBe('SAMPLE');
    expect(trackingNumberForLink('gogo-xpress', 'zxqa00000001')).toBe('ZXQA-0000-0001');
    expect(trackingNumberForLink('gogo-xpress', 'ZXQA-0000-0001')).toBe('ZXQA-0000-0001');
    expect(trackingNumberForLink('gogo-xpress', '000000000001')).toBe('000000000001');
    expect(CARRIERS['gogo-xpress'].trackingUrl?.('zxqa00000001')).toBe('https://app.gogoxpress.com/track/ZXQA-0000-0001');
    expect(trackingNumberForLink('zr-express', '00000000ZR')).toBe('00-000000-ZR');
    expect(trackingNumberForLink('zr-express', '00-000000-zr')).toBe('00-000000-ZR');
    expect(trackingNumberForLink('zr-express', 'SAMPLE')).toBe('SAMPLE');
    expect(CARRIERS['zr-express'].trackingUrl?.('00000000ZR')).toBe('https://www.zrexpress.net/suivi?tn=00-000000-ZR');
    // MHI's tracker finds a P series number only with its label's dashes, and the other series without them.
    expect(trackingNumberForLink('mhi', 'mhi999p000000017')).toBe('MHI-999-P000000017');
    expect(trackingNumberForLink('mhi', 'MHI-999-P000000017')).toBe('MHI-999-P000000017');
    expect(trackingNumberForLink('mhi', 'MHI999W000000000017')).toBe('MHI999W000000000017');
    expect(trackingNumberForLink('mhi', 'SAMPLE')).toBe('SAMPLE');
    expect(CARRIERS.mhi.trackingUrl?.('MHI999P000000017')).toBe('https://www.trackmail.co.uk/?Tracking=MHI-999-P000000017&command=Track');
    expect(trackingNumberForLink('noest', 'abc12300000000')).toBe('ABC-123-00000000');
    expect(trackingNumberForLink('noest', 'ABC-123-00000000')).toBe('ABC-123-00000000');
    expect(trackingNumberForLink('noest', 'SAMPLE')).toBe('SAMPLE');
    expect(CARRIERS.noest.trackingUrl?.('ABC12300000000')).toBe('https://app.noest-dz.com/list/t/ABC-123-00000000');
    expect(trackingNumberForLink('paperfly', '010125000000A1A1')).toBe('010125-000000-A1-A1');
    expect(trackingNumberForLink('paperfly', 'z0101250000a1a1')).toBe('Z-010125-0000-A1-A1');
    expect(trackingNumberForLink('paperfly', 'PFLBDZZ0000000000')).toBe('PFL-BD-ZZ-0000000000');
    expect(trackingNumberForLink('paperfly', 'SAMPLE')).toBe('SAMPLE');
    expect(CARRIERS.paperfly.trackingUrl?.('01012500000A1A1')).toBe('https://go.paperfly.com.bd/track/order/010125-00000-A1-A1');
    expect(CARRIERS['pack-man'].trackingUrl?.('A00000017')).toBe('https://pack-man.gr/anazitisi-apostolis.html?code=A-00000017');
    expect(trackingNumberForLink('upaya', 'qqqqqq000000000000')).toBe('QQQQQQ00000-0000000');
    expect(trackingNumberForLink('upaya', 'QQQQQQ0000-0000000')).toBe('QQQQQQ0000-0000000');
    expect(trackingNumberForLink('upaya', 'SAMPLE')).toBe('SAMPLE');
    expect(CARRIERS.upaya.trackingUrl?.('QQQQQQ000000000000')).toBe('https://upaya.com.np/track/?tracking=QQQQQQ00000-0000000');
    expect(trackingNumberForLink('flippost', '000000009')).toBe('00-0000009');
    expect(trackingNumberForLink('flippost', '0000009')).toBe('000-0009');
    expect(trackingNumberForLink('flippost', '00 0000009')).toBe('00-0000009');
    // Eight digits are four and four or two and three and three: they stay as given.
    expect(trackingNumberForLink('flippost', '00000009')).toBe('00000009');
    expect(trackingNumberForLink('flippost', '00-000-009')).toBe('00-000-009');
    expect(trackingNumberForLink('flippost', 'SAMPLE')).toBe('SAMPLE');
    expect(CARRIERS.flippost.trackingUrl?.('000000009')).toBe('https://flippost.com/instruments/online/?number=00-0000009');
    expect(trackingNumberForLink('ecoscooting', 'prt 0000000 1234 000000001')).toBe('CNPRT00000001234000000001');
    expect(trackingNumberForLink('ecoscooting', 'CNPRT00000001234000000001')).toBe('CNPRT00000001234000000001');
    expect(trackingNumberForLink('ecoscooting', '000000000000000001')).toBe('000000000000000001');
    expect(CARRIERS.postlogistics.trackingUrl?.('12345678001'))
      .toBe('https://apv.swisspost-cargo.com/public/trackandtrace/12345678-001');
    expect(trackingNumberForLink('gofo-fr', 'PK00000000000000000001'))
      .toBe('PK-0000000000000000000-1');
    expect(CARRIERS['gofo-fr'].trackingUrl?.('PK00000000000000000001'))
      .toBe('https://www.gofo.com/fr/tracking-results/?id=PK-0000000000000000000-1');
  });

  it('fills every placeholder of a template that names the number twice', () => {
    expect(CARRIERS['fedex-pl'].trackingUrl?.('6230000000005'))
      .toBe('https://fds2tracking.emea.fedex.com/#/preview?packages=6230000000005&trackingKey=6230000000005');
    for (const carrier of Object.values(CARRIERS)) {
      expect(carrier.trackingUrl?.('ZZ0000000000') ?? '', carrier.id).not.toContain('{trackingNumber}');
    }
  });

  it('routes Ninja Van portal links to the identifier\'s national network', () => {
    for (const country of ['sg', 'my', 'id', 'ph', 'th', 'vn']) {
      const number = `NL${country.toUpperCase()}A00000000`;
      const host = country === 'id' ? 'www.ninjaxpress.co' : 'www.ninjavan.co';
      expect(CARRIERS['ninja-van'].trackingUrl?.(number))
        .toBe(`https://${host}/en-${country}/tracking?id=${number}`);
    }
    expect(CARRIERS['ninja-van'].trackingUrl?.('njvtt 00000000000'))
      .toBe('https://www.ninjaxpress.co/en-id/tracking?id=NJVTT00000000000');
    expect(CARRIERS['ninja-van'].trackingUrl?.('UNSCOPED00000000'))
      .toBe('https://www.ninjavan.co/en-my/tracking?id=UNSCOPED00000000');
  });
});

describe('the catalog lookups the server reads', () => {
  it('answers timezone, adapter and automatic-carrier questions', () => {
    expect(carrierTimezone('swiss-post')).toBe('Europe/Zurich');
    expect(carrierAdapter('swiss-post')).toBe('swiss-post');
    expect(carrierAdapter('amazon-logistics')).toBeNull();
    expect(AUTOMATIC_CARRIER_IDS.has('swiss-post')).toBe(true);
    expect(AUTOMATIC_CARRIER_IDS.has('amazon-logistics')).toBe(false);
    expect(CARRIER_NAMES.get('swiss-post')).toBe('Swiss Post');
    expect(() => carrierDefinition('not-a-carrier')).toThrow(RangeError);
  });

  it('gives a carrier that delivers on one clock that zone, and none to one that delivers on several', () => {
    expect(carrierTimezone('brt')).toBe('Europe/Rome');
    expect(carrierTimezone('royal-mail')).toBe('Europe/London');
    expect(carrierTimezone('parcelforce')).toBe('Europe/London');
    expect(carrierTimezone('the-courier-guy')).toBe('Africa/Johannesburg');
    for (const carrier of ['ups', 'australia-post', 'ecoscooting', 'inpost', 'gofo']) expect(carrierTimezone(carrier), carrier).toBe('UTC');
  });

  it('anchors the server requirement filter and leaves the form filter unanchored', () => {
    // A 26-digit Mondial Relay label barcode carries its own check digits.
    expect(activeRequirements('mondial-relay', '12123456780101006623123454')).toEqual([]);
    expect(activeRequirements('mondial-relay', '12345678').map((item) => item.validator)).toEqual(['internationalPostcode']);
    expect(carrierRequirements('mondial-relay', '12345678').map((item) => item.field)).toEqual(['postcode']);
    // The brand forms are found without a postcode.
    expect(activeRequirements('mondial-relay', '1212345678')).toEqual([]);
    expect(activeRequirements('mondial-relay', '121234567801')).toEqual([]);
    expect(activeRequirements('swiss-post', 'RA123456785CH')).toEqual([]);
  });

  it('tells optional postcodes from required ones', () => {
    expect(activeRequirements('dpd', '06080000000001')).toMatchObject([{ field: 'postcode', optional: true }]);
    // Paack's numbers for Evri International parcels track without one.
    expect(activeRequirements('paack', 'PAACK12345')).toMatchObject([{ field: 'postcode', optional: true }]);
    for (const [carrier, number] of [
      ['gls-ch', '993990103198'],
      ['gls-de', '123456789018'],
      ['heppner', '23456789'],
      ['mondial-relay', '12345678'],
    ] as const) {
      expect(activeRequirements(carrier, number).map((item) => item.optional), carrier).toEqual([undefined]);
    }
  });
});

describe('requirementSatisfied', () => {
  const postcode = { pattern: '^[0-9]{4}$' };

  it('accepts a blank value only when the input is optional', () => {
    expect(requirementSatisfied({ ...postcode, optional: true }, '')).toBe(true);
    expect(requirementSatisfied({ ...postcode, optional: true }, '  ')).toBe(true);
    expect(requirementSatisfied(postcode, '')).toBe(false);
  });

  it('checks a typed value against the pattern either way', () => {
    expect(requirementSatisfied({ ...postcode, optional: true }, '800')).toBe(false);
    expect(requirementSatisfied({ ...postcode, optional: true }, ' 8000 ')).toBe(true);
    expect(requirementSatisfied(postcode, '8000')).toBe(true);
    expect(requirementSatisfied({}, 'anything')).toBe(true);
  });

  it('keeps each requirement to its own pattern across calls', () => {
    const letters = { pattern: '^[A-Z]{2}$' };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(requirementSatisfied(postcode, '8000')).toBe(true);
      expect(requirementSatisfied(letters, '8000')).toBe(false);
      expect(requirementSatisfied(letters, 'AB')).toBe(true);
    }
  });
});

describe('tracking links', () => {
  it('compiles every carrier link rule once', () => {
    expect(TRACKING_LINK_RULES.length).toBeGreaterThan(0);
    expect(carrierLinkRules('swiss-post')[0]!.domains).toContain('service.post.ch');
    expect(carrierLinkRules('swiss-post')[0]!.path).toBeInstanceOf(RegExp);
  });

  it('reads a number with every path, query and fragment pattern', () => {
    // Without a capture group the pattern reads nothing and filters nothing: a
    // rule limited to some pages lists them in pathPattern.
    for (const rule of TRACKING_LINK_RULES) {
      for (const pattern of [rule.path, rule.query, rule.fragment]) {
        if (pattern) expect(new RegExp(`${pattern.source}|`).exec('')!.length, `${rule.carrier} ${pattern.source}`).toBeGreaterThan(1);
      }
    }
  });

  it('localizes only the portals that support it', () => {
    expect(localizedCarrierUrl('swiss-post', 'https://service.post.ch/x', 'fr')).toContain('lang=fr');
    // post.ch moves its search page to the language the parameter names.
    expect(localizedCarrierUrl('swiss-post', CARRIERS['swiss-post'].trackingSearchUrl!, 'fr'))
      .toBe('https://www.post.ch/de/empfangen/sendung-verfolgen?lang=fr');
    expect(localizedCarrierUrl('swiss-post', CARRIERS['swiss-post'].helpUrl!, 'it'))
      .toBe('https://www.post.ch/de/hilfe-und-kontakt/empfangen?lang=it');
    expect(localizedCarrierUrl('swiss-post', 'https://service.post.ch/x')).toBe('https://service.post.ch/x');
    expect(localizedCarrierUrl('dhl', 'https://www.dhl.com/x', 'fr')).toBe('https://www.dhl.com/x');
  });

  it('links a parcel to the source of its displayed result', () => {
    expect(parcelTrackingLinks({ carrier: 'swiss-post', trackingNumber: 'RA123456785CH' })).toEqual([{
      carrier: CARRIERS['swiss-post'],
      name: 'Swiss Post',
      url: 'https://service.post.ch/ekp-web/ui/entry/search/RA123456785CH',
      active: true,
      ready: true,
      role: 'active',
    }]);
  });
});

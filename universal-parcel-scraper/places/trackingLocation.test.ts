import { afterEach, describe, expect, it, vi } from 'vitest';
import { countryFlag, countryName, trackingLocationCountry, trackingPlace } from './trackingLocation.js';

describe('tracking places', () => {
  it.each([
    ['Zürich, Schweiz', 'CH', 'Zürich'], ['Bâle (Suisse)', 'CH', 'Bâle'], ['Milano, Italia', 'IT', 'Milano'],
    ['Paris; France', 'FR', 'Paris'], ['London, UK', 'GB', 'London'], ['ZUERICH, CH', 'CH', 'ZUERICH'],
    ['Zürich (Mülligen), CH', 'CH', 'Zürich (Mülligen)'], ['Hebron, KY, US, US', 'US', 'Hebron, KY'],
    ['Switzerland Haerkingen', 'CH', 'Haerkingen'], ['United Kingdom Coventry', 'GB', 'Coventry'],
    ['Shenzhen-Futian, China', 'CN', 'Shenzhen-Futian'],
    ['BENIN CITY - NIGERIA', 'NG', 'BENIN CITY'], ['AMSTERDAM - NETHERLANDS, THE', 'NL', 'AMSTERDAM'],
    ['HONG KONG - HONG KONG SAR, CHINA', 'HK', 'HONG KONG'], ['STERLING - Virginia - USA', 'US', 'STERLING - Virginia'],
    ['ATLANTA - GEORGIA - USA', 'US', 'ATLANTA - GEORGIA'],
  ])('takes the country off %s', (location, country, place) => {
    expect(trackingPlace(location)).toEqual({ country, place });
  });

  it('reads a code a state or canton shares as the country another field names', () => {
    expect(trackingPlace('HOLLAND, NL')).toEqual({ country: 'NL', place: 'HOLLAND' });
    expect(trackingPlace('Example Town, HOLLAND, NL')).toEqual({ country: 'NL', place: 'Example Town, HOLLAND' });
    expect(trackingPlace('Luxembourg, LU')).toEqual({ country: 'LU', place: 'Luxembourg' });
    expect(trackingPlace("St. John's, NL")).toEqual({ country: null, place: "St. John's, NL" });
  });

  it.each([
    ['France', 'FR'], ['DE', 'DE'], ['CH ', 'CH'], ['THE NETHERLANDS', 'NL'], ['Czech Republic', 'CZ'], ['Hong Kong', 'HK'],
    ['DHL Netherlands', 'NL'], ['КИТАЙ', 'CN'], ['Україна', 'UA'], ['日本', 'JP'], ['美國', 'US'],
    // Between empty fields, and a partner's depot abroad by its number.
    [',,,DE', 'DE'], ['FR,', 'FR'], ['SPAIN (12)', 'ES'],
  ])('leaves no place when %s is only a country', (location, country) => {
    expect(trackingPlace(location)).toEqual({ country, place: '' });
  });

  it.each([
    '', 'Warehouse', 'Paris', 'Buchs AG', 'Basel, BS', 'Wilmington, DE', 'France distribution center',
    'Zürich Briefzentrum', 'Mexico City', 'Andorra la Vella',
    'DHL Paris', 'DHL Netherlands distribution centre', 'JAMAICA NY INTERNATIONAL DISTRIBUTION CENTER', 'Panama City FL',
    'TBILISI - GEORGIA', 'CURITIBA - PR',
  ])('keeps %s whole without guessing a country', (location) => {
    expect(trackingPlace(location)).toEqual({ country: null, place: location });
  });

  it('reads a US military post office as no country', () => {
    // "AE" after APO, FPO or DPO is the Armed Forces Europe, not the United Arab Emirates.
    for (const location of ['Fpo, AE', 'APO, AE 09001', 'DPO AP', 'EXAMPLE BASE, APO AA 34001']) {
      expect(trackingPlace(location), location).toEqual({ country: null, place: location });
      expect(trackingLocationCountry(location), location).toBeNull();
    }
    expect(trackingPlace('Example City, AE')).toEqual({ country: 'AE', place: 'Example City' });
  });

  it('reads a localized country name a large town shares as the town', () => {
    for (const location of ['Granada', 'GRANADA', 'Franca', 'Salvador', 'Santa Helena', 'Włochy', 'Granada Centro']) {
      expect(trackingPlace(location), location).toEqual({ country: null, place: location });
    }
    expect(trackingLocationCountry('Andalucía, Granada')).toBeNull();
    // The English name still reads, and so does a country's name in its own language.
    expect(trackingPlace('Grenada')).toEqual({ country: 'GD', place: '' });
    expect(trackingPlace('Polska')).toEqual({ country: 'PL', place: '' });
  });

  it('keeps Passport evidence to a final field that names a region', () => {
    expect(trackingLocationCountry('Zürich, CH')).toBe('CH');
    expect(trackingLocationCountry('Switzerland Haerkingen')).toBeNull();
    expect(trackingLocationCountry('Czech Republic')).toBeNull();
  });

  afterEach(() => vi.restoreAllMocks());

  it('reads and names China where the runtime calls it “China mainland”, as Safari does', async () => {
    const of = Intl.DisplayNames.prototype.of;
    vi.spyOn(Intl.DisplayNames.prototype, 'of').mockImplementation(function (this: Intl.DisplayNames, code: string) {
      return code === 'CN' ? 'China mainland' : of.call(this, code);
    });
    vi.resetModules();
    const fresh = await import('./trackingLocation.js');
    expect(fresh.trackingPlace('Shenzhen, China')).toEqual({ country: 'CN', place: 'Shenzhen' });
    expect(fresh.trackingLocationCountry('Canton, Chine')).toBe('CN');
    expect(fresh.countryName('CN', 'en-GB')).toBe('China');
    expect(fresh.countryName('CN', 'fr')).toBe('Chine');
    expect(fresh.trackingPlace('КИТАЙ')).toEqual({ country: 'CN', place: '' });
  });

  it('names the country in the reader’s language', () => {
    expect(countryFlag('CH')).toBe('🇨🇭');
    expect(countryName('CZ', 'de')).toBe('Tschechien');
    expect(countryName('FI', 'fr')).toBe('Finlande');
    expect(countryName('HK', 'en')).toBe('Hong Kong');
  });
});

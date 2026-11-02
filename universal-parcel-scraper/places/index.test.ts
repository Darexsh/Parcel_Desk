import { describe, expect, it, vi } from 'vitest';
import { locatePlace, placesForEvents, placeTimeZone, restoreLostLetters } from './index.js';

vi.setConfig({ testTimeout: 30_000 });

const place = (location: string, countries?: string[]) => locatePlace(location, { countries });

function expectPlace(location: string, expected: { country: string; name: string; latitude: number; longitude: number }, countries?: string[]) {
  const found = place(location, countries);
  expect(found, location).toMatchObject({ precision: 'city', country: expected.country, name: expected.name });
  expect(found!.latitude, location).toBeCloseTo(expected.latitude, 1);
  expect(found!.longitude, location).toBeCloseTo(expected.longitude, 1);
}

describe('locatePlace', () => {
  it('places a country operation without inventing a city', () => {
    expect(place('DHL Netherlands')).toMatchObject({ country: 'NL', precision: 'country', name: 'Netherlands' });
    // Its name in words, where the code after it puts the parcel: DE is also Delaware.
    expect(place('DPD GERMANY DE')).toMatchObject({ country: 'DE', precision: 'country' });
    // Or as its "-ian" word, where the parcel may be.
    expect(place('Latvian sorting center', ['EE', 'LV'])).toMatchObject({ country: 'LV', precision: 'country' });
    expect(place('Latvian sorting center', ['EE'])).toBeNull();
    expect(place('DE0001', ['DE'])).toBeNull();
    // A code the text also names in words is that country, wherever the parcel was: NL is
    // also Newfoundland, and a Holland is in Michigan.
    expect(place('Example Town, HOLLAND, NL', ['US'])).toMatchObject({ country: 'NL', precision: 'country' });
    expect(place('Example Town, NORTH HOLLAND, NL', ['US'])).toMatchObject({ country: 'NL', precision: 'country' });
    expect(place('Luxembourg, LU', ['US'])).toMatchObject({ country: 'LU', precision: 'city', name: 'Luxembourg' });
    // Between empty fields, and a partner's depot abroad by its number.
    expect(place(',,,DE', ['DE'])).toMatchObject({ country: 'DE', precision: 'country' });
    expect(place('SPAIN (12)', ['IT'])).toMatchObject({ country: 'ES', precision: 'country' });
  });

  it('reads the formats carriers print, with or without a country', () => {
    const zurich = { country: 'CH', name: 'Zürich', latitude: 47.37, longitude: 8.55 };
    for (const location of ['ZUERICH, CH', 'ZUERICH CH', 'ZURICH']) expectPlace(location, zurich);
    // Mixed case is the carrier's own spelling, and the journal shows the same.
    expectPlace('Zurich, CH', { ...zurich, name: 'Zurich' });
    expectPlace('Switzerland Zurich', { ...zurich, name: 'Zurich' });
    expectPlace('Urdorf, CH', { country: 'CH', name: 'Urdorf', latitude: 47.39, longitude: 8.43 });
    // Small letters alone are no spelling either.
    expectPlace('zurich, ch', zurich);
    // A Chinese city with the word for city joined to it, unless a city has that name.
    expectPlace('shenzhenshi', { country: 'CN', name: 'Shenzhen', latitude: 22.55, longitude: 114.07 });
    expectPlace('huangshi', { country: 'CN', name: 'Huangshi', latitude: 30.25, longitude: 115.05 });
    expectPlace('KOELN, DE', { country: 'DE', name: 'Köln', latitude: 50.93, longitude: 6.95 });
    expectPlace('SEOUL, KR', { country: 'KR', name: 'Seoul', latitude: 37.57, longitude: 126.98 });
    expectPlace('Paris, Île-de-France, FR', { country: 'FR', name: 'Paris', latitude: 48.85, longitude: 2.35 });
    expectPlace('LONDON', { country: 'GB', name: 'London', latitude: 51.51, longitude: -0.13 });
    expectPlace('BARCELONA2', { country: 'ES', name: 'Barcelona', latitude: 41.39, longitude: 2.16 });
    // A depot's number after the country code.
    expectPlace('Vilvoorde - BE (depot 0001)', { country: 'BE', name: 'Vilvoorde', latitude: 50.93, longitude: 4.43 });
  });

  it('uses states and provinces to pick the right town of a shared name', () => {
    expectPlace('LAUREL, MD 20707', { country: 'US', name: 'Laurel', latitude: 39.1, longitude: -76.85 });
    expectPlace('WASHINGTON, DC 20212', { country: 'US', name: 'Washington', latitude: 38.9, longitude: -77.04 });
    expectPlace('Calgary, AB, CA', { country: 'CA', name: 'Calgary', latitude: 51.05, longitude: -114.09 });
    expectPlace('OTTAWA, ON', { country: 'CA', name: 'Ottawa', latitude: 45.41, longitude: -75.7 });
    expectPlace('Sausheim 68 (68)', { country: 'FR', name: 'Sausheim', latitude: 47.79, longitude: 7.37 });
    expectPlace('Buchs AG', { country: 'CH', name: 'Buchs', latitude: 47.39, longitude: 8.08 }, ['CH']);
    // A state the text gives holds: Earth City in Missouri, not Earth in Texas.
    expectPlace('Earth City, MO, United States', { country: 'US', name: 'Earth City', latitude: 38.77, longitude: -90.47 });
    expectPlace('Earth, TX', { country: 'US', name: 'Earth', latitude: 34.23, longitude: -102.41 });
    // On a parcel that may be in the US, a state names no town abroad, before a facility's words too.
    expect(place('HILLAH, NC', ['US'])).toBeNull();
    expect(place('METRO OH DISTRIBUTION CENTER', ['US'])).toBeNull();
    expect(place('TAMPA FL DISTRIBUTION CENTER', ['US'])).toMatchObject({ country: 'US', name: 'Tampa' });
    expect(place('Kingston, ON', ['US', 'CA'])).toMatchObject({ country: 'CA', name: 'Kingston' });
    expect(place('Paris, FR', ['CH'])).toMatchObject({ country: 'FR', name: 'Paris' });
  });

  it('tells a province or an office code from a country', () => {
    // Royal Mail ends its mail centres with MC and its delivery offices with DO: not Monaco, nor the Dominican Republic.
    expectPlace('Norwich MC', { country: 'GB', name: 'Norwich', latitude: 52.63, longitude: 1.3 });
    expectPlace('Coventry South DO', { country: 'GB', name: 'Coventry', latitude: 52.41, longitude: -1.51 });
    // A town of the code's country keeps it.
    expectPlace('MONTE CARLO MC', { country: 'MC', name: 'Monte-Carlo', latitude: 43.74, longitude: 7.43 });
    expectPlace('SANTO DOMINGO DO', { country: 'DO', name: 'Santo Domingo', latitude: 18.47, longitude: -69.89 });
    // Turin's province in brackets, not Tonga; the state of Bahia, not the Bahamas.
    expectPlace('PINEROLO (TO)', { country: 'IT', name: 'Pinerolo', latitude: 44.89, longitude: 7.33 });
    expectPlace('SALVADOR, BA', { country: 'BR', name: 'Salvador', latitude: -12.98, longitude: -38.49 });
    // Spain, unless the parcel is in Brazil, where ES is Espírito Santo.
    expect(place('VITORIA, ES')).toMatchObject({ precision: 'city', country: 'ES' });
    expect(place('VITORIA, ES', ['BR'])).toMatchObject({ precision: 'city', country: 'BR' });
    // A state the lookup has no code for, on a parcel in its country.
    expectPlace('MUMBAI, MH', { country: 'IN', name: 'Mumbai', latitude: 19.07, longitude: 72.88 }, ['IN']);
    // No town before the code, on a parcel known elsewhere: no country either.
    expect(place('Example Unit MC', ['GB'])).toBeNull();
    expect(place('UFFICIO POSTALE (TO)', ['IT'])).toBeNull();
    // A code that is also a state or canton, in brackets as after a comma: Delaware has no Bad Bevensen.
    expect(place('Bad Bevensen')).toBeNull();
    expect(place('Bad Bevensen (DE)')).toEqual(place('Bad Bevensen, DE'));
    expect(place('Bad Bevensen (DE)')).toMatchObject({ precision: 'city', country: 'DE', name: 'Bad Bevensen' });
    expect(place('Bad Bevensen (FR)')).toBeNull();
    // The parcel's own country is one.
    expect(place('MOKRONOS DOLNY (PL)', ['PL'])).toMatchObject({ precision: 'country', country: 'PL' });
    expect(place('Example Hub, CH', ['FR'])).toMatchObject({ precision: 'country', country: 'CH' });
  });

  it('reads DHL Express lines that end in a state or a country after a dash', () => {
    expectPlace('STERLING - Virginia - USA', { country: 'US', name: 'Sterling', latitude: 39.01, longitude: -77.43 });
    expectPlace('BENIN CITY - NIGERIA', { country: 'NG', name: 'Benin City', latitude: 6.34, longitude: 5.63 });
    expectPlace('LONDON - CANADA', { country: 'CA', name: 'London', latitude: 42.98, longitude: -81.23 });
    expectPlace('AMSTERDAM - NETHERLANDS, THE', { country: 'NL', name: 'Amsterdam', latitude: 52.37, longitude: 4.89 });
    expectPlace('HONG KONG - HONG KONG SAR, CHINA', { country: 'HK', name: 'Hong Kong', latitude: 22.28, longitude: 114.18 });
    // A Brazilian state, not Puerto Rico.
    expectPlace('CURITIBA - PR', { country: 'BR', name: 'Curitiba', latitude: -25.43, longitude: -49.27 });
    expectPlace('PANAMA CITY PA', { country: 'PA', name: 'Panama City', latitude: 8.99, longitude: -79.52 });
    // Queens, not the island, however USPS or Nova Poshta's US partner writes it; the name alone is the island.
    const queens = { country: 'US', name: 'Jamaica', latitude: 40.69, longitude: -73.81 };
    expectPlace('JAMAICA NY INTERNATIONAL DISTRIBUTION CENTER', queens);
    expectPlace('JAMAICA, NY', queens);
    expectPlace('JAMAICA, NEWYORK, US', queens);
    expect(place('JAMAICA', ['US'])).toMatchObject({ precision: 'country', country: 'JM' });
  });

  it('places the cities Toronto absorbed, which Canada Post still addresses', () => {
    const scarborough = { country: 'CA', name: 'Scarborough', latitude: 43.77, longitude: -79.25 };
    expectPlace('SCARBOROUGH - ONTARIO - CANADA', scarborough);
    expectPlace('SCARBOROUGH - ON - CANADA', scarborough);
    expectPlace('Scarborough, ON', scarborough);
    expectPlace('NORTH YORK - ONTARIO - CANADA', { country: 'CA', name: 'North York', latitude: 43.75, longitude: -79.44 });
    // Unconfirmed, the town in England is still the one meant.
    expectPlace('Scarborough', { country: 'GB', name: 'Scarborough', latitude: 54.28, longitude: -0.4 });
  });

  it('puts a scan at the airport or hub it names', () => {
    expect(place('Frankfurt Airport (FRA), Germany')).toMatchObject({ country: 'DE', name: 'Frankfurt', site: 'Frankfurt Main Airport', latitude: 50.027, longitude: 8.558 });
    expect(place('LONDON-HEATHROW - UK')).toMatchObject({ country: 'GB', name: 'London', site: 'London Heathrow Airport', latitude: 51.471, longitude: -0.46 });
    expect(place('HELSINKI-VANTAAN LENTOASEMA')).toMatchObject({ country: 'FI', name: 'Helsinki', site: 'Helsinki Vantaa Airport' });
    expect(place('LIEGE AIRPORT')).toMatchObject({ country: 'BE', name: 'Liège', site: 'Liège Airport' });
    // "Del" is "de el": the airport of El Prat.
    expect(place('EL AEROPUERTO DEL PRAT', ['ES'])).toMatchObject({ country: 'ES', site: 'Josep Tarradellas Barcelona-El Prat Airport' });
    // An airport of a city that has several, by the words of its own name.
    expect(place('Chicago O Hare Airport')).toMatchObject({ country: 'US', name: 'Chicago', site: "Chicago O'Hare International Airport", latitude: 41.979 });
    expect(place('Chicago Midway Airport')).toMatchObject({ country: 'US', site: 'Chicago Midway International Airport' });
    expect(place('Chicago Airport')?.site).toBeUndefined();
    // By those words alone, though Halle is also called Hare; not by a town's name another airport has.
    expect(place('O Hare Airport')).toMatchObject({ country: 'US', name: 'Chicago', site: "Chicago O'Hare International Airport" });
    expect(place('Boston Airport')).toMatchObject({ country: 'US', name: 'Boston', site: 'Boston Logan International Airport' });
    // Roissy is the airport, not Roissy-en-Brie on the other side of Paris.
    expect(place('ROISSY COURRIER INTERNATIONAL')).toMatchObject({ country: 'FR', name: 'Roissy-en-France', site: 'Charles de Gaulle International Airport' });
    expect(place('EAST MIDLANDS - UK')).toMatchObject({ country: 'GB', site: 'East Midlands Airport' });
    // A part that is an airport's own name, or names it with an airport word, before the airport
    // that serves the town: Narita lies beyond the 60 km a town's airports are looked for in.
    expect(place('LONDON - GATWICK - UK')).toMatchObject({ country: 'GB', name: 'London', site: 'London Gatwick Airport', latitude: 51.149 });
    expect(place('PARIS - CHARLES DE GAULLE - FRANCE')).toMatchObject({ country: 'FR', name: 'Paris', site: 'Charles de Gaulle International Airport' });
    expect(place('Narita Airport, Tokyo')).toMatchObject({ country: 'JP', name: 'Tokyo', site: 'Narita International Airport', latitude: 35.769 });
    expect(place('Tokyo Narita Airport')).toMatchObject({ site: 'Narita International Airport' });
    expect(place('Tokyo Airport')).toMatchObject({ site: 'Tokyo Haneda International Airport' });
    // Not by the city an airport serves ("Seoul Gimpo"), a district's name, or the town an airport is named after alone.
    expect(place('INCHEON NEAR SEOUL')).toMatchObject({ country: 'KR', name: 'Incheon', latitude: 37.456 });
    for (const location of ['INCHEON NEAR SEOUL', 'Baiyun, Guangzhou', 'Garliava, Kaunas', 'FRANKFURT MAIN']) expect(place(location)?.site, location).toBeUndefined();
    // A hub in a village the gazetteer does not list.
    for (const location of ['SEKOCIN STARY PL', 'SEKOCIN STARY, PL', 'Sekocin Stary, Poland']) {
      expect(place(location), location).toEqual({ precision: 'city', country: 'PL', name: location.startsWith('SEKOCIN') ? 'Sękocin Stary' : 'Sekocin Stary', latitude: 52.108, longitude: 20.88 });
    }
    // Cainiao's sorting centre in Fenggang, Dongguan, which GeoNames gives no population; not Fenggang in Jiangxi.
    expect(place('Fenggang Town')).toEqual({ precision: 'city', country: 'CN', name: 'Fenggang Town', latitude: 22.757, longitude: 114.149 });
    expect(place('FENGGANG TOWN', ['FR'])).toMatchObject({ country: 'CN', name: 'Fenggang', latitude: 22.757 });
    // Royal Mail's international hub by Heathrow, in a Langley the gazetteer does not list; not Langley in Canada.
    expect(place('LANGLEY HWDC')).toEqual({ precision: 'city', country: 'GB', name: 'Langley', latitude: 51.497, longitude: -0.532 });
    expect(place('LANGLEY', ['GB'])).toMatchObject({ country: 'GB', latitude: 51.497 });
    expect(place('LANGLEY BC')).toMatchObject({ country: 'CA', name: 'Langley' });
    expect(place('KINGS LANGLEY', ['GB'])).toMatchObject({ country: 'GB', name: 'Kings Langley', latitude: 51.714 });
    // Mondial Relay's agency in Terrasson-Lavilledieu, under the town's short name.
    expect(place('TERRASSON', ['FR'])).toEqual({ precision: 'city', country: 'FR', name: 'Terrasson-Lavilledieu', latitude: 45.129, longitude: 1.32 });
    expect(place('Agence de Terrasson')).toMatchObject({ country: 'FR', latitude: 45.129, longitude: 1.32 });
    // Royal Mail's mail centres named after an area, and Cainiao's warehouse in Shatian, Dongguan.
    expect(place('South Midlands MC')).toEqual({ precision: 'city', country: 'GB', name: 'Northampton', site: 'South Midlands Mail Centre', latitude: 52.216, longitude: -0.953 });
    expect(place('Princess Royal Parcel Hub')).toMatchObject({ country: 'GB', name: 'London', site: 'Princess Royal Distribution Centre', latitude: 51.541 });
    // Its parcel super hubs, by Warrington and Daventry.
    expect(place('North West Super Hub')).toEqual({ precision: 'city', country: 'GB', name: 'Warrington', site: 'North West Super Hub', latitude: 53.409, longitude: -2.666 });
    expect(place('MIDLANDS SUPER HUB')).toEqual({ precision: 'city', country: 'GB', name: 'Daventry', site: 'Midlands Super Hub', latitude: 52.371, longitude: -1.172 });
    expect(place('Shatian Town')).toEqual({ precision: 'city', country: 'CN', name: 'Shatian Town', latitude: 22.923, longitude: 113.613 });
    expect(place('Mayong Town', ['FR'])).toMatchObject({ country: 'CN', name: 'Mayong Town', latitude: 23.057 });
    // Shenzhen's port district, whose seat GeoNames gives no population; not the village of Fujian.
    expect(place('YANTIAN', ['NL'])).toMatchObject({ country: 'CN', name: 'Yantian', latitude: 22.56 });
    expect(place('YANTIAN, CN')).toMatchObject({ country: 'CN', latitude: 22.56 });
    // A longer name that contains a hub's is that place.
    expect(place('Terrasson-Lavilledieu', ['FR'])).toMatchObject({ country: 'FR', name: 'Terrasson-Lavilledieu' });
    expect(place('Terrasson-Lavilledieu', ['FR'])!.longitude).toBeCloseTo(1.3, 2);
    expect(place('BEAUREGARD DE TERRASSON', ['FR'])).toMatchObject({ country: 'FR', name: 'Beauregard-de-Terrasson' });
    expect(place('Beauregard-de-Terrasson')).toBeNull();
    expect(place('Roissy-en-Brie')).toMatchObject({ country: 'FR', name: 'Roissy-en-Brie' });
    // A country or a region in the text names no airport.
    for (const location of ['Cuernavaca, Mexico', 'HSINCHU - TAIWAN', 'Soyapango, San Salvador']) expect(place(location)?.site, location).toBeUndefined();
  });

  it("puts a station named by an airport's code and a number in that airport's town, where the parcel is", () => {
    expectPlace('BLQ 01', { country: 'IT', name: 'Bologna', latitude: 44.49, longitude: 11.34 }, ['IT']);
    expectPlace('NAP02', { country: 'IT', name: 'Napoli', latitude: 40.85, longitude: 14.27 }, ['AE', 'IT']);
    // The station is in the town, not at the airport.
    expect(place('BLQ 01', ['IT'])?.site).toBeUndefined();
    // A bare code, a code whose airport is abroad, and one no country backs place nothing.
    expect(place('BLQ', ['IT'])).toBeNull();
    expect(place('BLQ 01', ['FR'])).toBeNull();
    expect(place('BLQ 01')).toBeNull();
    // Three letters no airport has, or a station number too long for one.
    expect(place('QQX 03', ['IT'])).toBeNull();
    expect(place('BLQ 0123', ['IT'])).toBeNull();
    expect(placesForEvents(['Milan center', 'Milan center', 'BLQ 01', 'BLQ 01'], { destinationCountry: 'IT', carriers: ['imile'] })
      .map((found) => found?.name)).toEqual(['Milan', 'Milan', 'Bologna', 'Bologna']);
  });

  it('puts a code with an airport word, or with its country or state, at that airport', () => {
    expect(place('JFK Airport')).toMatchObject({ country: 'US', name: 'New York', site: 'John F. Kennedy International Airport' });
    expect(place('JFK International Airport')).toMatchObject({ country: 'US', site: 'John F. Kennedy International Airport' });
    expect(place('JFK Airport, NY')).toMatchObject({ country: 'US', site: 'John F. Kennedy International Airport' });
    expect(place('BNE, AU')).toMatchObject({ country: 'AU', name: 'Brisbane', site: 'Brisbane International Airport' });
    expect(place('BNE - AUSTRALIA')).toMatchObject({ country: 'AU', name: 'Brisbane', site: 'Brisbane International Airport' });
    // Whatever town elsewhere has the letters: San in Mali, Ord in Nebraska.
    expect(place('SAN Airport')).toMatchObject({ country: 'US', name: 'San Diego', site: 'San Diego International Airport' });
    expect(place('ORD, US')).toMatchObject({ country: 'US', name: 'Chicago', site: "Chicago O'Hare International Airport" });
    // A town of 100,000 people with the letters keeps them, unless the text says airport.
    expect(place('POA, BR')).toMatchObject({ country: 'BR', name: 'Poá' });
    expect(place('POA, BR')?.site).toBeUndefined();
    expect(place('POA Airport')).toMatchObject({ country: 'BR', name: 'Porto Alegre', site: 'Porto Alegre-Salgado Filho International Airport' });
    // A country or state the airport is not in names no airport.
    expect(place('JFK Airport, CA')?.site).toBeUndefined();
    expect(place('BNE, NZ')).toMatchObject({ precision: 'country', country: 'NZ' });
    // An operator in brackets says nothing against it.
    expect(place('MUC(DE-POST), DE')).toMatchObject({ country: 'DE', site: 'Munich Airport' });
  });

  it('puts a UPU office of exchange in the town of the airport or location its code names', () => {
    expectPlace('DEFRAA', { country: 'DE', name: 'Frankfurt am Main', latitude: 50.12, longitude: 8.68 });
    expectPlace('SCSEZA', { country: 'SC', name: 'Victoria', latitude: -4.62, longitude: 55.45 });
    expect(place('PLWAWA, PL')).toMatchObject({ precision: 'city', country: 'PL', name: 'Warsaw' });
    // bpost writes the country's name after the code.
    expect(place('BEBRUA Belgium BE, BE')).toMatchObject({ precision: 'city', country: 'BE', name: 'Zaventem' });
    expect(place('PTLISL Portugal PT, PT')).toMatchObject({ precision: 'city', country: 'PT', name: 'Lisbon' });
    expect(place('PTLISL Spain PT, PT')).toMatchObject({ precision: 'country', country: 'PT' });
    expect(place('DEFRAA')?.site).toBeUndefined();
    // A UN/LOCODE location no airport of the country has.
    expect(place('FRROIC, FR')).toMatchObject({ precision: 'city', country: 'FR', name: 'Roissy-en-France' });
    expect(place('DEROUA')).toMatchObject({ precision: 'city', country: 'DE', name: 'Rodgau' });
    expectPlace('GBLALA', { country: 'GB', name: 'Langley', latitude: 51.497, longitude: -0.532 });
    // An airport of another country, and towns of six letters.
    expect(place('GBJFKA')).toBeNull();
    expect(place('ARUSHA')).toMatchObject({ country: 'TZ', name: 'Arusha' });
    expect(place('TRNAVA')).toMatchObject({ country: 'SK', name: 'Trnava' });
    // A code of no known location, or of another country's airport, is its country where the parcel is.
    expect(place('COQQQA', ['CO'])).toMatchObject({ precision: 'country', country: 'CO' });
    expect(place('GBJFKA', ['GB'])).toMatchObject({ precision: 'country', country: 'GB' });
    expect(place('COQQQA', ['ES'])).toBeNull();
    // A town of those letters comes first, a small one too.
    expect(place('MADRID', ['MA'])).toMatchObject({ country: 'ES', name: 'Madrid' });
    expect(place('BEDALE', ['BE'])).toBeNull();
  });

  it("reads a country's three-letter code as that country where the parcel is", () => {
    expect(place('ITA', ['IT'])).toMatchObject({ precision: 'country', country: 'IT', name: 'Italy' });
    // Alone, the code is no town of those letters either: not Itá in Paraguay.
    expect(place('ITA')).toBeNull();
    expect(placesForEvents(['Milano', 'ITA', 'Roma'])[1]).toMatchObject({ precision: 'country', country: 'IT' });
  });

  it("puts a bare airport code at its airport where the parcel's way bears it out", () => {
    const at = (locations: string[], options?: Parameters<typeof placesForEvents>[1]) =>
      placesForEvents(locations, options).map((found) => found && `${found.site ?? found.name}, ${found.country}`);
    // A hub between the scans around it, or on the way to the destination.
    expect(at(['Shenzhen', 'HKG', 'AMS', 'Lisboa'])).toEqual([
      'Shenzhen, CN', 'Hong Kong International Airport, HK', 'Amsterdam Airport Schiphol, NL', 'Lisboa, PT',
    ]);
    expect(at(['Shenzhen', 'DOH', 'Paris'])[1]).toBe('Hamad International Airport, QA');
    expect(at(['Chicago', 'ORD', 'New York'])[1]).toBe("Chicago O'Hare International Airport, US");
    expect(at(['Shenzhen', 'HKG'], { destinationCountry: 'PT' })[1]).toBe('Hong Kong International Airport, HK');
    // In the parcel's country.
    expect(at(['ZRH'], { destinationCountry: 'CH' })).toEqual(['Zürich Airport, CH']);
    // Guangzhou's airport on a parcel from China, not Çan in Turkey.
    expect(at(['CAN'], { carriers: ['four-px'], destinationCountry: 'DZ' })).toEqual(['Guangzhou Baiyun International Airport, CN']);
    // Off the way, or with nothing around it, the code places nothing.
    expect(at(['Milano', 'SAT', 'Roma'])[1]).toBeNull();
    expect(at(['EZE'])).toEqual([null]);
    expect(at(['CDG'])).toEqual([null]);
    // A country's code where the parcel is, and a town of 100,000 people, keep their meaning.
    expect(at(['Toronto', 'CAN', 'Ottawa'], { destinationCountry: 'CA' })[1]).toBe('Canada, CA');
    expect(at(['São Paulo', 'POA'], { destinationCountry: 'BR' })[1]).toBe('Poá, BR');
  });

  it("knows a carrier's own hub by the name the carrier gives it", () => {
    // DPD's Swiss depot is in Buchs in the canton of Zurich; any other Buchs still has to say so.
    expect(locatePlace('Buchs, CH', { carriers: ['dpd'] })).toMatchObject({ country: 'CH', name: 'Buchs', latitude: 47.452, longitude: 8.43 });
    expect(locatePlace('Buchs SG', { carriers: ['dpd'] })).toMatchObject({ latitude: 47.167, longitude: 9.478 });
    // Without the carrier, the country alone names none of its three Buchs; the scans around one tell it.
    expect(place('Buchs, CH')).toBeNull();
    // DHL's parcel centre is in Staufenberg in Lower Saxony, not the town in Hesse.
    expect(locatePlace('Staufenberg', { countries: ['DE'], carriers: ['dhl-ecommerce'] })).toMatchObject({ country: 'DE', latitude: 51.372, longitude: 9.634 });
    expect(place('Staufenberg', ['DE'])).toMatchObject({ country: 'DE', latitude: 50.662, longitude: 8.732 });
    // Mondial Relay's Dutch network, named after its country: there on Mondial Relay's parcels, nowhere on others.
    expect(locatePlace('MR Pays Bas', { carriers: ['mondial-relay'] })).toEqual({ precision: 'country', country: 'NL', name: 'Netherlands', latitude: 52.42, longitude: 5.61 });
    expect(placesForEvents(['HUB LYON', 'MR Pays Bas'], { carriers: ['mondial-relay'] }).map((found) => found?.country)).toEqual(['FR', 'NL']);
    expect(locatePlace('MR Pays Bas', { carriers: ['dpd'] })).toBeNull();
  });

  it('reads Chinese, Japanese and Korean names', () => {
    const shenzhen = { country: 'CN', name: 'Shenzhen', latitude: 22.55, longitude: 114.07 };
    expectPlace('深圳市', shenzhen);
    expectPlace('广东省深圳市', shenzhen);
    expectPlace('Zhejiang Province Jinhua City', { country: 'CN', name: 'Jinhua', latitude: 29.11, longitude: 119.64 });
    expectPlace('東京都', { country: 'JP', name: 'Tokyo', latitude: 35.69, longitude: 139.69 });
    expectPlace('서울', { country: 'KR', name: 'Seoul', latitude: 37.57, longitude: 126.98 });
    // A name in Latin letters with the Chinese word for city.
    expectPlace('Changsha市 00000001', { country: 'CN', name: 'Changsha', latitude: 28.2, longitude: 112.97 });
  });

  it('reads a town of a country written in Cyrillic by its Cyrillic name', () => {
    expect(place('Тюмень', ['RU'])).toMatchObject({ country: 'RU', latitude: 57.152, longitude: 65.527 });
    expect(place('Київ')).toMatchObject({ country: 'UA', latitude: 50.455, longitude: 30.524 });
  });

  it('reads a town a carrier names after the city it serves as that town', () => {
    expect(place('TORINO MONCALIERI (999)', ['IT'])).toMatchObject({ country: 'IT', name: 'Moncalieri', latitude: 44.999 });
    expect(place('LYON CORBAS 2', ['FR'])).toMatchObject({ country: 'FR', name: 'Corbas' });
    expect(place('LONDON CROYDON')).toMatchObject({ country: 'GB', name: 'Croydon' });
    // Or before the city in brackets; a river in brackets is no city.
    expect(place('Kerpen (Köln), Germany')).toMatchObject({ country: 'DE', name: 'Kerpen' });
    expect(place('HITZACKER (ELBE), DE')).toMatchObject({ country: 'DE', name: 'Hitzacker' });
    // Farther off than a suburb too.
    expect(place('CLOPPENBURG (OLDENBURG), DE')).toMatchObject({ country: 'DE', name: 'Cloppenburg' });
    // Not a word that is no town there, a quarter a hyphen or a regional border joins to the city,
    // nor before an airport the text names.
    expect(place('TORINO NORD')).toMatchObject({ country: 'IT', name: 'Turin' });
    expect(place('Zürich-Mülligen', ['CH'])).toMatchObject({ country: 'CH', name: 'Zürich' });
    expect(place('ZUERICH MUELLIGEN', ['CH'])).toMatchObject({ country: 'CH', name: 'Zürich' });
    expect(place('PARIS ORLY')).toMatchObject({ country: 'FR', name: 'Paris', site: 'Paris-Orly Airport' });
  });

  it('reads a Chinese address down to the county-level city it names after its prefecture', () => {
    const yiwu = { country: 'CN', name: 'Yiwu', latitude: 29.31, longitude: 120.08 };
    expectPlace('浙江省金华市义乌市示例路', yiwu);
    expectPlace('金华市义乌市', yiwu);
    expectPlace('江苏省徐州市新沂市', { country: 'CN', name: 'Xinyi', latitude: 34.38, longitude: 118.35 });
    // A district stays with its city, and so does a county-level city of that name in another province.
    expectPlace('广东省深圳市宝安区', { country: 'CN', name: 'Shenzhen', latitude: 22.55, longitude: 114.07 });
    expectPlace('广东省茂名市新沂市', { country: 'CN', name: 'Maoming', latitude: 21.66, longitude: 110.92 });
    // A town of the city's, which GeoNames gives no population.
    const houjie = { country: 'CN', name: 'Houjie', latitude: 22.95, longitude: 113.66 };
    expectPlace('广东省东莞市厚街镇', houjie);
    expectPlace('厚街镇', houjie, ['CN']);
    expectPlace('Houjie Town', houjie, ['CN']);
    expect(place('Houjie Town')).toBeNull();
    // A district of that name is not the town.
    expect(place('Houjie District', ['CN'])).toBeNull();
  });

  it('knows municipalities and districts that no town of the gazetteer is named after', () => {
    expectPlace('Am Mellensee, DE', { country: 'DE', name: 'Am Mellensee', latitude: 52.15, longitude: 13.38 });
    expectPlace('ABIUL - PORTUGAL', { country: 'PT', name: 'Abiul', latitude: 39.87, longitude: -8.51 });
    expectPlace('AREMARK', { country: 'NO', name: 'Aremark', latitude: 59.22, longitude: 11.7 }, ['NO']);
    // A Mexican municipality at its seat when the two are named apart: El Marqués is La Cañada's,
    // Zapotlán el Grande Ciudad Guzmán's, not Zapotlán by Mexico City.
    expectPlace('EL MARQUES QRO MX', { country: 'MX', name: 'La Cañada', latitude: 20.61, longitude: -100.33 });
    expectPlace('Zapotlán el Grande, JAL, MX', { country: 'MX', name: 'Zapotlán el Grande', latitude: 19.7, longitude: -103.46 });
    // A Taiwanese district by its Chinese name, without the word for district.
    expectPlace('五股郵局', { country: 'TW', name: 'Wugu', latitude: 25.1, longitude: 121.43 }, ['TW']);
    // A US post office's town, though no town of 1,000 people: not Jaffa, once called Joppa.
    expectPlace('SPARROWS POINT, MD', { country: 'US', name: 'Sparrows Point', latitude: 39.23, longitude: -76.45 });
    expectPlace('JOPPA, MD', { country: 'US', name: 'Joppa', latitude: 39.42, longitude: -76.35 });
  });

  it('reads no town from a Chinese word for a facility', () => {
    for (const location of ['中心', '中心扫描', '新城', '示例园区中心']) expect(place(location), location).toBeNull();
    expectPlace('义乌转运中心', { country: 'CN', name: 'Yiwu', latitude: 29.31, longitude: 120.08 });
  });

  it("places a carrier's hub before a city of its name, on that carrier's parcels", () => {
    // SPX's sorting centre in Shiyan, Shenzhen, not the city of Shiyan in Hubei.
    expect(locatePlace('ShiYan', { carriers: ['spx-br'] })).toMatchObject({ country: 'CN', latitude: 22.686, longitude: 113.932 });
    expect(locatePlace('ShiYan')).toMatchObject({ country: 'CN', latitude: 32.648 });
    // Austrian Post's centre for Lower Austria is in Hagenbrunn; the region alone is no town.
    expect(locatePlace('Logistikzentrum Niederösterreich', { carriers: ['austrian-post'] })).toMatchObject({ country: 'AT', name: 'Hagenbrunn' });
    // China Post's international exchange offices by the initials of their Chinese names, on any parcel.
    expect(locatePlace('GZSGJHHJ')).toMatchObject({ country: 'CN', name: 'Guangzhou', site: 'Guangzhou International Exchange Office' });
    // Royal Mail's mail centres named after an area, not a town: Valley is on Anglesey, East London in South Africa.
    const royalMail = { carriers: ['royal-mail'], countries: ['GB'] };
    for (const [location, name, site] of [['Home Counties North MC', 'Hemel Hempstead', 'Home Counties North Mail Centre'],
      ['Mount Pleasant MC', 'London', 'London Central Mail Centre'], ['Northern Ireland MC', 'Newtownabbey', 'Northern Ireland Mail Centre'],
      ['Thames Valley MC', 'Swindon', 'Thames Valley Mail Centre']] as const) {
      expect(locatePlace(location, royalMail), location).toMatchObject({ country: 'GB', name, site });
    }
    expect(locatePlace('East London MC', royalMail)).toMatchObject({ country: 'GB', name: 'London' });
    // Whatever the carrier: those it hands parcels to write them its way.
    expect(locatePlace('Mount Pleasant MC', { countries: ['US'] })).toMatchObject({ country: 'GB', site: 'London Central Mail Centre' });
    expect(place('Thames Valley MC')).toMatchObject({ country: 'GB', name: 'Swindon', site: 'Thames Valley Mail Centre' });
    expect(place('Thames Valley MC', ['GB'])).toMatchObject({ country: 'GB', name: 'Swindon' });
    // MRW's platform in Meres, Asturias, a village too small for the gazetteer, not Meres in Turkey.
    expect(locatePlace('00099 Meres (Plataforma)', { carriers: ['mrw'], countries: ['ES'] })).toMatchObject({ country: 'ES', name: 'Meres', latitude: 43.376 });
    // InPost's sorting centres in villages, by Wrocław, Poznań and Siedlce, and Amazon's station in Bobes, Asturias.
    expect(locatePlace('MOKRONOS DOLNY (PL)', { carriers: ['inpost'], countries: ['PL'] })).toMatchObject({ country: 'PL', name: 'Mokronos Dolny', latitude: 51.071 });
    expect(locatePlace('SZYMANÓW (PL)', { carriers: ['inpost'], countries: ['PL'] })).toMatchObject({ country: 'PL', name: 'Szymanów', latitude: 50.999 });
    // By Szczecin, Gliwice and Piotrków Trybunalski; InPost's ŁAZY is its centre by Warsaw, not the town of Łazy in Silesia,
    // and its WOLA BYKOWSKA is not Warsaw's Wola district.
    expect(locatePlace('ŁOZIENICA (PL)', { carriers: ['inpost'], countries: ['PL'] })).toMatchObject({ country: 'PL', name: 'Łozienica', latitude: 53.539 });
    expect(locatePlace('SZAŁSZA (PL)', { carriers: ['inpost'], countries: ['PL'] })).toMatchObject({ country: 'PL', name: 'Szałsza', latitude: 50.337 });
    expect(locatePlace('WOLA BYKOWSKA (PL)', { carriers: ['inpost'], countries: ['PL'] })).toMatchObject({ country: 'PL', name: 'Wola Bykowska', latitude: 51.458 });
    expect(locatePlace('ŁAZY (PL)', { carriers: ['inpost'], countries: ['PL'] })).toMatchObject({ country: 'PL', name: 'Łazy', latitude: 52.082 });
    expect(locatePlace('Łazy', { countries: ['PL'] })).toMatchObject({ country: 'PL', name: 'Łazy', latitude: 50.428 });
    expect(locatePlace('Bobes, Asturias, ES', { carriers: ['amazon-shipping'], countries: ['ES'] })).toMatchObject({ country: 'ES', name: 'Bobes', latitude: 43.396 });
  });

  it('takes a longer place name for the place it names, not for a town that shares a word of it', () => {
    expect(place('Cartagena de Indias')).toMatchObject({ country: 'CO', latitude: 10.398 });
    expect(place('Santiago de Compostela')).toMatchObject({ country: 'ES' });
    // A country code the text writes settles which: Atena is a name of Athens.
    expect(place('Atena Lucana - IT (depot 0001)')).toMatchObject({ country: 'IT', name: 'Atena Lucana' });
    // A town named after its country is named after itself: Asunción, not Paraguay.
    expect(place('Asuncion del Paraguay')).toMatchObject({ precision: 'city', country: 'PY', name: 'Asuncion' });
    // Nor is a town nothing confirms the end of a longer name a place has elsewhere: Mill Hill is no Hill,
    // and only a city's other names are known enough alone. Trenton was once Mill Hill.
    expect(place('Mill Hill Example Office', ['GB'])).toBeNull();
    expect(place('Mill Hill Example Office')).toBeNull();
    expect(place('Mill Hill, NJ')).toMatchObject({ country: 'US', name: 'Mill Hill' });
    // A town near the longer name may still be the one meant.
    expect(place('NEW DELHI IN', ['IT'])).toMatchObject({ country: 'IN' });
  });

  it('takes no town from what a linking word ties a name to', () => {
    expect(place('Bernau bei Berlin', ['DE'])).toMatchObject({ country: 'DE', name: 'Bernau bei Berlin' });
    expect(place('Chazelles-sur-Lyon', ['FR'])).toMatchObject({ country: 'FR', name: 'Chazelles-sur-Lyon' });
    // With nothing to confirm the smaller town, the name places none.
    expect(place('Chazelles-sur-Lyon')).toBeNull();
    // A name the town goes by on its own is still that town.
    expect(place('Kingston upon Hull')).toMatchObject({ country: 'GB', name: 'Kingston upon Hull' });
    expect(place('Freiburg im Breisgau', ['DE'])).toMatchObject({ country: 'DE', name: 'Freiburg' });
  });

  it('reads a linking word abbreviated to a letter and a full stop', () => {
    expectPlace('Frankfurt a.d. Oder', { country: 'DE', name: 'Frankfurt a.d. Oder', latitude: 52.35, longitude: 14.55 }, ['DE']);
    expectPlace('Weil a. Rhein', { country: 'DE', name: 'Weil a. Rhein', latitude: 47.59, longitude: 7.62 }, ['DE']);
    expectPlace('Landsberg a. Lech', { country: 'DE', name: 'Landsberg a. Lech', latitude: 48.05, longitude: 10.88 }, ['DE']);
    expectPlace('Neustadt a. d. Weinstraße', { country: 'DE', name: 'Neustadt a. d. Weinstraße', latitude: 49.35, longitude: 8.14 }, ['DE']);
    // An initialism's letters link nothing.
    expect(place('C.O. RIO DE MOURO', ['PT'])).toMatchObject({ country: 'PT', name: 'Rio de Mouro' });
    expectPlace('Bernau b. Berlin', { country: 'DE', name: 'Bernau b. Berlin', latitude: 52.68, longitude: 13.59 }, ['DE']);
    expectPlace('Ústí n. Labem', { country: 'CZ', name: 'Ústí n. Labem', latitude: 50.66, longitude: 14.03 }, ['CZ']);
    // What follows it is no town on its own either, and a name GeoNames prints abbreviated is still found.
    expect(place('Example b. Berlin', ['DE'])).toBeNull();
    expect(place('Neumarkt i.d. OPf.', ['DE'])).toMatchObject({ country: 'DE', name: 'Neumarkt i.d. OPf' });
    // A first letter is no linking word.
    expect(place('A. Coruña', ['ES'])).toMatchObject({ country: 'ES' });
  });

  it('finds a town between other words of a name, when it is a city where the parcel is', () => {
    expect(place('Example Reading Station Lockers', ['GB'])).toMatchObject({ country: 'GB', name: 'Reading' });
    expect(place('Punkt Pocztowy Example Lublin L999', ['PL'])).toMatchObject({ country: 'PL', name: 'Lublin' });
    // Not a city abroad, nor a village where the parcel is.
    expect(place('Queen Elizabeth Example Park Lockers', ['GB'])).toBeNull();
    expect(place('Example Wells Station Lockers', ['GB'])).toBeNull();
  });

  it('reads Saint and Sainte where a carrier shortens them', () => {
    expect(place('ST QUENTIN FALLAVIER', ['FR'])).toMatchObject({ country: 'FR', name: 'Saint-Quentin-Fallavier' });
    expect(place('STE GENEVIEVE DES BOIS', ['FR'])).toMatchObject({ country: 'FR', name: 'Sainte-Geneviève-des-Bois' });
    // A name GeoNames gives shortened keeps it.
    expect(place('St Albans', ['GB'])).toMatchObject({ country: 'GB', name: 'St Albans' });
  });

  it('reads a saint\'s title that more words follow as the start of a longer name, not as a town of its own', () => {
    // San in Mali, on a Spanish depot written "San Fernando de Henares" in short.
    expect(place('SAN FDO. DE H.', ['ES'])).toBeNull();
    expect(place('SAN', ['ML'])).toMatchObject({ country: 'ML', name: 'San' });
    expect(place('SAO PAULO')).toMatchObject({ country: 'BR' });
    expect(place('Sankt Gallen')).toMatchObject({ country: 'CH' });
  });

  it('takes a region for its country, not for a town that shares a word of its name', () => {
    expect(place('Guangdong Province')).toMatchObject({ precision: 'country', country: 'CN' });
    expect(place('Cabo Delgado Province')).toMatchObject({ precision: 'country', country: 'MZ' });
    expect(place('Morona-Santiago Province')).toMatchObject({ precision: 'country', country: 'EC' });
    expect(place('Santa Catarina', ['BR'])).toMatchObject({ precision: 'country', country: 'BR' });
    // By its local name too, as its country's GeoNames dump gives it.
    expect(place('Catalunya', ['FR'])).toMatchObject({ precision: 'country', country: 'ES' });
    expect(place('Lombardia')).toMatchObject({ precision: 'country', country: 'IT' });
    // By its old name too, in whichever country the parcel is.
    expect(place('Distrito Federal', ['MX'])).toMatchObject({ precision: 'country', country: 'MX' });
    expect(place('Distrito Federal', ['BR'])).toMatchObject({ precision: 'country', country: 'BR' });
    expect(place('Distrito Federal')).toBeNull();
    // A region named by points of the compass alone, only where the parcel is.
    expect(place('South West Parcel Hub', ['GB'])).toBeNull();
    expect(place('Far North Depot', ['AU'])).toBeNull();
    expect(place('North West', ['ZA'])).toMatchObject({ precision: 'country', country: 'ZA' });
    // Nor for a small town of its country outside it: no Wales in Yorkshire, and no Monaco either.
    expect(locatePlace('Mid Wales MC', { carriers: ['royal-mail'], countries: ['GB'] })).toMatchObject({ precision: 'country', country: 'GB' });
    expect(place('North Wales MC')).toMatchObject({ precision: 'country', country: 'GB' });
    // A town named like the region it lies in is still that town.
    expect(place('Example, Moscow')).toMatchObject({ precision: 'city', country: 'RU', name: 'Moscow' });
    expectPlace('Frankfurt (Oder)', { country: 'DE', name: 'Frankfurt (Oder)', latitude: 52.35, longitude: 14.55 });
    // Or whose name joins what the brackets hold, however small and whatever else either part names.
    expectPlace('NEUSTADT (HOLSTEIN), DE', { country: 'DE', name: 'Neustadt in Holstein', latitude: 54.11, longitude: 10.82 });
    expectPlace('NEUSTADT (WEINSTRASSE), DE', { country: 'DE', name: 'Neustadt an der Weinstraße', latitude: 49.35, longitude: 8.14 });
    expectPlace('Essen (Oldenburg), DE', { country: 'DE', name: 'Essen (Oldenburg)', latitude: 52.7, longitude: 7.92 });
    expectPlace('Freiburg (Elbe), DE', { country: 'DE', name: 'Freiburg (Elbe)', latitude: 53.83, longitude: 9.29 });
  });

  it('looks past facility words to the town', () => {
    expectPlace('Agence DPD de La Crau (283)', { country: 'FR', name: 'La Crau', latitude: 43.15, longitude: 6.07 });
    expectPlace('AGENCE PARIS', { country: 'FR', name: 'Paris', latitude: 48.85, longitude: 2.35 });
    expectPlace('Zürich-Mülligen', { country: 'CH', name: 'Zürich', latitude: 47.37, longitude: 8.55 });
    expect(place('Centre de tri DPD de Le Coudray (175)', ['FR'])).toMatchObject({ country: 'FR', name: 'Le Coudray' });
    expect(place('TrondheimSorter', ['NO'])).toMatchObject({ country: 'NO', name: 'Trondheim' });
  });

  it('puts Swiss Post sorting centres on their own site', () => {
    const mulligen = { precision: 'city', country: 'CH', name: 'Zürich', site: 'Zürich-Mülligen', latitude: 47.3959, longitude: 8.4695 };
    expect(place('Zürich Briefzentrum 801050')).toEqual(mulligen);
    expect(place('Zürich Briefzentrum International 801053')).toEqual(mulligen);
    expect(place('Daillens Centre Colis 131000')).toEqual({ precision: 'city', country: 'CH', name: 'Daillens', latitude: 46.6327, longitude: 6.541 });
    // A site the table does not know stays on its town.
    expectPlace('Zürich 15 Zustellung 801500', { country: 'CH', name: 'Zürich', latitude: 47.37, longitude: 8.55 }, ['CH']);
    // The number alone is not enough: the name has to start with the site's town.
    expect(place('Basel 801050', ['CH'])).toMatchObject({ name: 'Basel' });
  });

  it('places India Post offices by their PIN code when their name is no town', () => {
    expectPlace('Example TMO 800001', { country: 'IN', name: 'Patna', latitude: 25.59, longitude: 85.14 }, ['IN']);
    // India among the parcel's countries is enough.
    expectPlace('Office - 12345678 700001', { country: 'IN', name: 'Kolkata', latitude: 22.56, longitude: 88.36 }, ['FR', 'IN']);
    expect(place('Example TMO 800001')).toBeNull();
    expect(place('Example TMO 800001', ['CH'])).toBeNull();
    // A foreign airport's code is an office of exchange abroad; 9 starts the Army Postal Service's PINs.
    for (const location of ['Office - FRA 400001', 'Office - DEFRA 400001', 'Example TMO 900056']) expect(place(location, ['IN']), location).toBeNull();
    // A town nothing confirms keeps its six digits: here a Swiss Post site.
    expect(place('Daillens Distribution 131070', ['FR', 'IN'])).toBeNull();
  });

  it("places a USPS scan at a ZIP Code in the town most of the code's area is", () => {
    expect(place('ZIP Code 60600')).toMatchObject({ precision: 'city', country: 'US', name: 'Chicago' });
    expect(place('ZIP Code 10099-1234')).toMatchObject({ precision: 'city', country: 'US', name: 'New York' });
    // The code twice, on a parcel that may be in the US.
    expect(place('60600,60600', ['US'])).toMatchObject({ precision: 'city', country: 'US', name: 'Chicago' });
    for (const location of ['60600,60600', '60600,60601']) expect(place(location), location).toBeNull();
    // An area shared by many towns, or a military one, is none of them.
    for (const location of ['ZIP Code 90200', 'ZIP Code 09000', 'ZIP Code 1234']) expect(place(location), location).toBeNull();
  });

  it('finds small Swiss towns and postcodes when the parcel is in Switzerland', () => {
    expectPlace('Härkingen 4622', { country: 'CH', name: 'Härkingen', latitude: 47.3, longitude: 7.82 }, ['CH', 'LI']);
    expectPlace('Dintikon', { country: 'CH', name: 'Dintikon', latitude: 47.36, longitude: 8.22 }, ['CH']);
    expectPlace('Buchs SG 9470', { country: 'CH', name: 'Buchs', latitude: 47.16, longitude: 9.47 }, ['CH']);
    // Unconfirmed, a hamlet's name is not enough.
    expect(place('Dintikon')).toBeNull();
  });

  it('puts a hub named after a city that shares a country name in that city, on a parcel in its country', () => {
    expectPlace('BENIN HUB', { country: 'NG', name: 'Benin City', latitude: 6.34, longitude: 5.63 }, ['NG']);
    expect(placesForEvents(['LAGOS HUB', 'BENIN HUB'], { carriers: ['gig-logistics'] })[1]).toMatchObject({ precision: 'city', country: 'NG', name: 'Benin City' });
    expect(place('BENIN HUB')).toMatchObject({ precision: 'country', country: 'BJ' });
    expect(place('BENIN HUB', ['NG', 'BJ'])).toMatchObject({ precision: 'country', country: 'BJ' });
    expect(place('GERMANY HUB', ['NG'])).toMatchObject({ precision: 'country', country: 'DE' });
    expect(place('MEXICO HUB', ['US'])).toMatchObject({ precision: 'country', country: 'MX' });
  });

  it('prefers the country the parcel is in for names several countries share', () => {
    expect(place('Emmen')?.country).toBe('NL');
    expect(place('Emmen', ['CH'])?.country).toBe('CH');
    expect(place('Bienne', ['CH'])).toMatchObject({ country: 'CH' });
    expect(place('Cologne')).toMatchObject({ country: 'DE', name: 'Cologne' });
    expect(place('Genf')).toMatchObject({ country: 'CH', name: 'Genf' });
  });

  it('falls back to the country when only the country is known', () => {
    expect(place('Germany')).toMatchObject({ precision: 'country', country: 'DE', name: 'Germany' });
    expect(place('CH')).toMatchObject({ precision: 'country', country: 'CH' });
    expect(place('Example Hub, China')).toMatchObject({ precision: 'country', country: 'CN' });
    expect(place('Australia')).toMatchObject({ precision: 'country', country: 'AU', name: 'Australia', latitude: -24.13 });
  });

  it('declines text that names no place it can trust', () => {
    for (const location of [
      '', '   ', 'CENTRE DE TRI', 'Return location', 'Livré au destinataire', 'Example City', 'Home', 'Post branch',
      'Your neighbourhood', '示例市', 'FR0012', 'Maker SO 841215', 'EXAMPLE AIR HUB', 'Hub', 'CDG', 'GOFO-PR',
      // A US military post office, anywhere in its region.
      'Fpo, AE', 'APO AE', 'FPO, AP 96001',
    ]) expect(place(location), location).toBeNull();
    expect(place('Warehouse 2024', ['CH'])).toBeNull();
    expect(locatePlace(undefined)).toBeNull();
  });

  it("reads no town from a direction, which only halves a district's name", () => {
    for (const location of ['SUD', 'EXAMPLE NORD (001)', 'CHR-FR SUD (000)']) expect(place(location), location).toBeNull();
    expect(place('Neustadt/Süd')).toMatchObject({ country: 'DE', name: 'Neustadt/Süd' });
    expect(place('Biel/Bienne')).toMatchObject({ country: 'CH', name: 'Biel/Bienne' });
  });

  it('reads no town from a three-letter alternate name, a code more often than a name', () => {
    // GeoNames gives Lognes "Lon" and Jizhou "Chi": a British office of exchange is no French town.
    for (const location of ['LON E ET BEA', 'CHI', 'BIN']) expect(place(location), location).toBeNull();
    expect(placesForEvents(['LONDON BPI, United Kingdom', 'LON E ET BEA'])[1]).toBeNull();
    // A town's own three-letter name still places it.
    expect(place('ATH')).toMatchObject({ country: 'BE', name: 'Ath' });
  });

  it("reads no town from GeoNames' transliteration of a name in another script", () => {
    // "noman" is Norman in Japanese, "yuan" Ichihara's last character read in Chinese.
    expect(place('Noman Example Store', ['GB'])).toBeNull();
    expect(place('TA YUAN DISTRICT TW')).toMatchObject({ country: 'TW', name: 'Dayuan' });
    // Chinese carriers spell their own towns so.
    expect(place('SHEN ZHEN', ['CN'])).toMatchObject({ country: 'CN', name: 'Shenzhen' });
    // "Membris" is Mömbris in Russian.
    expect(place('Membris')).toBeNull();
  });

  it('reads translations in the languages carriers print', () => {
    expect(place('FRANCOFORTE')).toMatchObject({ country: 'DE', name: 'Frankfurt am Main' });
    expect(place('Londres')).toMatchObject({ country: 'GB' });
    expect(place('HCM CITY')).toMatchObject({ country: 'VN', name: 'Ho Chi Minh City' });
    // "Pastas" is Pasto in Lithuanian, and paštas the Lithuanian for post.
    expect(place('Pavyzdžio paštas')).toBeNull();
  });

  it('reads a Spanish town without its article and a Greek one spelt as Greek carriers do', () => {
    expect(place('BORGES DEL CAMP', ['ES'])).toMatchObject({ country: 'ES', name: 'les Borges del Camp' });
    expect(place('00669 Garriga,La', ['ES'])).toMatchObject({ country: 'ES', latitude: 41.683 });
    expect(place('VRACHATI', ['GR'])).toMatchObject({ country: 'GR', name: 'Vrakháti' });
  });
});

describe('placesForEvents', () => {
  it('lets a scan borrow the country of the scans around it', () => {
    const [zurich, buchs, empty] = placesForEvents(['ZUERICH, CH', 'Buchs', '  ']);
    expect(zurich?.country).toBe('CH');
    expect(buchs).toMatchObject({ country: 'CH', name: 'Buchs' });
    expect(empty).toBeNull();
    expect(placesForEvents(['Kyoto', 'Emmen', 'Leipzig'])[1]?.country).toBe('NL');
    expect(placesForEvents(['Bern', 'Emmen'])[1]?.country).toBe('CH');
  });

  it('reads a state named alone in the country the parcel is in, before what else its letters name', () => {
    const states = placesForEvents(['NSW', 'SA', 'VIC', 'TAS', 'WA', 'QLD', 'NT', 'ACT'], { destinationCountry: 'AU', carriers: ['couriersplease'] });
    expect(states.map((found) => found && [found.country, found.precision, found.region])).toEqual(
      ['NSW', 'SA', 'VIC', 'TAS', 'WA', 'QLD', 'NT', 'ACT'].map((code) => ['AU', 'country', code]));
    expect(locatePlace('VIC, AU')).toMatchObject({ country: 'AU', region: 'VIC' });
    expect(locatePlace('SA AUSTRALIA')).toMatchObject({ country: 'AU', region: 'SA', precision: 'country' });
    expect(locatePlace('ON CANADA')).toMatchObject({ country: 'CA', region: 'ON' });
    expect(locatePlace('NEW MEXICO')?.country).not.toBe('MX');
    expect(locatePlace('NT', { countries: ['CA', 'AU'] })).toMatchObject({ country: 'CA', region: 'NT' });
    // Without the country, the letters keep what they name; on a parcel through Saudi Arabia, so does "SA".
    expect(locatePlace('VIC')).toMatchObject({ country: 'ES', name: 'Vic' });
    expect(locatePlace('SA', { countries: ['AU', 'SA'] })).toMatchObject({ country: 'SA', precision: 'country' });
    expect(locatePlace('SA', { countries: ['FR'] })?.country).toBe('SA');
  });

  it('moves every scan with the same text to a point the carrier gave for one of them', () => {
    const gpo = { latitude: 25.6036, longitude: 85.1326 };
    const places = placesForEvents(['Patna GPO 800001', 'Patna GPO 800001', 'Patna NSH 800001'], { carrierCountries: ['IN'], points: [null, gpo, null] });
    expect(places.map((found) => found && [found.latitude, found.longitude])).toEqual([[25.6036, 85.1326], [25.6036, 85.1326], [25.594, 85.136]]);
    // A point far from the town its scan names is not used.
    expect(placesForEvents(['Patna GPO 800001'], { carrierCountries: ['IN'], points: [{ latitude: 28.6448, longitude: 77.2167 }] })[0])
      .toMatchObject({ latitude: 25.594, longitude: 85.136 });
  });

  it('places the logistics sites Mondial Relay names, as the app asks for a French carrier', () => {
    const sites = ['METZ', 'HUB de Troyes', 'REIMS', 'BORDEAUX', 'TERRASSON', 'BRIVE', 'NIORT', 'REAU'];
    const places = placesForEvents(sites, { carrierCountries: ['FR'] });
    expect(places.map((found) => found && `${found.name}, ${found.country}`)).toEqual([
      'Metz, FR', 'Troyes, FR', 'Reims, FR', 'Bordeaux, FR', 'Terrasson-Lavilledieu, FR', 'Brive-la-Gaillarde, FR', 'Niort, FR', 'Réau, FR',
    ]);
    // Réau in Seine-et-Marne, by Melun.
    expect(places[7]!.latitude).toBeCloseTo(48.61, 1);
    expect(places[7]!.longitude).toBeCloseTo(2.62, 1);
  });

  it('places the towns Cainiao writes in brackets', () => {
    const places = placesForEvents(['Fenggang Town', 'Xiaoshan District', 'Mitry-Mory', 'Bordeaux', 'Saint-médard-en-jalles']);
    expect(places.map((found) => found && `${found.name}, ${found.country}`)).toEqual([
      'Fenggang Town, CN', 'Xiaoshan, CN', 'Mitry-Mory, FR', 'Bordeaux, FR', 'Saint-médard-en-jalles, FR',
    ]);
    expect(places[0]).toMatchObject({ latitude: 22.757, longitude: 114.149 });
  });

  it('uses the destination and the carrier before guessing', () => {
    expect(placesForEvents(['Dintikon'], { carrierCountries: ['CH', 'LI'] })[0]?.name).toBe('Dintikon');
    expect(placesForEvents(['Emmen'], { destinationCountry: 'CH' })[0]?.country).toBe('CH');
    expect(placesForEvents(['Dintikon'])[0]).toBeNull();
  });

  const route = (locations: string[], options?: Parameters<typeof placesForEvents>[1]) =>
    placesForEvents(locations, options).map((found) => found && `${found.name}, ${found.country}`);

  it("takes a carrier's countries and hubs from the catalog", () => {
    expect(route(['Dintikon'], { carriers: ['swiss-post'] })).toEqual(['Dintikon, CH']);
    // Royal Mail is British, whatever clock its scans keep: Langley by Heathrow, not Langley in Canada.
    expect(route(['Norwich MC', 'LANGLEY', 'Roissy'], { carriers: ['royal-mail'] })).toEqual(['Norwich, GB', 'Langley, GB', 'Roissy, FR']);
    expect(placesForEvents(['Rothenburg, CH', 'Buchs, CH'], { carriers: ['dpd'] })[1]).toMatchObject({ latitude: 47.452, longitude: 8.43 });
    // A carrier the catalog does not know adds nothing.
    expect(route(['Dintikon'], { carriers: ['example-carrier'] })).toEqual([null]);
  });

  it('gives a namesake far off the way of the parcel no place', () => {
    const royalMail = { carriers: ['royal-mail'] };
    // The mail centre for Cornwall is not in Cornwall, Ontario, and the next scan is not in Nova Scotia after it.
    expect(route(['Plymouth MC', 'Cornwall MC', 'Truro DO'], royalMail)).toEqual(['Plymouth, GB', null, 'Truro, GB']);
    expect(route(['FR', 'Cornwall', 'GB'])).toEqual(['France, FR', null, 'United Kingdom, GB']);
    // Where the scans stop there is no way to be off, only a distance: a name several towns share is not enough.
    expect(route(['Plymouth MC', 'Cornwall MC'], royalMail)).toEqual(['Plymouth, GB', null]);
    expect(route(['Mount Vernon MC'], royalMail)).toEqual([null]);
    // Its own text, the destination or a scan nearby keeps the town.
    expect(route(['Plymouth MC', 'Cornwall, ON'], royalMail)).toEqual(['Plymouth, GB', 'Cornwall, CA']);
    expect(route(['Plymouth MC', 'Cornwall'], { ...royalMail, destinationCountry: 'CA' })).toEqual(['Plymouth, GB', 'Cornwall, CA']);
    expect(route(['Heathrow', 'Mississauga', 'Cornwall'], royalMail)).toEqual(['Heathrow, GB', 'Mississauga, CA', 'Cornwall, CA']);
    // So does a name no other town has, or a world city's.
    expect(route(['Xiaoshan District'], { carriers: ['ecoscooting'] })).toEqual(['Xiaoshan, CN']);
    expect(route(['Heathrow', 'Chicago'], royalMail)).toEqual(['Heathrow, GB', 'Chicago, US']);
    // A hub on the way is no detour, and a parcel nothing is known about keeps what its scans say.
    expect(route(['Shenzhen', 'Liège', 'Paris'], { carriers: ['la-poste'] })).toEqual(['Shenzhen, CN', 'Liège, BE', 'Paris, FR']);
    expect(route(['Mount Pleasant'])).toEqual(['Mount Pleasant, US']);
  });

  it('tells towns of one name in one country apart by the scans around them', () => {
    const royalMail = { carriers: ['royal-mail'] };
    const kennington = (locations: string[]) => placesForEvents(locations, royalMail)[locations.indexOf('Kennington DO')];
    // In London between London's scans, in Kent by Ashford.
    expect(kennington(['Croydon MC', 'Kennington DO', 'Mount Pleasant MC'])).toMatchObject({ country: 'GB', name: 'Kennington', latitude: 51.488 });
    expect(kennington(['Ashford DO', 'Kennington DO'])).toMatchObject({ country: 'GB', name: 'Kennington', latitude: 51.167 });
    // With nothing around to tell, neither.
    expect(kennington(['Kennington DO'])).toBeNull();
    expect(locatePlace('Kennington DO', { ...royalMail, countries: ['GB'] })).toBeNull();
  });

  it('keeps a world city in its own country when a namesake would take it off the way', () => {
    // A Ukrainian parcel flown to the United States leaves from Warsaw and Paris, not from their American namesakes.
    for (const options of [{ destinationCountry: 'US', carriers: ['gofo', 'nova-poshta'] }, { carriers: ['nova-poshta'] }]) {
      expect(route(['Lviv', 'Warsaw', 'New York'], options)).toEqual(['Lviv, UA', 'Warsaw, PL', 'New York, US']);
      expect(route(['Lviv', 'Warsaw', 'Warsaw', 'New York'], options)).toEqual(['Lviv, UA', 'Warsaw, PL', 'Warsaw, PL', 'New York, US']);
      expect(route(['Lviv', 'Paris', 'New York'], options)).toEqual(['Lviv, UA', 'Paris, FR', 'New York, US']);
    }
    // A namesake on the way stays, and so does a town the parcel's country holds that no larger one outweighs.
    expect(route(['Dallas, TX', 'Paris', 'Memphis, TN'], { destinationCountry: 'US' })).toEqual(['Dallas, US', 'Paris, US', 'Memphis, US']);
    expect(route(['Toronto, ON', 'London', 'Windsor, ON'], { destinationCountry: 'CA' })).toEqual(['Toronto, CA', 'London, CA', 'Windsor, CA']);
    expect(route(['ORLEANS'])).toEqual(['Orléans, CA']);
    expect(route(['ORLEANS', 'Tours'], { carriers: ['yunexpress'] })).toEqual(['Orléans, FR', 'Tours, FR']);
    expect(route(['Paris', 'ORLEANS', 'Tours'], { carriers: ['yunexpress'] })).toEqual(['Paris, FR', 'Orléans, FR', 'Tours, FR']);
    expect(route(['Lausanne', 'Chavannes', 'Daillens Centre Colis'])).toEqual(['Lausanne, CH', 'Chavannes, CH', 'Daillens, CH']);
    expect(route(['CH', 'Chavannes', 'Daillens Centre Colis', 'CH'], { destinationCountry: 'CH', carriers: ['swiss-post'] }))
      .toEqual(['Switzerland, CH', 'Chavannes, CH', 'Daillens, CH', 'Switzerland, CH']);
  });

  it('tells a country\'s towns of one name apart by the offset the carrier states for each scan', () => {
    const towns = (locations: string[], offsets: string[]) => placesForEvents(locations, {
      destinationCountry: 'US', times: offsets.map((offset, day) => `2026-10-2${day}T08:00:00${offset}`),
    }).map((place) => place && [placeTimeZone(place), Math.round(place.longitude)]);
    // A Lincoln at -04:00 after Boston is not Nebraska's, when the parcel's other towns keep their own offsets.
    expect(towns(['Omaha, USA', 'Boston, USA', 'Lincoln, USA'], ['-05:00', '-04:00', '-04:00'])?.[2])
      .toEqual(['America/New_York', -71]);
    // A carrier stating one offset everywhere tells nothing.
    expect(towns(['Omaha, USA', 'Boston, USA', 'Lincoln, USA'], ['-04:00', '-04:00', '-04:00'])?.[2])
      .toEqual(['America/Chicago', -97]);
    // Part of Florida keeps Central time, so a town there keeps either offset.
    for (const offset of ['-05:00', '-04:00']) {
      expect(towns(['Boston, USA', 'Mobile, USA', 'Marianna, USA'], ['-04:00', '-05:00', offset])?.[2]).toEqual(['America/Chicago', -85]);
    }
  });

  it('gives paperwork filed away from the parcel no place', () => {
    const scans = (list: [string, string, string][]) => route(list.map(([location]) => location), {
      stages: list.map(([, stage]) => stage),
      times: list.map(([, , time]) => time),
    });
    const hongKong = 'HONG KONG - HONG KONG SAR, CHINA';
    const basel = 'BASEL - SWITZERLAND';
    // The destination's customs office clears the parcel while it is still being sorted in Hong Kong.
    expect(scans([[hongKong, 'in_transit', '2026-01-05T11:47:00Z'], [basel, 'customs', '2026-01-05T15:53:00Z']]))
      .toEqual(['Hong Kong, HK', null]);
    expect(scans([[hongKong, 'in_transit', '2026-01-05T11:47:00Z'], [basel, 'customs', '2026-01-05T15:53:00Z'],
      [hongKong, 'in_transit', '2026-01-05T16:18:00Z'], ['BAHRAIN - BAHRAIN', 'in_transit', '2026-01-06T08:27:00Z']]))
      .toEqual(['Hong Kong, HK', null, 'Hong Kong, HK', 'Bahrain, BH']);
    expect(route([hongKong, basel, hongKong])).toEqual(['Hong Kong, HK', 'Basel, CH', 'Hong Kong, HK']);
    // Once the parcel has had time to get there, the clearance is where it is; a clock without its offset proves nothing.
    expect(scans([[hongKong, 'in_transit', '2026-01-05T11:47:00Z'], ['LEIPZIG - GERMANY', 'in_transit', '2026-01-06T08:00:00Z'],
      [basel, 'customs', '2026-01-06T20:00:00Z'], [basel, 'in_transit', '2026-01-06T22:00:00Z']]))
      .toEqual(['Hong Kong, HK', 'Leipzig, DE', 'Basel, CH', 'Basel, CH']);
    expect(scans([[hongKong, 'in_transit', '2026-01-05T11:47:00'], [basel, 'customs', '2026-01-05T15:53:00']]))
      .toEqual(['Hong Kong, HK', 'Basel, CH']);
    // An import released by a central office the parcel never went to.
    expect(scans([['Barcelona, BC, ES', 'in_transit', '2026-01-05T15:51:00Z'], ['Madrid, MD, ES', 'customs', '2026-01-07T11:07:00Z'],
      ['Barcelona, BC, ES', 'in_transit', '2026-01-08T18:02:00Z']])).toEqual(['Barcelona, ES', null, 'Barcelona, ES']);
    // The delivering carrier registers the parcel, and misses it, before it has crossed.
    expect(scans([['FR', 'registered', '2026-01-05T11:09:00Z'], ['LONDON - UNITED KINGDOM', 'accepted', '2026-01-07T07:49:00Z'],
      ['FR', 'pending', '2026-01-07T11:52:00Z'], ['AMSTERDAM - NETHERLANDS', 'in_transit', '2026-01-08T07:27:00Z'],
      ['FR', 'delivered', '2026-01-10T14:32:00Z']]))
      .toEqual([null, 'London, GB', null, 'Amsterdam, NL', 'France, FR']);
    expect(scans([['Germany', 'registered', '2026-01-05T10:05:00Z'], ['Shanghai, China', 'accepted', '2026-01-05T10:05:56Z']]))
      .toEqual([null, 'Shanghai, CN']);
    // A label created where the parcel sets off stays, and so does a hub only a country names on its way.
    expect(scans([['Poland', 'registered', '2026-01-05T21:25:00Z'], ['Warsaw', 'accepted', '2026-01-07T09:00:00Z'],
      ['Berlin', 'in_transit', '2026-01-08T09:00:00Z']])).toEqual(['Poland, PL', 'Warsaw, PL', 'Berlin, DE']);
    expect(scans([['Poland', 'registered', '2026-01-05T21:25:00Z'], ['Strasbourg', 'accepted', '2026-01-07T09:00:00Z'],
      ['Berlin', 'in_transit', '2026-01-08T09:00:00Z'], ['Warsaw', 'delivered', '2026-01-09T09:00:00Z']]))
      .toEqual([null, 'Strasbourg, FR', 'Berlin, DE', 'Warsaw, PL']);
    expect(scans([['Shenzhen', 'in_transit', '2026-01-05T10:00:00Z'], ['Hong Kong International Hub', 'in_transit', '2026-01-06T21:04:00Z'],
      ['Leipzig', 'in_transit', '2026-01-07T09:00:00Z']])).toEqual(['Shenzhen, CN', 'Hong Kong, HK', 'Leipzig, DE']);
    // A registration in the country a provider names alone, while the parcel is still being handled at origin.
    expect(scans([['Shenzhen', 'accepted', '2026-01-05T10:00:00Z'], ['Guangzhou', 'in_transit', '2026-01-05T20:00:00Z'],
      ['DE', 'registered', '2026-01-06T06:05:00Z']])).toEqual(['Shenzhen, CN', 'Guangzhou, CN', null]);
    expect(scans([['Frankfurt', 'in_transit', '2026-01-05T10:00:00Z'], ['DE', 'registered', '2026-01-05T12:00:00Z']]))
      .toEqual(['Frankfurt, DE', 'Germany, DE']);
  });
});

describe('restoreLostLetters', () => {
  const lost = (location: string, description = '') => restoreLostLetters({
    status: 'in_transit', last_status_text: description, last_update: '2026-10-24T11:00:00Z', expected_delivery: null,
    events: [{ time: '2026-10-24T11:00:00Z', location, description }],
  });

  it('fills a letter a carrier lost from the one town of its country it fits', () => {
    expect(lost('SAINT-\uFFFDTIENNE, France').events?.[0]?.location).toBe('SAINT-ÉTIENNE, France');
    expect(lost('Saint \uFFFDtienne, France').events?.[0]?.location).toBe('Saint Étienne, France');
    expect(lost('B\uFFFDziers, France').events?.[0]?.location).toBe('Béziers, France');
    // Münster and Munster are both German towns.
    expect(lost('M\uFFFDNSTER, Germany').events?.[0]?.location).toBe('M\uFFFDNSTER, Germany');
    expect(lost('SAINT-\uFFFDTIENNE, Germany').events?.[0]?.location).toBe('SAINT-\uFFFDTIENNE, Germany');
    expect(lost('SAINT-\uFFFDTIENNE').events?.[0]?.location).toBe('SAINT-\uFFFDTIENNE');
  });

  it('restores the place and the wording that names it', () => {
    const result = lost('SAINT-\uFFFDTIENNE, France', 'The shipment was prepared in SAINT-\uFFFDTIENNE for further shipping (France).');
    expect(result.last_status_text).toBe('The shipment was prepared in SAINT-ÉTIENNE for further shipping (France).');
    expect(result.events?.[0]).toMatchObject({ location: 'SAINT-ÉTIENNE, France', description: result.last_status_text });
  });
});

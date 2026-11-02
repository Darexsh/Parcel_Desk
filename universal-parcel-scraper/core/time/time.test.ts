import { DateTime, Settings } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  calendarDay, countryCode, countryKeepsOffset, countryTimeZone, epochMillisTime, epochSecondsTime, explicitOffsetTime, firstOccurrence, isoTime, mislabeledLocalTime,
  mislabeledWallTime, canadaProvinceTimeZone, postalOfficeZone, regionHasTown, settleGuessedClocks, sharedClockZone, timeZoneCountry, townKey,
  usStateTimeZone, usZipState, zonedTime,
} from './index.js';

describe('time policies', () => {
  it('keeps explicit offsets and rejects naive values', () => {
    expect(explicitOffsetTime('2026-09-10T08:15:00+01:00')).toEqual({ iso: '2026-09-10T08:15:00+01:00', timestamp: Date.parse('2026-09-10T07:15:00Z') });
    expect(explicitOffsetTime('2026-09-10T08:15:00Z')?.iso).toBe('2026-09-10T08:15:00Z');
    expect(explicitOffsetTime('2026-09-10T08:15:00')).toBeNull();
    expect(explicitOffsetTime(1234)).toBeNull();
  });

  it('reads naive wall-clock values in a declared zone', () => {
    const parsed = zonedTime('2026-01-15 09:30:00', 'yyyy-MM-dd HH:mm:ss', 'Europe/Prague');
    expect(parsed?.iso).toBe('2026-01-15T09:30:00+01:00');
    expect(zonedTime('15/01/2026 09:30:00', 'dd/MM/yyyy HH:mm:ss', 'Europe/Madrid', { locale: 'es-ES' })?.iso).toBe('2026-01-15T09:30:00+01:00');
    expect(zonedTime('not a date', 'yyyy-MM-dd', 'UTC')).toBeNull();
  });

  it('reads ISO values with or without an offset', () => {
    expect(isoTime('2026-07-01T10:00:00', 'Europe/Zurich')?.iso).toBe('2026-07-01T10:00:00+02:00');
    expect(isoTime('2026-07-01T10:00:00-04:00', 'Europe/Zurich')?.iso).toBe('2026-07-01T10:00:00-04:00');
  });

  it('reads a wall time the clocks repeat as its first occurrence in every season', () => {
    const now = Settings.now;
    try {
      // Luxon would otherwise take the offset the zone has when the code runs.
      for (const season of [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)]) {
        Settings.now = () => season;
        expect(zonedTime('2025-10-26 02:30', 'yyyy-MM-dd HH:mm', 'Europe/Paris')?.iso).toBe('2025-10-26T02:30:00+02:00');
        expect(isoTime('2025-11-02T01:30:00', 'America/New_York')?.iso).toBe('2025-11-02T01:30:00-04:00');
        expect(mislabeledLocalTime('2025-10-26T02:30:00Z', 'Europe/Zurich')?.iso).toBe('2025-10-26T02:30:00+02:00');
        expect(sharedClockZone(['Europe/Berlin', 'Europe/Paris'], '2025-10-26T02:30:00')).toBe('Europe/Berlin');
        // The hour the spring change skips still reads an hour later.
        expect(zonedTime('2026-03-29 02:30', 'yyyy-MM-dd HH:mm', 'Europe/Paris')?.iso).toBe('2026-03-29T03:30:00+02:00');
      }
    } finally {
      Settings.now = now;
    }
  });

  it('leaves a reading that names one instant as it is', () => {
    for (const time of [
      DateTime.fromISO('2025-10-26T02:30:00+01:00', { setZone: true }),
      DateTime.fromISO('2026-07-01T10:00:00', { zone: 'Europe/Paris' }),
      DateTime.fromISO('not a time', { zone: 'Europe/Paris' }),
    ]) expect(firstOccurrence(time)).toBe(time);
  });

  it('re-reads a local time a provider labeled as UTC or with its own offset', () => {
    // PostNL: a Swiss scan at 09:15 local, sent as "09:15Z".
    expect(mislabeledLocalTime('2026-06-10T09:15:00Z', 'Europe/Zurich')).toEqual({
      iso: '2026-06-10T09:15:00+02:00', timestamp: Date.parse('2026-06-10T07:15:00Z'),
    });
    // ParcelsApp: the same local clock re-labeled "+00:00" or shifted into "+02:00".
    expect(mislabeledLocalTime('2026-06-10T14:05:00+00:00', 'Europe/Zurich')?.iso).toBe('2026-06-10T14:05:00+02:00');
    expect(mislabeledLocalTime('2026-06-10T13:30:00+02:00', 'Europe/Zurich')?.iso).toBe('2026-06-10T11:30:00+02:00');
    expect(mislabeledLocalTime('2026-01-15T09:30:00', 'Asia/Kolkata')?.iso).toBe('2026-01-15T09:30:00+05:30');
    expect(mislabeledLocalTime('not a date', 'UTC')).toBeNull();
  });

  it('exposes the wall clock a mislabeled time is re-read from', () => {
    expect(mislabeledWallTime('2026-06-10T14:05:00+00:00')).toBe('2026-06-10T14:05:00.000');
    expect(mislabeledWallTime('2026-06-10T13:30:00+02:00')).toBe('2026-06-10T11:30:00.000');
    expect(mislabeledWallTime('2026-01-15T09:30:00')).toBe('2026-01-15T09:30:00.000');
    expect(mislabeledWallTime('not a date')).toBeNull();
  });

  it('picks one zone only when every zone reads the wall clock as the same instant', () => {
    const central = ['Europe/Zurich', 'Europe/Paris', 'Europe/Berlin'];
    expect(sharedClockZone(central, '2026-06-10T14:05:00')).toBe('Europe/Zurich');
    expect(sharedClockZone(central, '2026-01-15T09:30:00')).toBe('Europe/Zurich');
    // Around both 2026 DST changes, the skipped and the repeated hour included.
    for (const wall of ['2026-03-29T01:30:00', '2026-03-29T02:30:00', '2026-03-29T03:30:00',
      '2026-10-25T01:30:00', '2026-10-25T02:30:00', '2026-10-25T03:30:00']) {
      expect(sharedClockZone(central, wall)).toBe('Europe/Zurich');
    }
    for (const wall of ['2026-06-10T14:05:00', '2026-01-15T09:30:00', '2026-03-29T00:30:00', '2026-10-25T01:30:00']) {
      expect(sharedClockZone(['Europe/Zurich', 'Europe/London'], wall)).toBeNull();
    }
    expect(sharedClockZone([], '2026-06-10T14:05:00')).toBeNull();
    expect(sharedClockZone(['Europe/Zurich', 'Not/AZone'], '2026-06-10T14:05:00')).toBeNull();
    expect(sharedClockZone(['Europe/Zurich'], 'not a date')).toBeNull();
    // An instant is the same everywhere: that is not a shared clock.
    expect(sharedClockZone(['Europe/Zurich', 'Europe/London'], '2026-06-10T14:05:00Z')).toBeNull();
  });

  it('keeps a guessed clock only if it fits the feed order and the lookup time', () => {
    const at = (iso: string) => explicitOffsetTime(iso)!;
    const readAt = Date.parse('2026-09-10T12:00:00Z');
    // Newest first: a known scan, a guess between two known scans, a guess below the last one.
    const settled = settleGuessedClocks([
      { known: at('2026-09-10T10:00:00Z') },
      { guesses: [at('2026-09-10T11:00:00Z'), at('2026-09-10T09:00:00Z')] },
      { known: at('2026-09-10T08:00:00Z') },
      { guesses: [at('2026-09-10T07:00:00+02:00')] },
      { guesses: [null] },
    ], readAt);
    // The first guess would be newer than the scan listed above it; the second fits.
    expect(settled.map((time) => time?.iso ?? null)).toEqual([
      '2026-09-10T10:00:00Z', '2026-09-10T09:00:00Z', '2026-09-10T08:00:00Z', '2026-09-10T07:00:00+02:00', null,
    ]);
    // Nothing known around it: only the lookup bounds a guess, with an hour of skew.
    expect(settleGuessedClocks([{ guesses: [at('2026-09-10T13:00:00Z')] }], readAt)[0]?.iso).toBe('2026-09-10T13:00:00Z');
    expect(settleGuessedClocks([{ guesses: [at('2026-09-10T13:00:01Z')] }], readAt)[0]).toBeNull();
  });

  it("tells whether a country's clocks show an offset, in winter or summer", () => {
    expect(countryKeepsOffset('US', '-07:00')).toBe(true);
    expect(countryKeepsOffset('US', '-05:00')).toBe(true);
    expect(countryKeepsOffset('US', '+08:00')).toBe(false);
    expect(countryKeepsOffset('Switzerland', '+02:00')).toBe(true);
    expect(countryKeepsOffset('CH', '+03:00')).toBe(false);
    expect(countryKeepsOffset('CN', '+08:00')).toBe(true);
    expect(countryKeepsOffset('Canada', '-05:00')).toBeNull();
    expect(countryKeepsOffset('US', '+8')).toBeNull();
  });

  it('maps single-zone countries by code or name', () => {
    expect(countryTimeZone('CH')).toBe('Europe/Zurich');
    expect(countryTimeZone(' switzerland ')).toBe('Europe/Zurich');
    expect(countryTimeZone('Schweiz')).toBe('Europe/Zurich');
    expect(countryTimeZone('India')).toBe('Asia/Kolkata');
    expect(countryTimeZone('Kuwait')).toBe('Asia/Kuwait');
    expect(countryTimeZone('Colombia')).toBe('America/Bogota');
    expect(countryTimeZone('UA')).toBe('Europe/Kyiv');
    expect(countryTimeZone('US')).toBeNull();
    expect(countryTimeZone('Canada')).toBeNull();
    expect(countryTimeZone('Brazil')).toBeNull();
    // Single-zone territories, and none whose code or name a US state also has.
    expect(countryTimeZone('South Africa')).toBe('Africa/Johannesburg');
    expect(countryTimeZone('RE')).toBe('Indian/Reunion');
    expect(countryTimeZone('Réunion')).toBe('Indian/Reunion');
    for (const value of ['GA', 'TN', 'PA', 'Georgia']) expect(countryTimeZone(value)).toBeNull();
    expect(countryTimeZone(undefined)).toBeNull();
  });

  it('reads a UPU office code on its country\'s single clock', () => {
    expect(postalOfficeZone('GBLALA')).toBe('Europe/London');
    expect(postalOfficeZone('DEFRAA')).toBe('Europe/Berlin');
    expect(postalOfficeZone('JPTYO1')).toBe('Asia/Tokyo');
    // Several zones, islands on clocks of their own, and no office code.
    for (const code of ['AUSYDB', 'USJFKA', 'ESMADA', 'PTLISA', 'ZZXMPA', 'GBLAL', 'GBLALAX', 'gblala', 'AL1066', 'LONDON BPI']) {
      expect(postalOfficeZone(code), code).toBeNull();
    }
  });

  it('names any country by code or English name, whatever its clocks', () => {
    expect(countryCode(' United States ')).toBe('US');
    expect(countryCode('south africa')).toBe('ZA');
    expect(countryCode('Bosnia and Herzegovina')).toBe('BA');
    expect(countryCode('Bosnia & Herzegovina')).toBe('BA');
    expect(countryCode('Saint Kitts and Nevis')).toBe('KN');
    expect(countryCode('Trinidad and Tobago')).toBe('TT');
    expect(countryCode('us')).toBe('US');
    expect(countryCode('Switzerland')).toBe('CH');
    expect(countryCode('Côte d’Ivoire')).toBe('CI');
    expect(countryCode("COTE D'IVOIRE")).toBe('CI');
    // Full or former names carriers still print.
    expect(countryCode('United States of America')).toBe('US');
    expect(countryCode('UNITED STATES OF AMERICA')).toBe('US');
    expect(countryCode('USA')).toBe('US');
    expect(countryCode('Czech Republic')).toBe('CZ');
    expect(countryTimeZone('czech republic')).toBe('Europe/Prague');
    expect(countryTimeZone('United States of America')).toBeNull();
    // Retired codes, subdivisions and places are not countries.
    for (const value of ['UK', 'FX', 'ON', 'Example Hub', 'EXAMPLE CITY, CA', '', undefined]) expect(countryCode(value)).toBeNull();
  });

  it('names a country in German, French, Italian, Spanish or Dutch, with or without accents', () => {
    for (const name of ['Schweiz', 'Suisse', 'Svizzera', 'Suiza', 'Zwitserland']) expect(countryCode(name), name).toBe('CH');
    for (const name of ['Österreich', 'OESTERREICH', 'osterreich', 'Autriche']) expect(countryCode(name), name).toBe('AT');
    for (const name of ['Vereinigtes Königreich', 'Großbritannien', 'GROSSBRITANNIEN', 'Royaume-Uni', 'Regno Unito', 'Reino Unido', 'Verenigd Koninkrijk']) {
      expect(countryCode(name), name).toBe('GB');
    }
    for (const name of ['États-Unis', 'ETATS-UNIS', 'Stati Uniti', 'Estados  Unidos', 'Verenigde Staten']) expect(countryCode(name), name).toBe('US');
    expect(countryCode('Südafrika')).toBe('ZA');
    expect(countryCode('Afrique du Sud')).toBe('ZA');
    expect(countryCode('Nederland')).toBe('NL');
    // A name a large town shares names the town as often as the country.
    for (const name of ['Granada', 'Salvador', 'Norfolk', 'Guadalupe', 'San Martín', 'Singapur']) expect(countryCode(name), name).toBeNull();
  });

  it('maps US states and territories to their majority zone', () => {
    expect(usStateTimeZone('IL')).toBe('America/Chicago');
    expect(usStateTimeZone(' ny ')).toBe('America/New_York');
    expect(usStateTimeZone('PR')).toBe('America/Puerto_Rico');
    for (const value of ['ON', 'US', '', undefined]) expect(usStateTimeZone(value)).toBeNull();
  });

  it('places a US ZIP code in its state by its prefix', () => {
    expect(usZipState('94000')).toBe('CA');
    expect(usZipState(' 00600-0000 ')).toBe('PR');
    // A prefix without ZCTAs inside one state's run is that state's.
    expect(usZipState('19200')).toBe('PA');
    // Another state's prefixes inside a run, military, unassigned and boundary prefixes have no state.
    for (const value of ['05500', '73300', '09000', '34000', '96200', '00000', '56800', '1000', '100000', 10000, undefined]) {
      expect(usZipState(value), String(value)).toBeNull();
    }
  });

  it('maps Canadian provinces and territories to their majority zone', () => {
    expect(canadaProvinceTimeZone('on')).toBe('America/Toronto');
    expect(canadaProvinceTimeZone('SK')).toBe('America/Regina');
    for (const value of ['IL', 'CA', '', undefined]) expect(canadaProvinceTimeZone(value)).toBeNull();
  });

  it('tells the towns of states and provinces from the countries their codes also name', () => {
    expect(townKey("St. John's")).toBe(townKey('SAINT JOHNS'));
    expect(regionHasTown('IL', 'CHICAGO')).toBe(true);
    expect(regionHasTown('il', 'Elk Grove Village')).toBe(true);
    expect(regionHasTown('IL', 'Tel Aviv')).toBe(false);
    expect(regionHasTown('DE', 'Koeln')).toBe(false);
    expect(regionHasTown('NL', "St. John's")).toBe(true);
    expect(regionHasTown('CO', 'Denver')).toBe(true);
    expect(regionHasTown('CO', 'Cartagena de Indias')).toBe(false);
    // Only the codes shared with a single-clock country have lists.
    expect(regionHasTown('NY', 'New York')).toBe(false);
    // Island groups on another clock than their country, without the names the mainland shares.
    expect(regionHasTown('ES-CN', 'TENERIFE')).toBe(true);
    expect(regionHasTown('ES-CN', 'Las Palmas de Gran Canaria')).toBe(true);
    expect(regionHasTown('ES-CN', 'Madrid')).toBe(false);
    expect(regionHasTown('PT-20', 'Ponta Delgada')).toBe(true);
    expect(regionHasTown('PT-20', 'Lagoa')).toBe(false);
    expect(regionHasTown('PT-20', 'Lisboa')).toBe(false);
  });

  it('maps a zone back to its single-zone country only', () => {
    expect(timeZoneCountry('Europe/Zurich')).toBe('CH');
    expect(timeZoneCountry('Asia/Kolkata')).toBe('IN');
    expect(timeZoneCountry('America/New_York')).toBeNull();
    expect(timeZoneCountry('UTC')).toBeNull();
  });

  it('accepts epoch values only when positive and finite', () => {
    expect(epochMillisTime(1_760_000_000_000)?.iso).toBe('2025-10-09T08:53:20Z');
    expect(epochMillisTime('1760000000000')?.timestamp).toBe(1_760_000_000_000);
    expect(epochMillisTime(0)).toBeNull();
    expect(epochMillisTime('')).toBeNull();
    expect(epochSecondsTime(1_760_000_000)?.iso).toBe('2025-10-09T08:53:20Z');
  });

  it('validates calendar days', () => {
    expect(calendarDay(2026, 2, 29)).toBeNull();
    expect(calendarDay(2026, 1, 1)).toBe('2026-01-01');
    expect(calendarDay(2026, 1.5, 1)).toBeNull();
  });
});

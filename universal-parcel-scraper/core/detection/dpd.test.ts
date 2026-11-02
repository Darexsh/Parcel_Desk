import { describe, expect, it } from 'vitest';
import { carrierIdFromPartner } from '../catalog/hints.js';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { dpdParcelNumber } from './dpd.js';
import { detectCarrierMatch, isValidDpdParcelNumber, parseTrackingInput } from './index.js';

describe('DPD parcel number check character', () => {
  it('reads the fourteen digits with or without the printed character', () => {
    expect(dpdParcelNumber('12345678901234')).toBe('12345678901234');
    for (const [digits, character] of [['12345678901234', 'E'], ['00000000000000', 'U'], ['99999999999999', 'Z'], ['01234567890123', '3']]) {
      expect(dpdParcelNumber(`${digits}${character}`)).toBe(digits);
    }
  });

  it('refuses a character that does not match and any other length', () => {
    for (const value of ['12345678901234F', '123456789012343', '1234567890123', '1234567890123E', '12345678901234EE', '12345678901234e', '12345678901234\n']) {
      expect(dpdParcelNumber(value)).toBeNull();
      expect(isValidDpdParcelNumber(value)).toBe(false);
    }
    // The check needs the character: fourteen digits alone have nothing to verify.
    expect(isValidDpdParcelNumber('12345678901234')).toBe(false);
  });

  it('offers the DPD networks for a label typed with its matching character', () => {
    const letter = detectCarrierMatch('1234 5678 9012 34 E');
    expect(letter).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(letter.candidates).toEqual(expect.arrayContaining(['dpd', 'dpd-de', 'dpd-uk', 'chronopost']));
    expect(recognitionAskedCarriers('12345678901234E')).toContain('dpd');
    // A digit can be the check character too.
    expect(isValidDpdParcelNumber('012345678901233')).toBe(true);
    expect(detectCarrierMatch('012345678901233').candidates).toEqual(expect.arrayContaining(['dpd', 'dpd-de', 'dpd-uk']));
  });

  it('offers Chronopost the fourteen digits too, first for a French reader', () => {
    const digits = detectCarrierMatch('04000000000019');
    expect(digits).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(digits.candidates).toEqual(expect.arrayContaining(['dpd', 'dpd-fr', 'chronopost', 'brt', 'seur']));
    expect(recognitionCandidates('04000000000019', { countryHint: 'FR' })[0]).toMatchObject({ carrier: 'chronopost', countryMatch: 'home' });
    // Another country's own network stays first.
    expect(recognitionAskedCarriers('04000000000019', { countryHint: 'IT' })[0]).toBe('brt');
    expect(recognitionAskedCarriers('04000000000019', { countryHint: 'ES' })[0]).toBe('seur');
  });

  it('keeps a mistyped character away from DPD', () => {
    expect(detectCarrierMatch('12345678901234Q').candidates).toEqual([]);
    for (const carrier of ['dpd', 'dpd-de', 'dpd-uk']) {
      expect(detectCarrierMatch('012345678901234').candidates).not.toContain(carrier);
    }
  });
});

describe('DPD group site links', () => {
  it('names the network of the country the link’s path gives', () => {
    for (const [url, carrier] of [
      ['https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming?parcelNumber=01234567890123', 'dpd'],
      ['https://www.dpdgroup.com/be/mydpd/my-parcels/track?parcelNumber=01234567890123', 'dpd-be'],
      ['https://www.dpdgroup.com/nl/mydpd/my-parcels/search?parcelNumber=01234567890123', 'dpd-nl'],
      ['https://www.dpdgroup.com/hu/mydpd/my-parcels/search?parcelNumber=01234567890123', 'dpd-hu'],
      ['https://www.dpd.com/ro/ro/?parcelNumber=01234567890123', 'dpd-ro'],
    ] as const) {
      expect(parseTrackingInput(url)).toMatchObject({ trackingNumber: '01234567890123', carrier, confidence: 'high', source: 'link' });
      expect(carrierIdFromPartner('', url)).toBe(carrier);
    }
  });

  it('names no network for a country the catalog has none for', () => {
    const url = 'https://www.dpdgroup.com/sk/mydpd/my-parcels/search?parcelNumber=01234567890123';
    expect(parseTrackingInput(url).carrier).toBe('unknown');
    expect(carrierIdFromPartner('', url)).toBeUndefined();
  });
});

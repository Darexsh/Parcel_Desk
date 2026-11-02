import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { detectCarrierMatch } from './detect.js';
import { normalizeRelaisColisTrackingNumber } from '../../carriers/relais-colis/adapter.js';
import { settleRecognition, type RecognitionOutcome } from '../recognition/index.js';

describe('French carrier number candidates', () => {
  it('asks Relais Colis about the complete VD family while preserving its overlap', () => {
    const number = 'VD1234567890';
    expect(detectCarrierMatch(number)).toMatchObject({
      carrier: 'unknown', confidence: 'low',
      candidates: expect.arrayContaining(['colis-prive', 'relais-colis']),
    });
    expect(recognitionAskedCarriers(number)).toContain('relais-colis');
    expect(normalizeRelaisColisTrackingNumber('vd 12345-67890')).toBe(number);
    for (const nearMiss of ['VD123456789', 'VD12345678901', 'VD123456789X']) {
      expect(detectCarrierMatch(nearMiss).candidates).not.toContain('relais-colis');
    }
  });

  it('suggests Colis Privé for its credential with a French, Belgian or Luxembourg postcode', () => {
    for (const number of ['AB123456789075001', 'AB1234567890B1000', 'AB1234567890L9999']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['colis-prive'] });
    }
    for (const nearMiss of ['AB1234567890B0999', 'AB1234567890D1000', 'AB1234567890B100']) {
      expect(detectCarrierMatch(nearMiss).candidates).not.toContain('colis-prive');
    }
  });

  it('does not read a postcode into Yanwen\'s US last-mile numbers', () => {
    // YW, a US hub code and twelve digits: the last five look like a French postcode.
    expect(detectCarrierMatch('YWLAX000000075001')).toMatchObject({ carrier: 'yanwen', confidence: 'high', candidates: ['yanwen'] });
    expect(detectCarrierMatch('YWLA0000000075001').candidates).toEqual(['colis-prive']);
    expect(detectCarrierMatch('XWLAX000000075001').candidates).toEqual(['colis-prive']);
  });

  it("names YWE for YWE and fourteen digits, without reading a postcode into them", () => {
    for (const number of ['YWE00000000075001', 'ywe 0000 0000 075001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'ywe', confidence: 'high', candidates: ['ywe'] });
    }
    for (const number of ['YWE0000000075001', 'YWE000000000075001', 'YWF00000000075001', 'YWE00000000075001US']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ywe');
    }
    // Twelve characters and a postcode that do not open with YWE and fourteen digits stay Colis Privé's.
    expect(detectCarrierMatch('YWE0000000A075001').candidates).toEqual(['colis-prive']);
  });

  it("does not read a postcode into GOFO's 13-digit numbers", () => {
    // GF or CI, a country code and thirteen digits: the last five look like a French postcode.
    for (const number of ['GFUS0000000075001', 'GFNL0000000075001', 'GFES0000000075001', 'CIDE0000000075001']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('colis-prive');
    }
    expect(detectCarrierMatch('GFFR0000000075001')).toMatchObject({ carrier: 'gofo-fr', candidates: ['gofo-fr'] });
    expect(detectCarrierMatch('GFUSA000000075001').candidates).toEqual(['colis-prive']);
  });

  it('offers GLS France to HTTP recognition for shared numeric and alpha references', () => {
    for (const number of ['36631000001', '366310000017', 'A1B2C3D4']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(recognitionAskedCarriers(number)).toContain('gls-fr');
      expect(recognitionCandidates(number, { phase: 'browser' }).map(({ carrier }) => carrier)).not.toContain('gls-fr');
    }
  });

  it('asks C chez vous about its order shape without naming it, since other carriers print it too', () => {
    // Synthetic references in C chez vous's order layout; HV leads like a Hovership number.
    for (const number of ['ABCD12EF34', 'HVAB12CD34']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['c-chez-vous'] });
      expect(recognitionAskedCarriers(number)).toEqual(['c-chez-vous']);
    }
    // Four letters and six digits are other carriers' consignments: Team Global Express's, New Zealand Couriers' senders'.
    for (const number of ['ABC123EF34', 'ABCD12EF345', 'HVABCD1234', 'ABCD123456']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('c-chez-vous');
    }
  });

  it('names Vinted Go for VGS and thirteen or fourteen digits only', () => {
    for (const number of ['VGS3000000000001', 'VGS30000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'vinted-go', confidence: 'high' });
    }
    for (const number of ['VGS300000000000', 'VGS300000000000001', 'VGT30000000000001', 'VG300000000000001', 'VGSX0000000000001']) {
      const match = detectCarrierMatch(number);
      expect(match.carrier, number).not.toBe('vinted-go');
      expect(match.candidates ?? [], number).not.toContain('vinted-go');
    }
  });

  it('suggests Vinted Go first for sixteen digits from 17 or 18 with a passing Luhn digit, wherever the parcel comes from', () => {
    for (const number of ['1790000000000010', '1771234567890124', '1800000000000026']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['vinted-go'] });
      expect(detectCarrierMatch(number).candidates?.[0], number).toBe('vinted-go');
      for (const countryHint of [undefined, 'GB', 'US']) {
        expect(recognitionCandidates(number, { countryHint })[0], number).toMatchObject({ carrier: 'vinted-go', preferred: true });
      }
    }
    // A failed check digit, or another start, is not Vinted Go's.
    for (const number of ['1790000000000011', '1600000000000010']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('vinted-go');
    }
  });

  it('suggests Vinted Go first for three letters, a digit, UW, a digit and nine letters or digits only', () => {
    for (const number of ['FMP1UW2ABCDEFGHI', 'ABC1UW2DEFGHI34J', 'FMP1UW2ABCDEFGH1', 'FMX1UW2ABCDEFGHI']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['vinted-go'] });
      expect(recognitionCandidates(number)[0], number).toMatchObject({ carrier: 'vinted-go', preferred: true });
    }
    // FMP also opens codes wrapping another carrier's number, in another layout.
    for (const number of ['FMP5P12A34567890', 'FMP1UW2ABCDEFGH', 'FMP1UW2ABCDEFGHIJ', 'FMP1UX2ABCDEFGHI', 'ABCDUW2DEFGHI34J', 'AB12UW2DEFGHI34J', 'ABC1UW2DEFGHI34']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('vinted-go');
    }
  });

  it('settles a French endpoint confirmation ahead of the shared GLS group answer', () => {
    const matches: RecognitionOutcome[] = recognitionCandidates('A1B2C3D4')
      .filter(({ carrier }) => ['gls-ch', 'gls-fr'].includes(carrier))
      .map((candidate) => ({ ...candidate, status: 'known', lastActivityAt: '2026-09-09T10:00:00Z' }));
    expect(matches.map(({ carrier }) => carrier)).toEqual(['gls-fr', 'gls-ch']);
    expect(settleRecognition(matches, new Date('2026-09-10T12:00:00Z'))).toEqual({ carrier: 'gls-fr', choices: [] });
  });
});

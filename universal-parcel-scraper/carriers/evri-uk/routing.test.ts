import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';

// A shared barcode shape establishes the brand, not its tracking service.
const NUMBER = 'H000000000000008';

describe('Evri service routing', () => {
  it('keeps a bare barcode ambiguous between domestic and international services', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({
      carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['evri', 'evri-uk', 'hermes-de']),
    });
  });

  it('lists the likelier service first by the barcode\'s sixth character, without choosing it', () => {
    for (const number of ['H00ZZA0000000001', 'H00ZZD0000000004', 'T00ZZA0000000005']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['evri-uk', 'evri'], preferred: ['evri-uk'] });
      expect(recognitionAskedCarriers(number)).toEqual(['evri-uk', 'evri']);
    }
    expect(detectCarrierMatch('H00ZZC0000000003')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['evri', 'evri-uk'], preferred: ['evri'] });
    expect(recognitionAskedCarriers('H00ZZC0000000003')).toEqual(['evri', 'evri-uk']);
    expect(detectCarrierMatch('H00ZZB0000000002')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: [] });
  });

  it('offers the domestic service alone for its C00HHA barcodes', () => {
    expect(detectCarrierMatch('C00HHA0000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['evri-uk'] });
    expect(detectCarrierMatch('COOHHA0000000001').candidates).not.toContain('evri-uk');
  });

  it('asks the domestic service about an all-digit barcode whose GS1 check digit holds, without choosing it', () => {
    expect(detectCarrierMatch('9000000000000003')).toMatchObject({
      carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['evri-uk']), preferred: [],
    });
    expect(recognitionAskedCarriers('9000000000000003', { countryHint: 'GB' })[0]).toBe('evri-uk');
    expect(recognitionAskedCarriers('9000000000000003')).toContain('evri-uk');
    expect(detectCarrierMatch('9000000000000001').candidates).not.toContain('evri-uk');
  });

  it.each([16, 17, 18, 19])('preserves Hermes recognition outside the Evri overlap: H plus %i digits', digits => {
    expect(detectCarrierMatch(`H${'0'.repeat(digits)}`)).toMatchObject({ carrier: 'hermes-de', confidence: 'high' });
  });

  it('binds the domestic service to its explicit parcel-details link', () => {
    expect(parseTrackingInput(`https://www.evri.com/track/parcel/${NUMBER}/details`)).toMatchObject({
      carrier: 'evri-uk', confidence: 'high', trackingNumber: NUMBER, source: 'link',
    });
  });

  it('binds Hermes Germany to its explicit tracking link despite the shared barcode', () => {
    expect(parseTrackingInput(`https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${NUMBER}`)).toMatchObject({
      carrier: 'hermes-de', confidence: 'high', trackingNumber: NUMBER, source: 'link',
    });
  });
});

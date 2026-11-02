import { describe, expect, it } from 'vitest';
import { carrierIdFromName } from '../catalog/hints.js';
import { recognitionCandidates } from '../catalog/recognition.js';
import { settleRecognition, type RecognitionOutcome } from '../recognition/index.js';
import { checksumRejections, detectCarrierMatch, parseTrackingInput } from './index.js';
import { isValidFedEx1DBarcode } from './fedex.js';
import { isValidUspsPackageBarcode, uspsPackageIdentifier } from './usps.js';
import { normalizeUSPSNumber, parseUSPSTrackingHtml, uspsTrackingUrl } from '../../carriers/usps/adapter.js';
import { normalizeRoyalMailNumber, parseRoyalMailTrackingResponse, royalMailSummaryApiUrl } from '../../carriers/royal-mail/parser.js';
import { normalizeIntelcomNumber } from '../../carriers/intelcom/parser.js';

// Synthetic identifiers; the PIC check digit is calculated independently.
const PIC = '9210090000000012345679';
const PIC26 = '92000000000123456789012344';
// Channel 93 with a six-digit Mailer ID; its last 22 digits also pass the check
// digit, as a channel 92 PIC whose Mailer ID does not start with 9.
const WIDE = '93009200000000123456789013';

describe('USPS whole package barcodes', () => {
  it('uses the PIC checksum without counting its routing prefix', () => {
    expect(isValidUspsPackageBarcode(PIC)).toBe(true);
    for (const zip of ['00000', '000000000']) {
      const raw = `420${zip}${PIC}`;
      expect(uspsPackageIdentifier(raw)).toBe(PIC);
      expect(normalizeUSPSNumber(raw)).toBe(PIC);
      expect(uspsTrackingUrl(raw)).toBe(`https://tools.usps.com/tracking/${PIC}`);
    }
  });

  it('selects USPS for a routing barcode when the bare PIC rule would select it', () => {
    for (const zip of ['00000', '000000000']) {
      for (const pic of [PIC, '9300100000012345678902', '9400100000000123456780', '9505500000000123456782', '9101900000000123456788']) {
        expect(detectCarrierMatch(`420${zip}${pic}`)).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
        expect(recognitionCandidates(`420${zip}${pic}`, { phase: 'browser' })).toEqual([]);
      }
      // A Mailer ID that does not fit its channel, or a family DHL eCommerce also tracks.
      for (const pic of ['9205510000000012345670', '9300190000012345678903', '9100000000000000000002', '9261290000000012345677', '9361200000012345678900']) {
        const raw = `420${zip}${pic}`;
        expect(detectCarrierMatch(raw)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
        expect(detectCarrierMatch(raw).preferred).toContain('usps');
        const dhl = zip.length === 5 && /^9[23]61/.test(pic);
        expect(recognitionCandidates(raw).map(candidate => candidate.carrier)).toEqual(dhl ? ['dhl-ecommerce'] : []);
        expect(recognitionCandidates(raw, { phase: 'browser' }).map(candidate => candidate.carrier)).toContain('usps');
      }
    }
    expect(detectCarrierMatch(`42000000${PIC.slice(0, -1)}1`).candidates).not.toContain('usps');
    // The zeros and the last twelve digits also fit FedEx's 34-digit barcode and pass its check.
    const shared = '4200000000009210090000000012340094';
    expect(isValidFedEx1DBarcode(shared)).toBe(true);
    expect(detectCarrierMatch(shared)).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
  });

  it('keeps a suggestion when a ZIP+4 add-on could open a 26-digit PIC', () => {
    // The PIC after ZIP+4 9201 is the identifier: the 26-digit reading's Mailer ID does not fit.
    expect(uspsPackageIdentifier(`420000009201${PIC}`)).toBe(PIC);
    expect(detectCarrierMatch(`420000009201${PIC}`)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
    // Here the 22 digits after ZIP+4 9301 fail the check and the 26 after the ZIP pass it.
    const raw = `420000009301${PIC.slice(0, -1)}8`;
    expect(uspsPackageIdentifier(raw)).toBe(raw.slice(8));
    expect(detectCarrierMatch(raw)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
  });

  it('accepts a complete 26-digit PIC, without treating the checksum as ownership', () => {
    expect(PIC26).toHaveLength(26);
    expect(normalizeUSPSNumber(PIC26)).toBe(PIC26);
    expect(normalizeUSPSNumber(`42000000${PIC26}`)).toBe(PIC26);
    expect(detectCarrierMatch(PIC26)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
  });

  it('selects USPS for a 26-digit channel 92 PIC whose Mailer ID fits', () => {
    // A made-up channel 92 PIC with a nine-digit MID.
    expect(detectCarrierMatch('92055900000000000123456786')).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
    expect(recognitionCandidates('92055900000000000123456786')).toEqual([]);
    // Channel 93 at 26 digits has too few public examples, so it stays a suggestion.
    expect(detectCarrierMatch('93001000000001234567890125')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
    expect(detectCarrierMatch('92055900000000000123456787')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    // The 9261 family stays a suggestion, as at 22 digits.
    expect(detectCarrierMatch('92612900000000000123456781')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
  });

  it('reads the retail and legacy channels only as 22-digit PICs', () => {
    for (const pic of ['9500000000000000000008', '9100000000000000000002']) {
      expect(isValidUspsPackageBarcode(pic)).toBe(true);
      expect(detectCarrierMatch(pic).candidates[0]).toBe('usps');
    }
    // A ZIP+4 add-on starting 91 would otherwise pass as the start of a 26-digit PIC.
    expect(uspsPackageIdentifier(`420123459102${PIC}`)).toBe(PIC);
  });

  it('selects USPS for a 22-digit PIC with a channel, a conforming Mailer ID and a passing check digit', () => {
    // Made-up PICs for channels 92 (nine-digit MID), 93 (six-digit MID), 94 (online), 95 (retail) and legacy 91.
    for (const pic of [PIC, '9300100000012345678902', '9400100000000123456780', '9505500000000123456782', '9101900000000123456788']) {
      expect(detectCarrierMatch(pic)).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
      expect(recognitionCandidates(pic)).toEqual([]);
    }
    // A nine-digit MID starts with 9 and a six-digit one never does.
    for (const pic of ['9205510000000012345670', '9300190000012345678903', '9100000000000000000002']) {
      expect(isValidUspsPackageBarcode(pic)).toBe(true);
      expect(detectCarrierMatch(pic)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
    }
    expect(detectCarrierMatch(`${PIC.slice(0, -1)}1`)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: [] });
    // DHL eCommerce tracks its 9261 and 9361 families too, so they stay suggestions.
    for (const pic of ['9261290000000012345677', '9361200000012345678900']) {
      expect(isValidUspsPackageBarcode(pic)).toBe(true);
      expect(detectCarrierMatch(pic)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
      expect(detectCarrierMatch(pic).candidates).toContain('dhl-ecommerce');
    }
  });

  it('reads a ZIP+4 before a 26-digit PIC, the only split of 38 digits', () => {
    const raw = `420000000000${PIC26}`;
    expect(raw).toHaveLength(38);
    expect(uspsPackageIdentifier(raw)).toBe(PIC26);
    expect(normalizeUSPSNumber(raw)).toBe(PIC26);
    expect(uspsTrackingUrl(raw)).toBe(`https://tools.usps.com/tracking/${PIC26}`);
    expect(uspsPackageIdentifier(`420000000000${PIC26.slice(0, -1)}5`)).toBeNull();
  });

  it('settles a 34-digit split by the Mailer ID layout when both readings pass the check digit', () => {
    // ZIP+4 9201 makes a channel 92 PIC whose Mailer ID does not start with 9.
    expect(uspsPackageIdentifier(`420000009201${PIC}`)).toBe(PIC);
    expect(normalizeUSPSNumber(`420000009201${PIC}`)).toBe(PIC);
    // The 22-digit reading of this ZIP5 barcode is that kind of channel 92 PIC.
    expect(isValidUspsPackageBarcode(WIDE.slice(4))).toBe(true);
    expect(uspsPackageIdentifier(`42000000${WIDE}`)).toBe(WIDE);
    expect(normalizeUSPSNumber(`42000000${WIDE}`)).toBe(WIDE);
  });

  it('refuses wrong checksums, malformed routing and ZIP/PIC splits the layout cannot settle', () => {
    // ZIP+4 9300 reads as a channel 93 PIC with a six-digit Mailer ID, as valid as the PIC after it.
    expect(isValidUspsPackageBarcode(`9300${PIC}`)).toBe(true);
    for (const raw of [`42000000${PIC.slice(0, -1)}1`, `420ABCDE${PIC}`, `4200000${PIC}`, `420000000${PIC}`, `420000009300${PIC}`]) {
      expect(uspsPackageIdentifier(raw)).toBeNull();
      expect(() => normalizeUSPSNumber(raw)).toThrow();
      expect(detectCarrierMatch(raw).candidates).not.toContain('usps');
    }
  });

  it('binds a routed input to its canonical PIC when reading the page', () => {
    const page = `<div class="track-bar-container"><span id="trackingNum">${PIC}</span></div>`
      + '<div class="latest-update-banner-wrapper"><div class="banner-header">Tracking Not Available</div></div>';
    expect(parseUSPSTrackingHtml(page, `42000000${PIC}`)).toMatchObject({ status: 'unknown', events: [] });
    expect(() => parseUSPSTrackingHtml(page.replace(PIC, PIC.slice(0, -1) + '1'), `42000000${PIC}`)).toThrow('requested parcel');
  });
});

describe('Royal Mail domestic references', () => {
  it('does not offer a plain hexadecimal word or a partial reference', () => {
    for (const raw of ['ABCDEFABCDEFABCD', '000000A000BC0D0', '3200000000000ABCDEFGH']) {
      expect(detectCarrierMatch(raw).candidates).not.toContain('royal-mail');
      expect(() => normalizeRoyalMailNumber(raw)).toThrow();
    }
  });
  it.each(['32-000 000 0000-000 ABC DEF', '000000A000BC0D00'])('keeps a complete reference through detection and submission: %s', raw => {
    const number = normalizeRoyalMailNumber(raw);
    expect(detectCarrierMatch(raw)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(raw).candidates).toContain('royal-mail');
    expect(recognitionCandidates(raw)).toEqual([]);
    expect(recognitionCandidates(raw, { phase: 'browser' }).map(candidate => candidate.carrier)).toContain('royal-mail');
    expect(royalMailSummaryApiUrl(raw)).toContain(number);
    expect(parseTrackingInput(raw).trackingNumber).toBe(raw);
    const payload = { mailPieces: { mailPieceId: number, summary: { statusCategory: 'DELIVERED' }, events: [] } };
    expect(parseRoyalMailTrackingResponse(payload, raw)).toHaveProperty('status');
    expect(() => parseRoyalMailTrackingResponse({ mailPieces: { ...payload.mailPieces, mailPieceId: '000000A000BC0D01' } }, raw)).toThrow('requested parcel');
  });
});

describe('JJD licence plates', () => {
  it('suggests InPost first, beside DHL, for the plate length Yodel prints', () => {
    const yodel = 'JJD0002000000000001';
    expect(detectCarrierMatch(yodel)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['inpost', 'dhl'], preferred: ['inpost'] });
    expect(recognitionCandidates(yodel).map(candidate => candidate.carrier)).toEqual(['inpost']);
  });

  it('keeps every other JJD plate with DHL', () => {
    for (const plate of ['JJD0099999999', 'JJD000200000000000', 'JJD00020000000000000', 'JJD000200000000000A', 'JJD000000000000000000000000']) {
      expect(detectCarrierMatch(plate)).toMatchObject({ carrier: 'dhl', confidence: 'high' });
    }
  });
});

describe('Royal Mail and Parcelforce links', () => {
  it('names Parcelforce for its numbers on Royal Mail\'s tracking page, which is also Parcelforce\'s', () => {
    for (const number of ['CP000000005GB', 'EA000000005GB', 'PBZZ0000000001']) {
      expect(parseTrackingInput(`https://www.royalmail.com/portal/rm/track?trackNumber=${number}`))
        .toMatchObject({ trackingNumber: number, carrier: 'parcelforce', confidence: 'high', source: 'link' });
    }
  });

  it('keeps Royal Mail for its own, foreign and unrecognized numbers there, and Parcelforce on its own links', () => {
    for (const number of ['AA000000005GB', 'RR123456785FR', '0000000001']) {
      expect(parseTrackingInput(`https://www.royalmail.com/portal/rm/track?trackNumber=${number}`))
        .toMatchObject({ trackingNumber: number, carrier: 'royal-mail', source: 'link' });
    }
    // Some Parcelforce services use S10 ranges that read as Royal Mail.
    expect(parseTrackingInput('https://www.parcelforce.com/track-trace?trackNumber=AA000000005GB'))
      .toMatchObject({ trackingNumber: 'AA000000005GB', carrier: 'parcelforce', source: 'link' });
  });
});

describe('UK fourteen-digit parcel numbers', () => {
  // Synthetic numbers in the ranges the carriers' own tracking pages show.
  it.each([['15500000000001', 'dpd-uk'], ['15500000000001M', 'dpd-uk'], ['15970000000000', 'dpd-uk'], ['15970000000000E', 'dpd-uk'],
    ['60120000000000', 'dhl-ecommerce-uk']])(
    'suggests the carrier of its range first: %s', (number, carrier) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates[0]).toBe(carrier);
    });

  it('suggests neither first outside those ranges, nor for a wrong check character', () => {
    expect(detectCarrierMatch('31500000000000').candidates.slice(0, 1)).not.toEqual(expect.arrayContaining(['dpd-uk', 'dhl-ecommerce-uk']));
    expect(detectCarrierMatch('15500000000001N').candidates).not.toContain('dpd-uk');
    for (const number of ['15960000000000', '15980000000000', '15570000000000']) {
      expect(detectCarrierMatch(number).preferred ?? [], number).not.toContain('dpd-uk');
    }
  });

  it('asks DPD UK first about its ranges and a British number, and files the parcel under it when other DPD networks know it too', () => {
    expect(recognitionCandidates('15970000000000')[0]).toMatchObject({ carrier: 'dpd-uk', preferred: true });
    expect(recognitionCandidates('15500000000001')[0]).toMatchObject({ carrier: 'dpd-uk', preferred: true });
    expect(recognitionCandidates('09440000000000', { countryHint: 'GB' })[0]).toMatchObject({ carrier: 'dpd-uk', countryMatch: 'home' });
    for (const [number, countryHint] of [['15970000000000', undefined], ['09440000000000', 'GB']] as const) {
      const known: RecognitionOutcome[] = recognitionCandidates(number, { countryHint })
        .filter(({ carrier }) => ['dpd-uk', 'dpd', 'dpd-be'].includes(carrier))
        .map((candidate) => ({ ...candidate, status: 'known', lastActivityAt: '2026-09-09T10:00:00Z' }));
      expect(known.map(({ carrier }) => carrier).sort(), number).toEqual(['dpd', 'dpd-be', 'dpd-uk']);
      expect(settleRecognition(known, new Date('2026-09-10T12:00:00Z')), number).toEqual({ carrier: 'dpd-uk', choices: [] });
    }
  });
});

it('recognizes every lettered Intelcom series', () => {
  for (const number of ['INTLCMD123456789', 'INTLCMJ123456789', 'INTLCMR123456789']) {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'intelcom', confidence: 'high' });
    expect(normalizeIntelcomNumber(number)).toBe(number);
    expect(parseTrackingInput(`Tracking number: ${number}`).trackingNumber).toBe(number);
    expect(detectCarrierMatch(`${number}0`).carrier).toBe('unknown');
  }
  expect(detectCarrierMatch('INTLCMJ12345678').carrier).toBe('unknown');
});

it('suggests Old Dominion for eleven-digit PROs only when the Luhn check passes', () => {
  // Synthetic PROs outside the prefixes Old Dominion's high rules claim.
  for (const number of ['12300000002', '45600000017']) {
    expect(detectCarrierMatch(number).candidates).toContain('old-dominion');
  }
  for (const number of ['12300000003', '45600000018', '1230000002', '123000000002']) {
    expect(detectCarrierMatch(number).candidates).not.toContain('old-dominion');
  }
});

it('selects Old Dominion by its PRO prefixes only when the Luhn check passes', () => {
  // Synthetic PROs on each prefix the high rules claim, and twins with another check digit.
  for (const number of ['07200000011', '77700000001', '77800000000', '78000000022']) {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'old-dominion', confidence: 'high' });
  }
  // DPD Romania's waybills share 80 and nine digits, so that prefix is only suggested.
  expect(detectCarrierMatch('80000000002')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
  expect(detectCarrierMatch('80000000002').candidates).toContain('old-dominion');
  for (const number of ['07200000012', '77700000002', '77800000001', '78000000023', '80000000003']) {
    expect(detectCarrierMatch(number).candidates).not.toContain('old-dominion');
  }
  expect(checksumRejections('77700000002')).toContainEqual({ carrier: 'old-dominion', rule: 'old-dominion-1', checksum: 'luhn' });
  expect(checksumRejections('80000000003')).toContainEqual({ carrier: 'old-dominion', rule: 'old-dominion-2', checksum: 'luhn' });
});

it('names UniUni for Canadian cross-border shipper references marked U and only suggests it for the rest', () => {
  for (const number of ['GV00CAA0U000000001', 'JY00CAA0U000000001']) {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'uniuni', confidence: 'high' });
  }
  for (const number of ['JY00CAA0D000000001', 'JY00CAA0T000000001', 'GV00USA0U000000001', 'JY00CA00A000000001']) {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['uniuni'] });
  }
  for (const number of ['GV00CAA1U000000001', 'GV00CAA0U00000001', 'G100CAA0U000000001', 'GV00CAA0U0000000001', 'GV00UKA0U000000001',
    'JY00CA00A00000001', 'JY00CA00B000000001', 'JY00US00A000000001', 'GV00CA00A000000001']) {
    expect(detectCarrierMatch(number).candidates).not.toContain('uniuni');
  }
});

describe('FedEx Ground Economy numbers', () => {
  // Made-up numbers: service type 612 or 748, a Mailer ID of nines and a serial.
  it('selects FedEx when the check digit passes with the USPS 92 channel in front', () => {
    for (const number of ['61299999999900000010', '74899999999900000023', '6129 9999 9999 0000 0010']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'fedex', confidence: 'high', candidates: ['fedex'] });
    }
  });

  it('leaves FedEx out for a failing check digit or another service type', () => {
    for (const number of ['61299999999900000011', '74899999999900000020']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['usps', 'nz-post'] });
      expect(checksumRejections(number)).toEqual([{ carrier: 'fedex', rule: 'fedex-ground-economy', checksum: 'fedex-ground-economy' }]);
    }
    for (const number of ['61399999999900000010', '61209999999900000010', '9261299999999900000010']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('fedex');
    }
  });
});

describe('Saia twelve-digit PRO numbers', () => {
  // Made-up PROs: ten digits, a 0, then the remainder of the ten divided by seven.
  it('suggests Saia when the twelfth digit checks the first ten', () => {
    for (const number of ['900000000005', '999999999903', '1234 5678 9003']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['saia']) });
      expect(checksumRejections(number).map(({ carrier }) => carrier), number).not.toContain('saia');
    }
  });

  it('leaves Saia out for a failing check digit, another eleventh digit or an eleven-digit PRO', () => {
    for (const number of ['900000000006', '900000000007', '999999999900']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('saia');
      expect(checksumRejections(number), number).toContainEqual({ carrier: 'saia', rule: 'saia-1', checksum: 'saia' });
    }
    for (const number of ['900000000015', '999999999913', '90000000000']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('saia');
      expect(checksumRejections(number).map(({ carrier }) => carrier), number).not.toContain('saia');
    }
  });
});

describe('Metropolitan Warehouse twelve-digit numbers', () => {
  // Made-up numbers across leading digits and check-digit outcomes; the tracker takes any twelve digits.
  const TWELVE = ['000000000000', '100000000009', '123456789012', '200000000000', '500000000013', '5000 0000 0013', '700000000000',
    '900000000005', '999999999999'];

  it('suggests Metropolitan for every twelve-digit number, beside the carriers that share the length', () => {
    for (const number of TWELVE) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low',
        candidates: expect.arrayContaining(['metropolitan-warehouse']) });
      expect(recognitionCandidates(number).map(({ carrier }) => carrier), number).toContain('metropolitan-warehouse');
      // The check is HTTP; the browser phase does not ask it.
      expect(recognitionCandidates(number, { phase: 'browser' }).map(({ carrier }) => carrier), number).not.toContain('metropolitan-warehouse');
    }
    // A US caller asks Metropolitan first; without a hint the commoner twelve-digit carriers come before it.
    expect(recognitionCandidates('500000000013', { countryHint: 'US' })[0]).toMatchObject({ carrier: 'metropolitan-warehouse', countryMatch: 'home' });
    expect(recognitionCandidates('500000000013').map(({ carrier }) => carrier).at(-1)).toBe('metropolitan-warehouse');
  });

  it('leaves Metropolitan out for other lengths and for letters', () => {
    for (const number of ['50000000001', '5000000000130', 'TRX500000000', 'A00000000013']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('metropolitan-warehouse');
    }
  });
});

describe('Pitney Bowes cross-border labels', () => {
  // Synthetic numbers in the three label layouts; none is a real parcel.
  it('names Pitney Bowes for its UPAA, hexadecimal UPBE and PBX labels', () => {
    for (const number of ['UPAAA000000000000001', 'UPBE0000000000ABCDEF', 'PBXSA000000001', 'PBXGA000000000ABCDEF']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'pitney-bowes', confidence: 'high', candidates: ['pitney-bowes'] });
    }
  });

  it('leaves Pitney Bowes out for other lengths, letters beyond hexadecimal and a missing service code', () => {
    for (const number of ['UPAAA00000000000001', 'UPAA0000000000000001', 'UPBE0000000000ABCDEG', 'UPBE0000000000ABCDE', 'PBXSA00000000', 'PBXS000000001', 'PBXGA000000000ABCDEFG']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('pitney-bowes');
    }
  });
});

describe('wave seven British courier rules', () => {
  it('suggests BJS Home Delivery for B and eleven digits, with or without the dash, without naming it', () => {
    for (const number of ['B0000001-0001', 'B00000010001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('bjs-home-delivery');
    }
    for (const number of ['B0000000001', 'B000000000001', 'C00000010001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('bjs-home-delivery');
    }
  });

  it('names One World Express for OWE and twelve digits', () => {
    expect(detectCarrierMatch('OWE000000000001')).toMatchObject({ carrier: 'one-world-express', confidence: 'high', candidates: ['one-world-express'] });
    for (const number of ['OWE00000000001', 'OWE0000000000001', 'OW0000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('one-world-express');
    }
  });

  it('names XLCourier for XLC and ten to twelve digits', () => {
    for (const number of ['XLC0000000001', 'XLC00000000001', 'XLC000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'xlcourier', confidence: 'high', candidates: ['xlcourier'] });
    }
    for (const number of ['XLC000000001', 'XLC0000000000001', 'XL00000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('xlcourier');
    }
  });
});

describe('wave eight British courier rules', () => {
  // Synthetic numbers in each carrier's layout; none is a real parcel.
  it('suggests Pro Carrier beside La Poste for DG and eleven digits without naming either', () => {
    expect(detectCarrierMatch('DG00000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['la-poste', 'pro-carrier'] });
    for (const number of ['DG0000000001', 'DG000000000001', 'DH00000000001', 'UBG000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('pro-carrier');
    }
  });
});

describe('GTA AirSkip references', () => {
  // Synthetic references in GTA AirSkip's layout; Intelcom's tracker also answers this shape.
  it('offers GTA AirSkip for GRG or GRS, five digits and eleven characters without naming it', () => {
    expect(detectCarrierMatch('GRG00001AAAAA000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['gta-airskip'] });
    for (const number of ['GRS00001AAAAA00000', 'GRX00001AAAAA000001', 'GRG0001AAAAAA000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('gta-airskip');
    }
  });
});

describe('Bringer Parcel Xpress references', () => {
  // Synthetic references in BPX's documented layout, which its tracker confirms for the documentation's own sample.
  it('offers Bringer Parcel Xpress for BPS and twelve or thirteen characters without naming it', () => {
    for (const number of ['BPS0000AAAA0000', 'BPS0000AAAA00000']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['bringer-parcel'] });
    }
    for (const number of ['BPS0000AAAA000', 'BPS0000AAAA000000', 'BPX0000AAAA0000']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('bringer-parcel');
    }
  });
});

describe('FedEx International Connect numbers', () => {
  // Made-up numbers in FIC's layout: three letters, four digits, the sending country and eleven digits.
  // Starlinks Global labels its parcels the same way, so FIC only comes first.
  it('puts FedEx International Connect first for its tracking number layout', () => {
    for (const number of ['ZZZ0000GB00000000017', 'ZZZ0000US00000000017', 'zzz 0000 gb 0000 0000 017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({
        carrier: 'unknown', confidence: 'low', candidates: ['fedex-international-connect', 'starlinks-global'], preferred: ['fedex-international-connect'],
      });
    }
    for (const number of ['ZZZ0000GB0000000001', 'ZZZ0000GB000000000017', 'ZZ00000GB00000000017', 'ZZZ00000B00000000017', 'ZZZ000GBB00000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [detectCarrierMatch(number).carrier], number).not.toContain('fedex-international-connect');
    }
  });
});

describe('Tusk Logistics labels', () => {
  it('names Tusk for TUSK and twelve letters or digits, and reads it from its tracking link', () => {
    expect(detectCarrierMatch('TUSK0ZZZ00000001')).toMatchObject({ carrier: 'tusk-logistics', confidence: 'high' });
    for (const number of ['TUSK0ZZZ0000001', 'TUSK0ZZZ000000001', 'TUSC0ZZZ00000001']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('tusk-logistics');
    }
    expect(parseTrackingInput('https://shipmenttracking.tusklogistics.com/?trackingNumber=TUSK0ZZZ00000001')).toMatchObject({
      trackingNumber: 'TUSK0ZZZ00000001', carrier: 'tusk-logistics', confidence: 'high', source: 'link',
    });
  });
});

describe('Veho tracking ids and label barcodes', () => {
  it('suggests Veho for VH tracking ids and VEHO facility barcodes without naming it', () => {
    for (const number of ['VH100000000017', 'VHA1B2C3D4E5F6', 'VEHOABC100000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['veho'] });
    }
    for (const number of ['VH10000000017', 'VH1000000000017', 'VEHOAB1100000017', 'VEHOABC10000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('veho');
    }
  });

  it('reads Veho tracking links from the query and from the page route', () => {
    for (const link of [
      'https://track.shipveho.com/#/trackingid/VH100000000017',
      'https://track.shipveho.com/?trackingId=VH100000000017',
    ]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'VH100000000017', carrier: 'veho', source: 'link' });
    }
  });
});

describe('Polonez label numbers and Yamato Transport U.S.A. links', () => {
  it('names Polonez for three letters, three digits, two letters and six digits', () => {
    expect(detectCarrierMatch('ABC123LE000017')).toMatchObject({ carrier: 'polonez', confidence: 'high' });
    for (const number of ['AB123LE000017', 'ABC12LE000017', 'ABC123L0000017', 'ABC123LE00001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('polonez');
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('polonez');
    }
  });

  it('reads Yamato Transport U.S.A. tracking links without naming it for a bare slip', () => {
    expect(parseTrackingInput('https://www.yamatoamerica.com/tracking/?slipnumber=100000000017')).toMatchObject({
      trackingNumber: '100000000017', carrier: 'yamato-america', source: 'link',
    });
    expect(detectCarrierMatch('100000000017').candidates ?? []).not.toContain('yamato-america');
  });
});

describe('Costco Logistics numbers, and RXO and Quality Post links', () => {
  it('names Costco Logistics for 1I, an order date and nine digits', () => {
    expect(detectCarrierMatch('1I20240115000000017')).toMatchObject({ carrier: 'costco-logistics', confidence: 'high' });
    for (const number of ['1I20241315000000017', '1I20240132000000017', '1I19240115000000017', '1I2024011500000001', 'II20240115000000017']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('costco-logistics');
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('costco-logistics');
    }
    expect(parseTrackingInput('https://logistics.costco.com/tracking?id=1I20240115000000017')).toMatchObject({
      trackingNumber: '1I20240115000000017', carrier: 'costco-logistics', source: 'link',
    });
  });

  it('reads RXO and Quality Post tracking links', () => {
    expect(parseTrackingInput('https://track.rxo.com/?trackingnumber=RXOL100000000017')).toMatchObject({
      trackingNumber: 'RXOL100000000017', carrier: 'rxo', source: 'link',
    });
    expect(parseTrackingInput('https://wstracking.qualitypost.com.mx/portal_seguimiento?info=ABC1000017')).toMatchObject({
      trackingNumber: 'ABC1000017', carrier: 'quality-post', source: 'link',
    });
  });
});

describe('City Air Express numbers, and AmeriShip, GIO Express and Sway links', () => {
  it('suggests City Air Express for MN and six digits beside other lettered numbers', () => {
    const match = detectCarrierMatch('MN000017');
    expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(match.candidates).toContain('city-air-express');
    for (const number of ['MN00001', 'MN0000170', 'MX000017', 'MNA00017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('city-air-express');
    }
    expect(parseTrackingInput('https://caebfs.netcourier.net/online/tracking/trackinginfo/MN000017')).toMatchObject({
      trackingNumber: 'MN000017', carrier: 'city-air-express', source: 'link',
    });
  });

  it('reads AmeriShip, Stat Overnight, GIO Express and Sway tracking links', () => {
    expect(parseTrackingInput('https://ameriship.com/track/?n=ABC1000017')).toMatchObject({
      trackingNumber: 'ABC1000017', carrier: 'ameriship', source: 'link',
    });
    expect(parseTrackingInput('https://statovernight.com/tracking-results/?tracking=ABC1000017')).toMatchObject({
      trackingNumber: 'ABC1000017', carrier: 'ameriship', source: 'link',
    });
    expect(parseTrackingInput('https://gioexpress.com/tracking/?tracking=100017&type=tracking')).toMatchObject({
      trackingNumber: '100017', carrier: 'gio-express', source: 'link',
    });
    expect(parseTrackingInput('https://track.shipsway.com/SWY-100000017')).toMatchObject({
      trackingNumber: 'SWY-100000017', carrier: 'sway', source: 'link',
    });
    expect(parseTrackingInput('https://track.shipsway.com/api').carrier).not.toBe('sway');
  });
});

describe('Obibox numbers and links', () => {
  it('names Obibox for XP, a shipper code, the order reference and the package index', () => {
    for (const number of ['XPABC1000000017_1', 'XPABCD10000A0017Q1']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'obibox', confidence: 'high' });
    }
    for (const number of ['XPAB1000000017_1', 'XPABC1000000017', 'XPABCDE1000000017_1', 'XPABC1000000017X1', 'XQABC1000000017_1']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('obibox');
    }
  });

  it('reads Obibox and Xpedigo tracking links', () => {
    for (const host of ['tracking.obibox.io', 'tracking.xpedigo.com']) {
      expect(parseTrackingInput(`https://${host}/XPABC1000000017_1`)).toMatchObject({
        trackingNumber: 'XPABC1000000017_1', carrier: 'obibox', source: 'link',
      });
    }
  });
});

describe('Piggy Express, Islandwide Express and Trans-Ontario Express', () => {
  it('reads their tracker links and names', () => {
    for (const [url, carrier] of [
      ['https://piggyexp.com/track?tracking=PG1000000017', 'piggy-express'],
      ['https://dsp-tracking.piggyship.com/?tracking=PG1000000017', 'piggy-express'],
      ['https://www.islandwide.com/tracking?TrackingNumber=PG1000000017', 'islandwide-express'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'PG1000000017', carrier, source: 'link' });
    }
    expect(carrierIdFromName('PiggyShip')).toBe('piggy-express');
    expect(carrierIdFromName('Islandwide')).toBe('islandwide-express');
    expect(carrierIdFromName('Trans Ontario')).toBe('trans-ontario');
  });
});

describe('Trexity, XGS and SAVAR Express links and names', () => {
  it('reads Trexity\'s number but not its token links, and XGS\'s probill from the fragment', () => {
    expect(parseTrackingInput('https://tracking.trexity.com/?t=AB3DE-FG7JK')).toMatchObject({ trackingNumber: 'AB3DE-FG7JK', carrier: 'trexity', source: 'link' });
    expect(parseTrackingInput('https://tracking.trexity.com/?token=AB3DEFG7JK').carrier ?? 'none').not.toBe('trexity');
    expect(parseTrackingInput('https://www.xgsi.com/#track-shipment=12345670')).toMatchObject({ trackingNumber: '12345670', carrier: 'xgs', source: 'link' });
    expect(carrierIdFromName('Xpress Global Systems')).toBe('xgs');
    expect(carrierIdFromName('Simple Express S.A.C.')).toBe('savar-express');
    expect(carrierIdFromName('Trexity Inc.')).toBe('trexity');
  });
});

describe('Optima Overnight, Whiz Delivery and four other North American carriers', () => {
  it('suggests Optima Overnight beside TransMission for P and fourteen digits', () => {
    expect(detectCarrierMatch('P10000000000017')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('P10000000000017').candidates).toEqual(expect.arrayContaining(['optima-overnight', 'transmission']));
    for (const number of ['P1000000000017', 'P100000000000017', 'T10000000000017', 'PX0000000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('optima-overnight');
    }
  });

  it('suggests Whiz Delivery for SW and ten hexadecimal characters', () => {
    for (const number of ['SW1A2B3C4D5E', 'sw 1a2b3c4d5e']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('whiz-delivery');
    }
    for (const number of ['SW1A2B3C4D5G', 'SW1A2B3C4D5', 'SW1A2B3C4D5E6', 'SX1A2B3C4D5E']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('whiz-delivery');
    }
  });

  it('reads their tracker links and names', () => {
    for (const [url, number, carrier] of [
      ['https://www.shipoptima.com/pages/tracking?tracking=P10000000000017', 'P10000000000017', 'optima-overnight'],
      ['https://shipoptima.com/tracking/?trackingNumber=P10000000000017', 'P10000000000017', 'optima-overnight'],
      ['https://track.whizdelivery.ca/track/SW1A2B3C4D5E', 'SW1A2B3C4D5E', 'whiz-delivery'],
      ['https://track.plyconvanlines.com/singletrack.php?trackingnum=100000000000000000017', '100000000000000000017', 'plycon'],
      ['https://www.peninsulatruck.com/track/?pro_number=100000017', '100000017', 'peninsula-truck-lines'],
      ['https://tracking.carrierlogistics.com/scripts/rxic.pol/boldetail.htm?wbtn=PRO&wpro1=1000017', '1000017', 'ross-express'],
      ['https://www.atshealthcare.ca/quickTrackResult?ship=100000017', '100000017', 'ats-healthcare'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
    expect(carrierIdFromName('Optima Courier, Inc.')).toBe('optima-overnight');
    expect(carrierIdFromName('Whiz Delivery Inc.')).toBe('whiz-delivery');
    expect(carrierIdFromName('Plycon Van Lines')).toBe('plycon');
    expect(carrierIdFromName('Peninsula Truck Lines, Inc.')).toBe('peninsula-truck-lines');
    expect(carrierIdFromName('Ross Express LLC')).toBe('ross-express');
    expect(carrierIdFromName('Andlauer Transportation Services')).toBe('ats-healthcare');
  });
});

describe('Wizmo, toyou, APG eCommerce Solutions and AMS eGroup', () => {
  it('suggests Wizmo for WD and ten digits only', () => {
    expect(detectCarrierMatch('WD1000000017')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('WD1000000017').candidates).toContain('wizmo');
    for (const number of ['WD100000017', 'WD10000000017', 'WA1000000017', 'WZM1000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('wizmo');
    }
  });

  it('leaves toyou parcel IDs to the carriers that share their layout', () => {
    expect(detectCarrierMatch('MMAP100000017').candidates ?? []).not.toContain('toyou');
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://shipwizmo.com/tracking/WD1000000017')).toMatchObject({ trackingNumber: 'WD1000000017', carrier: 'wizmo', source: 'link' });
    expect(parseTrackingInput('https://www.toyou.co.uk/track/MMAP100000017')).toMatchObject({ trackingNumber: 'MMAP100000017', carrier: 'toyou', source: 'link' });
    expect(parseTrackingInput('https://apgecommerce.com/track-result/?track_sequenceNo=10000000017'))
      .toMatchObject({ trackingNumber: '10000000017', carrier: 'apg-ecommerce', source: 'link' });
    expect(carrierIdFromName('Wizmo Solutions Inc.')).toBe('wizmo');
    expect(carrierIdFromName('toYou by ASDA')).toBe('toyou');
    expect(carrierIdFromName('APG eCommerce Solutions')).toBe('apg-ecommerce');
    expect(carrierIdFromName('Aramex Global Solutions')).toBe('apg-ecommerce');
    expect(carrierIdFromName('eRetail Logistics')).toBe('ams-egroup');
  });
});

describe('Hart2Hart Express, Kart2Door and Top Logistics Australia', () => {
  it('leaves Hart2Hart job numbers to the carriers that share nine digits', () => {
    expect(detectCarrierMatch('800000017').candidates ?? []).not.toContain('hart2hart-express');
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://harttohart.couriernavigator-secure.com/tracking?consign_note=800000017'))
      .toMatchObject({ trackingNumber: '800000017', carrier: 'hart2hart-express', source: 'link' });
    expect(parseTrackingInput('https://www.kart2door.com/EcomTracking?axb=XYZ10000017'))
      .toMatchObject({ trackingNumber: 'XYZ10000017', carrier: 'kart2door', source: 'link' });
    expect(parseTrackingInput('https://toplogistics.com.au/?s=TLA10000017'))
      .toMatchObject({ trackingNumber: 'TLA10000017', carrier: 'top-logistics-au', source: 'link' });
    expect(carrierIdFromName('Hart 2 Hart Express')).toBe('hart2hart-express');
    expect(carrierIdFromName('Kart 2 Door')).toBe('kart2door');
    expect(carrierIdFromName('Top Logistics Australia')).toBe('top-logistics-au');
    expect(carrierIdFromName('ISS Parcels')).toBe('elta');
  });
});

describe('Linear Logistics and DeliverDirect', () => {
  it('reads their tracker links and names', () => {
    for (const url of ['https://linearlogistics.co.uk/tracking?q=7000000017', 'https://tracking.linearlogistics.co.uk/?q=7000000017']) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: '7000000017', carrier: 'linear-logistics', source: 'link' });
    }
    expect(parseTrackingInput('https://www.deliverdirect.com/EcomTracking?axb=DD10000017'))
      .toMatchObject({ trackingNumber: 'DD10000017', carrier: 'deliverdirect', source: 'link' });
    expect(carrierIdFromName('Parcelink Logistics')).toBe('linear-logistics');
    expect(carrierIdFromName('Delta DeliverDirect')).toBe('deliverdirect');
  });

  it('leaves Linear Logistics numbers to the carriers that claim ten digits', () => {
    // Its numbers are DX's secure-delivery references.
    expect(detectCarrierMatch('7000000017').candidates ?? []).not.toContain('linear-logistics');
  });
});

describe('SkyBox, Délivro, TForce Integrated Solutions, UBX UK and TTK Europe', () => {
  it('reads their trackers\' links', () => {
    for (const [url, trackingNumber, carrier] of [
      ['https://www.skybox.net/TrackingInformation/IndexPublic?tracking=005100000001', '005100000001', 'skybox'],
      ['https://delivro.dsapp.io/customer/ZZ00000001', 'ZZ00000001', 'delivro'],
      ['https://tforce-solutions.com/quick-tracking/?tracking=100000001', '100000001', 'tforce-integrated-solutions'],
      ['https://www.ubx.uk.net/tracking/?consign_note=100000001', '100000001', 'ubx-uk'],
      ['https://ubx.couriernavigator-secure.com/tracking?consign_note=100000001', '100000001', 'ubx-uk'],
      ['https://ttkeu.com/tracking/tracking-detail/?id=TE000000001GB', 'TE000000001GB', 'ttk-europe'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber, carrier, source: 'link' });
    }
  });

  it('names them from their names, and keeps the other TForce companies apart', () => {
    expect(carrierIdFromName('SkyBOX')).toBe('skybox');
    expect(carrierIdFromName('Delivero')).toBe('delivro');
    expect(carrierIdFromName('TForce Solutions')).toBe('tforce-integrated-solutions');
    expect(carrierIdFromName('TForce Logistics')).toBe('tforce-logistics');
    expect(carrierIdFromName('United Business Xpress')).toBe('ubx-uk');
    expect(carrierIdFromName('天天欧洲物流')).toBe('ttk-europe');
  });

  it('leaves their bare numbers to other carriers\' rules', () => {
    expect(detectCarrierMatch('005100000001').candidates ?? []).not.toContain('skybox');
    expect(detectCarrierMatch('100000001').candidates ?? []).not.toContain('tforce-integrated-solutions');
  });
});

describe('Zinc, LTL KR, Jiaying Express and Okay Parcel', () => {
  it('suggests Zinc for ZPY, two letters, ten digits and YQ, and nothing near it', () => {
    expect(detectCarrierMatch('ZPYAB1234567890YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['znlogic'] });
    for (const number of ['ZPYA11234567890YQ', 'ZPYAB123456789YQ', 'ZPYAB12345678901YQ', 'ZPYAB1234567890YZ', 'ZPXAB1234567890YQ']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('znlogic');
    }
  });

  it('reads their names and tracking links', () => {
    for (const [name, carrier] of [
      ['ZNLOGIC', 'znlogic'], ['Zinc Tracking', 'znlogic'], ['LTL중국배대지', 'ltl-kr'], ['佳赢物流', 'jiaying-express'],
      ['EAE Global', 'okay-parcel'], ['RRD International Logistics', 'epost-global'], ['B2C Europe', 'maersk-ecommerce'],
      ['Ask Axl', 'arrow-xl'], ['SZTY56', 'topyou'],
    ] as const) expect(carrierIdFromName(name), name).toBe(carrier);
    expect(parseTrackingInput('https://tracking.link/tracking?tracking_id=ZPYAB1234567890YQ'))
      .toMatchObject({ trackingNumber: 'ZPYAB1234567890YQ', carrier: 'znlogic', source: 'link' });
    expect(parseTrackingInput('http://sys.okayparcel.com/okp/webapps/showtracking.php?q=OK1000000017'))
      .toMatchObject({ trackingNumber: 'OK1000000017', carrier: 'okay-parcel', source: 'link' });
  });
});

import { describe, expect, it } from 'vitest';
import { DETECTION_RULE_IDS } from '../../generated/catalog.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { recognitionAskedCarriers } from '../catalog/recognition.js';
import { checksumFailures } from './detect.js';
import {
  checksumRejections,
  detectCarrier,
  detectCarrierMatch,
  formatTrackingNumber,
  isValidDpdParcelNumber,
  isValidGlsParcelNumber,
  isValidHermesParcelNumber,
  isValidMondialRelayBarcode,
  isValidS10TrackingNumber,
  normalizeTrackingNumber,
  parseTrackingInput,
  supportsSwissPostHandoff,
  validTrackingNumber,
} from './index.js';

/**
 * The per-carrier number expectations live in src/lib/carriers.test.ts until
 * the corpus sweep replaces them. What this file pins down is the engine
 * itself, and in particular the one behaviour that had two implementations
 * before the move: the server copy of the S10 check skipped normalization.
 */
describe('S10, with one implementation for the client and the server', () => {
  it('agrees with the former server implementation on already-normalized input', () => {
    expect(isValidS10TrackingNumber('RA123456785CH')).toBe(true);
    expect(isValidS10TrackingNumber('RA123456789CH')).toBe(false);
    expect(isValidS10TrackingNumber('RA12345678CH')).toBe(false);
    expect(supportsSwissPostHandoff('LW230226618CH')).toBe(true);
    expect(supportsSwissPostHandoff('LW230226619CH')).toBe(false);
    expect(supportsSwissPostHandoff('RR230226618CH')).toBe(false);
  });

  it('now also accepts the printed spelling the server copy used to reject', () => {
    expect(isValidS10TrackingNumber('ra 123.456-785 ch')).toBe(true);
    expect(supportsSwissPostHandoff('lw 230 226 618 ch')).toBe(true);
  });
});

describe('Chronopost numbers with an S10 check digit', () => {
  it.each(['XR123456785TS', 'XT123456785TS', 'XT123456785FR', 'XR123456785DE'])('selects Chronopost for %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chronopost', confidence: 'high', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('keeps a mistyped number a Chronopost suggestion rather than international mail', () => {
    expect(detectCarrierMatch('XT123456789TS')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers('XT123456789TS')).toEqual(['chronopost']);
  });

  it.each(['RR123456785TS', 'RR123456785JF', 'RR123456785JB', 'NP123456789JB', 'HL123456789JF'])(
    'selects Chronopost for %s, whose suffix is its own rather than a country',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chronopost', confidence: 'high', candidates: ['chronopost'] });
      expect(recognitionAskedCarriers(number)).toEqual([]);
      expect(checksumRejections(number)).toEqual([]);
    },
  );

  it.each(['RR123456785RV', 'RR123456785VF'])('asks Chronopost about %s, a rarer suffix of its own', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers(number)).toEqual(['chronopost']);
    expect(checksumRejections(number)).toEqual([]);
  });
});

describe('Taiwanese S10 items', () => {
  it.each(['CP123456785TW', 'EE123456785TW', 'FT123456785TW', 'FZ123456785TW', 'LX123456785TW', 'RR123456785TW'])('names Chunghwa Post, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chunghwa-post', confidence: 'high', candidates: ['chunghwa-post'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves letter post, which its tracker does not follow online, to international mail', () => {
    for (const number of ['UA123456785TW', 'UH123456785TW', 'UX123456785TW']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    }
    expect(detectCarrierMatch('UH123456785CN').candidates).not.toContain('chunghwa-post');
  });

  it('names nobody for a failed check digit', () => {
    expect(detectCarrierMatch('LX123456780TW').candidates).not.toContain('chunghwa-post');
  });
});

describe('Australian S10 items', () => {
  it.each(['CF123456785AU', 'EY123456785AU', 'LH123456785AU'])('names Australia Post, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'australia-post', confidence: 'high', candidates: ['australia-post'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves registered and letter-post items to international mail, asking Australia Post first', () => {
    for (const number of ['RR123456785AU', 'UH123456785AU']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
      expect(recognitionAskedCarriers(number)[0], number).toBe('australia-post');
    }
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('EY123456780AU').candidates).not.toContain('australia-post');
    expect(detectCarrierMatch('EY123456785NZ').candidates).not.toContain('australia-post');
  });
});

describe('Slovak S10 items', () => {
  it.each(['CP123456785SK', 'EE123456785SK', 'LK123456785SK', 'RR123456785SK'])('names Slovenská pošta, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'slovenska-posta', confidence: 'high', candidates: ['slovenska-posta'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    expect(detectCarrierMatch('UH123456785SK')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('UH123456785SK')[0]).toBe('slovenska-posta');
  });

  it('names nobody for a failed check digit', () => {
    expect(detectCarrierMatch('LK123456780SK').candidates).not.toContain('slovenska-posta');
  });
});

describe('Croatian S10 items', () => {
  it.each(['CP123456785HR', 'EE123456785HR', 'LW123456785HR', 'RR123456785HR'])('names Hrvatska pošta, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'hrvatska-posta', confidence: 'high', candidates: ['hrvatska-posta'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    for (const number of ['UH123456785HR', 'VV123456785HR']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
      expect(recognitionAskedCarriers(number)[0], number).toBe('hrvatska-posta');
    }
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('CP123456780HR').candidates).not.toContain('hrvatska-posta');
    expect(detectCarrierMatch('CP123456785HU').candidates).not.toContain('hrvatska-posta');
  });
});

describe('UAE S10 items', () => {
  it.each(['CP123456785AE', 'EE123456785AE', 'LW123456785AE', 'RR123456785AE'])('names Emirates Post, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'emirates-post', confidence: 'high', candidates: ['emirates-post'] });
  });

  it('leaves its other items to international mail', () => {
    expect(detectCarrierMatch('UA123456785AE')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('CP123456780AE').candidates).not.toContain('emirates-post');
    expect(detectCarrierMatch('CP123456785AT').candidates).not.toContain('emirates-post');
  });
});

describe('Polish S10 items', () => {
  it.each(['CP123456785PL', 'EE123456785PL', 'LX123456785PL', 'RR123456785PL'])('names Poczta Polska, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'poczta-polska', confidence: 'high', candidates: ['poczta-polska'] });
  });

  it.each(['VV123456785PL', 'CV123456785PL'])('leaves %s to international mail', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('LX123456784PL').candidates).not.toContain('poczta-polska');
    expect(detectCarrierMatch('LX123456785CZ').candidates).not.toContain('poczta-polska');
  });
});

describe('Estonian S10 items', () => {
  it.each(['CC123456785EE', 'EE123456785EE', 'LL123456785EE', 'RC123456785EE'])('names Omniva, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'omniva', confidence: 'high', candidates: ['omniva'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  // Meest gives these series for parcels to Ukraine, and Omniva's tracker has answered none of them.
  it.each(['RO123456785EE', 'CR123456785EE', 'CV123456785EE', 'UA123456785EE'])('leaves %s to international mail and asks Omniva about it', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers(number)[0]).toBe('omniva');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('RC123456784EE').candidates).not.toContain('omniva');
    expect(detectCarrierMatch('RC123456785LT').candidates).not.toContain('omniva');
  });
});

describe('Slovenian S10 items', () => {
  it.each(['CA123456785SI', 'EE123456785SI', 'LZ123456785SI', 'RA123456785SI'])('names Pošta Slovenije, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'posta-slovenije', confidence: 'high', candidates: ['posta-slovenije'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    expect(detectCarrierMatch('UA123456785SI')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('UA123456785SI')[0]).toBe('posta-slovenije');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('RA123456784SI').candidates).not.toContain('posta-slovenije');
    expect(detectCarrierMatch('RA123456785SK').candidates).not.toContain('posta-slovenije');
  });
});

describe('Serbian S10 items', () => {
  it.each(['CE123456785RS', 'ED123456785RS', 'LX123456785RS', 'RR123456785RS'])('names Pošta Srbije, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'posta-srbije', confidence: 'high', candidates: ['posta-srbije'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  // M-ONE gives its parcels P series numbers with the same code.
  it('leaves its other items to international mail and asks it first, then M-ONE', () => {
    expect(detectCarrierMatch('PL123456785RS')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('PL123456785RS')[0]).toBe('posta-srbije');
    expect(recognitionAskedCarriers('PL123456785RS')).toContain('m-one');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('RR123456784RS').candidates).not.toContain('posta-srbije');
    expect(detectCarrierMatch('RR123456785RU').candidates).not.toContain('posta-srbije');
  });
});

describe('Ukrainian S10 items', () => {
  it.each(['CR123456785UA', 'EE123456785UA', 'LZ123456785UA', 'RB123456785UA'])('names Ukrposhta, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'ukrposhta', confidence: 'high', candidates: ['ukrposhta'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it first', () => {
    expect(detectCarrierMatch('UA123456785UA')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('UA123456785UA')[0]).toBe('ukrposhta');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('CR123456784UA').candidates).not.toContain('ukrposhta');
    expect(detectCarrierMatch('CR123456785RU').candidates).not.toContain('ukrposhta');
  });
});

describe('Italian S10 items', () => {
  it.each(['CE123456785IT', 'CP123456785IT', 'EE123456785IT', 'LC123456785IT', 'RN123456785IT'])('names Poste Italiane, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'poste-italiane', confidence: 'high', candidates: ['poste-italiane'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    for (const number of ['KK123456785IT', 'UB123456785IT']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
      expect(recognitionAskedCarriers(number)[0], number).toBe('poste-italiane');
    }
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('CP123456780IT').candidates).not.toContain('poste-italiane');
    expect(detectCarrierMatch('CP123456785IL').candidates).not.toContain('poste-italiane');
  });
});

describe('Latvian S10 items', () => {
  it.each(['CC123456785LV', 'EE123456785LV', 'LY123456785LV', 'RR123456785LV'])('names Latvijas Pasts, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'latvijas-pasts', confidence: 'high', candidates: ['latvijas-pasts'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    expect(detectCarrierMatch('UH123456785LV')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('UH123456785LV')[0]).toBe('latvijas-pasts');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('RR123456780LV').candidates).not.toContain('latvijas-pasts');
    expect(detectCarrierMatch('RR123456785LT').candidates).not.toContain('latvijas-pasts');
  });
});

describe('Deutsche Post Frankier-IDs', () => {
  it.each(['A0123456789ABCDEF01F', 'A000000000000000000A'])('names DHL, whose letter tracking answers %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'dhl', confidence: 'high', candidates: ['dhl'] });
    expect(detectCarrierMatch(number.toLowerCase())).toMatchObject({ carrier: 'dhl', confidence: 'high' });
  });

  it('names nobody for a failed check character, another order mark or a number without letters', () => {
    for (const number of ['A0123456789ABCDEF010', 'A0123456789ABCDEF01G', 'B0123456789ABCDEF01F', 'A0123456789ABCDEF01', '00123456789012345670']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('dhl');
    }
    expect(checksumFailures('A0123456789ABCDEF010')).toContainEqual(expect.objectContaining({ carrier: 'dhl', rule: 'dhl-15' }));
  });
});

describe('normalization', () => {
  it('uppercases and strips the separators carriers print', () => {
    expect(normalizeTrackingNumber(' ra 123 456-789 ch ')).toBe('RA123456789CH');
    expect(formatTrackingNumber('993412345612345678')).toBe('99.34.123456.12345678');
  });

  it('reads an SSCC printed behind its bracketed GS1 identifier', () => {
    expect(normalizeTrackingNumber('(00) 3 7012345 678901234 7')).toBe('00370123456789012347');
    expect(validTrackingNumber('(00) 3 7012345 678901234 7')).toBe(true);
    expect(detectCarrierMatch('(00) 3 7012345 678901234 7')).toEqual(detectCarrierMatch('00370123456789012347'));
    expect(parseTrackingInput('(00) 370123456789012347')).toMatchObject({ source: 'number', candidates: detectCarrierMatch('00370123456789012347').candidates });
  });

  it('reads a number whose label prints its last digit in brackets, as PIN AG’s does', () => {
    expect(normalizeTrackingNumber('100000000000(1)')).toBe('1000000000001');
    expect(normalizeTrackingNumber('0100 1234 5678 901(2)')).toBe('0100123456789012');
    expect(parseTrackingInput('010012345678901(2)')).toMatchObject({ source: 'number', preferred: ['pin-ag'],
      candidates: detectCarrierMatch('0100123456789012').candidates });
    // A digit run too short for a parcel number, or a bracketed group of more than one digit, stays as typed.
    for (const raw of ['12345678901(2)', '123456789012(34)']) expect(validTrackingNumber(raw)).toBe(false);
  });

  it('reads a letter O typed in an S10 serial as the zero its check digit asks for', () => {
    expect(normalizeTrackingNumber('cio 0000000 5nl')).toBe('CI000000005NL');
    expect(detectCarrierMatch('CIO00000005NL')).toEqual(detectCarrierMatch('CI000000005NL'));
    expect(detectCarrierMatch('CIO00000005NL').confidence).not.toBe('none');
    // A serial whose check digit fails either way stays as typed.
    expect(normalizeTrackingNumber('CIO00000001NL')).toBe('CIO00000001NL');
  });

  it('reads a letter O typed after JD as the zero of a DHL Express piece', () => {
    for (const typed of ['jdo 146 12345678901234', 'JJDO14612345678901234', 'JDO14612345678901234J']) {
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'dhl-express', confidence: 'high' });
    }
    expect(normalizeTrackingNumber('jdo 146 12345678901234')).toBe('JD014612345678901234');
    // Only the piece's own length and range: anything else stays as typed.
    for (const typed of ['JDO24612345678901234', 'JDO1461234567890123', 'JDOA4612345678901234']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('drops the slashes of a NO LIMIT shipment number, which reads the same without them', () => {
    for (const typed of ['P/40017/LSMP/2026', ' p/40017/lsmp/2026 ', 'P40017/LSMP/2026', 'P 40017 LSMP 2026']) {
      expect(normalizeTrackingNumber(typed), typed).toBe('P40017LSMP2026');
      expect(validTrackingNumber(typed), typed).toBe(true);
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'no-limit', confidence: 'high', candidates: ['no-limit'] });
    }
    expect(parseTrackingInput('Numer przesyłki: P/40017/LSMP/2026, dostawa jutro')).toMatchObject({ source: 'text', trackingNumber: 'P/40017/LSMP/2026', carrier: 'no-limit' });
    // Another layout keeps its slashes, and stays no number.
    for (const typed of ['P/40017/SMP/2026', 'P//LSMP/2026', 'P/40017/LSMP/1999', 'Q/40017/LSMP/2026']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
      expect(validTrackingNumber(typed), typed).toBe(false);
    }
  });

  it('accepts one underscore inside a number, as Better Trucks writes its BTS_ numbers', () => {
    expect(normalizeTrackingNumber(' bts_0123smpl002 ')).toBe('BTS_0123SMPL002');
    expect(validTrackingNumber(' bts_0123smpl002 ')).toBe(true);
    expect(parseTrackingInput('BTS_0123SMPL002')).toMatchObject({ source: 'number', trackingNumber: 'BTS_0123SMPL002' });
    for (const raw of ['_BTS0123SMPL002', 'BTS0123SMPL002_', 'BTS__0123SMPL002', 'BTS_0123_SMPL002', 'BTS_SMPL']) {
      expect(validTrackingNumber(raw), raw).toBe(false);
    }
  });

  it('leaves other bracketed GS1 identifiers as typed', () => {
    // (420) carries the destination ZIP, which is no parcel number.
    for (const raw of ['(420) 12345', '(420) 12345 (92) 612 90 100 13043 50825 07', '(00) 37012345678901234', '(01) 09501101530003']) {
      expect(normalizeTrackingNumber(raw)).toContain('(');
      expect(validTrackingNumber(raw)).toBe(false);
      expect(detectCarrierMatch(raw).confidence).toBe('none');
    }
  });
});

describe('the detection engine', () => {
  it('selects a carrier only when exactly one rule claims high confidence', () => {
    expect(detectCarrier('RA123456785CH')).toBe('swiss-post');
    expect(detectCarrierMatch('RA123456785CH')).toMatchObject({ carrier: 'swiss-post', confidence: 'high' });
    expect(detectCarrierMatch('')).toEqual({ carrier: 'unknown', confidence: 'none', candidates: [], preferred: [] });
  });

  it('rejects a number whose declared checksum does not verify', () => {
    expect(detectCarrier('RA123456789CH')).toBe('unknown');
    expect(isValidMondialRelayBarcode('12123456780101006623123454')).toBe(true);
    expect(isValidMondialRelayBarcode('12123456780101006623123455')).toBe(false);
  });

  it('checks the Hermes digit before offering Hermes for a 14-digit number', () => {
    expect(isValidHermesParcelNumber('12345678901231')).toBe(true);
    expect(isValidHermesParcelNumber('12345678901234')).toBe(false);
    expect(isValidHermesParcelNumber('1234567890123')).toBe(false);
    expect(detectCarrierMatch('12345678901231').candidates).toContain('hermes-de');
    expect(detectCarrierMatch('12345678901234').candidates).not.toContain('hermes-de');
  });

  it('suggests Hermes first for fourteen digits from 022 with a passing Hermes digit, wherever the parcel comes from', () => {
    for (const number of ['02200000000002', '02270000000012', '02299999999992']) {
      const detected = detectCarrierMatch(number);
      expect(detected, number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['hermes-de'] });
      expect(detected.candidates?.[0], number).toBe('hermes-de');
      for (const countryHint of [undefined, 'DE', 'IT']) expect(recognitionAskedCarriers(number, { countryHint })[0], number).toBe('hermes-de');
    }
    for (const number of ['02200000000003', '02300000000009']) expect(detectCarrierMatch(number).preferred ?? [], number).not.toContain('hermes-de');
  });

  it('offers Hermes for a barcode starting 0 typed after another zero, and asks it first in Germany', () => {
    expect(detectCarrierMatch('001234567890128')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('001234567890128').candidates).toContain('hermes-de');
    expect(recognitionAskedCarriers('001234567890128', { countryHint: 'DE' })[0]).toBe('hermes-de');
    for (const number of ['001234567890129', '012345678901231', '0001234567890128']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('hermes-de');
    }
  });

  it('offers GLS for a 12-digit number only when its check digit passes', () => {
    // 11 digits, weights 3-1 from the right plus one: 12345678901 → 1.
    expect(isValidGlsParcelNumber('123456789011')).toBe(true);
    expect(isValidGlsParcelNumber('123456789012')).toBe(false);
    expect(isValidGlsParcelNumber('12345678901')).toBe(false);
    expect(detectCarrierMatch('123456789011').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de', 'gls-fr']));
    expect(detectCarrierMatch('123456789012').candidates).not.toContain('gls-de');
    // 11 digits are the same parcel number without its check digit.
    expect(detectCarrierMatch('12345678901').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de', 'gls-fr']));
  });

  it('keeps GLS to its 11- and 12-digit parcel numbers', () => {
    expect(detectCarrierMatch('123456789011').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de']));
    expect(detectCarrierMatch('1234567890123').candidates).not.toEqual(expect.arrayContaining(['gls-ch']));
    expect(detectCarrierMatch('12345678901234').candidates).not.toEqual(expect.arrayContaining(['gls-de']));
  });

  it('lists the carrier a depot prefix points to first, without selecting it', () => {
    // DPD numbers start with the depot that printed the label: 0600-0619 is
    // DPD Switzerland, 10xx DPD France. Other 14-digit carriers stay candidates.
    expect(detectCarrierMatch('06080000000002')).toMatchObject({
      carrier: 'unknown', confidence: 'low', preferred: ['dpd'],
      candidates: ['dpd', 'dpd-fr', 'chronopost', 'ciblex', 'seur', 'brt', 'dhl-ecommerce-uk', 'dpd-be', 'dpd-de', 'dpd-hu', 'dpd-nl', 'dpd-pt', 'dpd-uk'],
    });
    // DPD Switzerland's forms ask for numbers starting with 060.
    for (const number of ['06000000000003', '06030000000002', '06190000000001']) {
      expect(detectCarrierMatch(number)).toMatchObject({ confidence: 'low', preferred: ['dpd'] });
    }
    expect(detectCarrierMatch('10000000000001')).toMatchObject({
      carrier: 'unknown', confidence: 'low', preferred: ['dpd-fr'],
    });
    expect(detectCarrierMatch('10000000000001').candidates[0]).toBe('dpd-fr');
    // DPD Austria's depot codes prefer it; a code its depot list skips stays a plain DPD shape.
    expect(detectCarrierMatch('06200000000002')).toMatchObject({ confidence: 'low', preferred: ['dpd-at'] });
    expect(detectCarrierMatch('06310000000002')).toMatchObject({ confidence: 'low', preferred: [] });
  });

  it('reads a number out of a pasted carrier link', () => {
    expect(parseTrackingInput('https://service.post.ch/ekp-web/ui/entry/search/RA123456785CH'))
      .toMatchObject({ trackingNumber: 'RA123456785CH', carrier: 'swiss-post', source: 'link' });
  });

  it('reads a GETOnline link on the shared host as SkyNet only for its own stid', () => {
    for (const link of ['https://tracking.frontierforce.com/go/plm-tracking?stid=skynet&cn=ZZ0000000000',
      'https://tracking.frontierforce.com/go/plm-tracking?cn=ZZ0000000000&stid=skynet']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'ZZ0000000000', carrier: 'skynet-worldwide', source: 'link' });
    }
    for (const link of ['https://tracking.frontierforce.com/go/plm-tracking?stid=rr&cn=1000000001',
      'https://tracking.frontierforce.com/go/plm-tracking?stid=skynetx&cn=1000000001',
      'https://tracking.frontierforce.com/go/plm-tracking?cn=1000000001']) {
      expect(parseTrackingInput(link)?.carrier, link).not.toBe('skynet-worldwide');
    }
  });

  it.each(['PH000000000001', 'SPXPH000000000001'])(
    'reads the SPX Philippines portal bare query: %s', (number) => {
      expect(parseTrackingInput(`https://spx.ph/track?${number}`)).toMatchObject({
        trackingNumber: number, carrier: 'spx-ph', confidence: 'high', source: 'link',
      });
    },
  );

  it('names SPX Express Brazil for BR and thirteen characters, from a number or its tracker links', () => {
    for (const number of ['BR250471826359A', 'BR2504718263591']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'spx-br', confidence: 'high' });
    }
    for (const number of ['BR25047182635', 'BR250471826359AB', 'RB250471826359A']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('spx-br');
    }
    for (const link of ['https://spx.com.br/track?BR250471826359A', 'spx.com.br/track?BR250471826359A',
      'Seu pedido: www.spx.com.br/detail/BR250471826359A.']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'BR250471826359A', carrier: 'spx-br', source: 'link' });
    }
  });

  it('reads a link printed without its scheme only on a host a link rule names', () => {
    expect(parseTrackingInput('(spx.ph/track?PH407182635901)')).toMatchObject({
      trackingNumber: 'PH407182635901', carrier: 'spx-ph', source: 'link',
    });
    for (const text of ['example.com/track?PH407182635901', 'a@spx.ph/track?PH407182635901', 'spx.ph.example.com/track?PH407182635901']) {
      expect(parseTrackingInput(text).source, text).not.toBe('link');
    }
  });

  it('decodes an SPX bare query without admitting another path, host or query syntax', () => {
    expect(parseTrackingInput('https://spx.ph/track?%50%48000000000001')).toMatchObject({
      trackingNumber: 'PH000000000001', carrier: 'spx-ph', source: 'link',
    });
    for (const url of [
      'https://spx.ph/other?PH000000000001',
      'https://spx.ph.example.com/track?PH000000000001',
      'https://spx.ph/track?unknown=PH000000000001',
      'https://spx.ph/track?PH000000000001&PH000000000002',
      'https://spx.ph/track?PH000000000001%2CPH000000000002',
    ]) {
      expect(parseTrackingInput(url).carrier).not.toBe('spx-ph');
    }
  });

  it('reads a trans-o-flex barcode, but no shipper reference, from a guest tracker link', () => {
    for (const query of [
      'type=barcode&ref=100000000000000004900000',
      'ref=100000000000000004900000&type=barcode&zip=00000&streetno=0',
    ]) {
      expect(parseTrackingInput(`https://www.trans-o-flex.com/sendungsverfolgung/tracking?${query}`)).toMatchObject({
        trackingNumber: '100000000000000004900000', carrier: 'trans-o-flex', source: 'link',
      });
    }
    expect(parseTrackingInput('https://www.trans-o-flex.com/sendungsverfolgung/tracking?ref=ABC-0001&type=ref').carrier)
      .not.toBe('trans-o-flex');
  });

  it('binds Nova Poshta through the current official tracking path', () => {
    expect(parseTrackingInput('https://novaposhta.ua/en/tracking/59000000000001/')).toMatchObject({
      trackingNumber: '59000000000001', carrier: 'nova-poshta', confidence: 'high', source: 'link',
    });
  });

  it.each(['87001234567890', '870012345678049'])('selects La Poste for numeric tracked mail: %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'la-poste', confidence: 'high' });
    expect(parseTrackingInput(`Suivi : ${number}`)).toMatchObject({
      trackingNumber: number, carrier: 'la-poste', confidence: 'high', source: 'text',
    });
    expect(parseTrackingInput(`https://www.laposte.fr/outils/suivre-vos-envois?code=${number}`))
      .toMatchObject({ trackingNumber: number, carrier: 'la-poste', source: 'link' });
  });

  it.each([
    'Tracking number: 12345678901',
    'Tracking number 12345678901',
    'Your tracking number is 12345678901.',
    'tracking no. 12345678901',
    'Tracking ID: 12345678901',
    'Tracking: 12345678901',
    'track 12345678901',
    'Parcel number: 12345678901',
    'Shipment tracking number: 12345678901',
    'Tracking update. Your parcel number 12345678901 leaves today',
  ])('reads the number a label introduces: %s', (text) => {
    expect(parseTrackingInput(text)).toMatchObject({ trackingNumber: '12345678901', source: 'text', confidence: 'low' });
  });

  it.each([
    'Votre numéro de suivi est le 12345678.',
    'Votre colis n°12345678 arrive demain',
    'Ihre Sendungsnummer lautet 12345678.',
    'Dein Paket mit der Sendungsnummer 12345678 kommt morgen',
    'Su número de seguimiento es 12345678',
    'Il tuo numero di tracciamento è 12345678',
    'O código de rastreio é 12345678',
    'Twój numer przesyłki: 12345678 jest w drodze',
    'Je zending 12345678 is onderweg',
  ])('reads the number a label introduces in other languages: %s', (text) => {
    expect(parseTrackingInput(text)).toMatchObject({ trackingNumber: '12345678', source: 'text', confidence: 'low' });
  });

  it('reads the groups a number prints apart in a message', () => {
    expect(parseTrackingInput('Your tracking number is 1Z 999 AA1 01 2345 6784 and it ships today'))
      .toMatchObject({ trackingNumber: '1Z999AA10123456784', carrier: 'ups', confidence: 'high', source: 'text' });
    for (const text of ['Votre colis numéro 1234 5678 9012 sera livré demain', 'Sendungsnummer 1234 5678 9012 wird morgen zugestellt.']) {
      expect(parseTrackingInput(text), text).toMatchObject({ trackingNumber: '123456789012', source: 'text' });
    }
    // A long number keeps no short one after it, and short groups that make no number are none.
    expect(parseTrackingInput('Tracking 1234567899 12 Teile').trackingNumber).toBe('1234567899');
    for (const text of ['Parcel 12 34 or so', 'Colis 123 45 euros']) expect(parseTrackingInput(text).source, text).toBe('none');
  });

  it('takes no number from a label that offers two, nor a date', () => {
    for (const text of ['Tracking number 5555666677 or 7777888899', 'Sendung 12.10.2026', 'Votre colis du 12/10/2026',
      'Tracking 1234 5678 or 9999 8888', 'Suivi colis 12 10 2026 merci']) {
      expect(parseTrackingInput(text)).toMatchObject({ trackingNumber: '', source: 'none' });
    }
  });

  it('keeps a label word attached to the number, and takes no word for a number', () => {
    expect(parseTrackingInput('Tracking NO123456789').trackingNumber).toBe('NO123456789');
    expect(parseTrackingInput('tracking notable1234').trackingNumber).toBe('notable1234');
    expect(parseTrackingInput('Tracking number: pending').source).toBe('none');
    expect(parseTrackingInput('Shipment tracking: delayed').source).toBe('none');
  });

  it.each([
    ['Abholcode 123456', '123456'],
    ['Abholcode: 123456', '123456'],
    ['Pickup code 123456', '123456'],
    ['Sendungsnummer 0034 0434 1234 5678', '0034 0434 1234 5678'],
    ['Tracking number: 0034 0434 1234 5678', '0034 0434 1234 5678'],
    ['Nr. 12345678', '12345678'],
    ['N° de suivi 12345678', '12345678'],
    ['N°12345678', '12345678'],
    ['Numéro de suivi : 12345678', '12345678'],
    ['numéro de colis 12345678', '12345678'],
    ['Suivi: 12345678', '12345678'],
    ['Trackingnummer: 12345678', '12345678'],
    ['Nº de seguimiento: 12345678', '12345678'],
    ['número de envío 12345678', '12345678'],
    ['numero di tracciamento 12345678', '12345678'],
    ['n.º de rastreio 12345678', '12345678'],
    ['Numer przesyłki 12345678', '12345678'],
    ['Número de rastreo: 12345678', '12345678'],
    ['Número de guía 12345678', '12345678'],
    ['Guía: 12345678', '12345678'],
    ['WAYBILL 1234567890', '1234567890'],
    ['WAYBILL1234567890', '1234567890'],
    ['Tracking1234567890', '1234567890'],
    ['AWB No. 1234567890', '1234567890'],
  ])('leaves a label word out of a short entry: %s', (input, number) => {
    expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: number, source: 'text' });
  });

  it('reads a waybill named in a message', () => {
    for (const input of ['Your DHL waybill 1234567890 is ready', 'Waybill No. 1234567890 has shipped', 'Tu número de guía es 1234567890']) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: '1234567890', source: 'text' });
    }
  });

  it('reads no Amazon number from a word before ten digits, and still reads Amazon\'s capitals before them', () => {
    for (const input of ['Su número de seguimiento es 1234567890', 'Tracking No. 1234567890', 'TRACKING NO. 1234567890', 'Your parcel No. 1234567890 has shipped']) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: '1234567890', carrier: 'unknown', source: 'text' });
    }
    for (const input of ['Track it 1234567890 today', 'Order No. 1234567890']) {
      expect(parseTrackingInput(input).carrier).not.toBe('amazon-logistics');
    }
    for (const [input, number] of [['Tracking ID: DE1234567890', 'DE1234567890'], ['Your parcel: FR 0000-000001', 'FR 0000-000001'],
      ['Your parcel TBA 1234 5678 9012 is on its way', 'TBA 1234 5678 9012']] as const) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: number, carrier: 'amazon-logistics', source: 'text' });
    }
  });

  it('reads no entry with a word in it whole', () => {
    expect(parseTrackingInput('Suivi colis 12345678')).toMatchObject({ trackingNumber: '12345678', source: 'text' });
    expect(parseTrackingInput('Ihre Bestellung 12345678')).toMatchObject({ trackingNumber: '', source: 'none' });
    expect(parseTrackingInput('1Z 999 AA1 01 2345 6784')).toMatchObject({ carrier: 'ups', source: 'number' });
  });

  it('takes no other number a label names for the tracking number', () => {
    for (const input of ['numéro de commande 12345678', 'número de pedido 12345678', 'suivi 5555666677 ou 7777888899', 'Order number 12345678',
      'Bestellnummer 12345678', 'Commande n° 12345678', 'Telefonnummer 0612345678', 'Customer ID: 12345678']) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: '', source: 'none' });
    }
  });

  it('keeps a short entry whole when its letters are no label word, or touch the digits', () => {
    // Letters a carrier prints apart from its digits stay on the number.
    for (const input of ['QZX 123456', 'ABCD 1234567', 'LP 00123456789012', '1111 2222 3333 4444', '1Z 999 AA1 01 2345 6784', 'abholcode123456', 'AWB1234567890']) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: input, source: 'number' });
    }
  });

  it.each(['or', 'oder', 'ou', 'o', 'of', 'lub'])('reads no single number from two numbers joined by "%s"', (word) => {
    expect(parseTrackingInput(`5555666677 ${word} 7777888899`)).toMatchObject({ trackingNumber: '', source: 'none' });
  });

  it('keeps other numeric carriers ambiguous', () => {
    expect(detectCarrierMatch('123456789012345')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('87979.0061660090')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('06080000000002').candidates[0]).toBe('dpd');
  });

  it('recognizes the PostLogistics printed reference without claiming every 11-digit number', () => {
    expect(parseTrackingInput('12345678-001')).toMatchObject({
      trackingNumber: '12345678-001', carrier: 'postlogistics', confidence: 'high', source: 'number',
    });
    expect(detectCarrier('12345678001')).not.toBe('postlogistics');
    expect(parseTrackingInput('https://tracking.postlogistics.ch/public/trackandtrace/12345678-001'))
      .toMatchObject({ trackingNumber: '12345678-001', carrier: 'postlogistics', source: 'link' });
    // Its tracking page moved to Swiss Post Cargo's tracker, whose links keep the reference with it.
    expect(parseTrackingInput('https://apv.swisspost-cargo.com/public/trackandtrace/12345678-001'))
      .toMatchObject({ trackingNumber: '12345678-001', carrier: 'postlogistics', source: 'link' });
    expect(formatTrackingNumber('12345678001', 'postlogistics')).toBe('12345678-001');
    expect(formatTrackingNumber('12345678001')).toBe('12345678001');
  });

  it('suggests Swiss Post Cargo for a PL reference, printed or compact, and asks it to confirm', () => {
    // TNT Italy's national waybills have the compact shape too, so both are asked.
    for (const number of ['PL-12345678', 'pl12345678']) {
      expect(parseTrackingInput(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['swiss-post-cargo', 'tnt-it'] });
      expect(recognitionAskedCarriers(number)).toEqual(['tnt-it', 'swiss-post-cargo']);
    }
    for (const number of ['PL-1234567', 'PL-123456789', 'PX-12345678']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('swiss-post-cargo');
    }
  });

  it('reads Swiss Post Cargo links from both tracker hosts, keeping a reference as printed', () => {
    for (const host of ['apv', 'tt']) {
      expect(parseTrackingInput(`https://${host}.swisspost-cargo.com/public/trackandtrace/AB-12345678`))
        .toMatchObject({ trackingNumber: 'AB-12345678', carrier: 'swiss-post-cargo', confidence: 'high', source: 'link' });
    }
  });
});

describe('carrier links limited to some pages of their host', () => {
  // Each page form the rule reads, ending in its number parameter, and another page of the host.
  it.each([
    ['brt', '99000000000002', [
      'https://vas.brt.it/vas/sped_det_new.htm?lang=en&brtCode=',
      'https://vas.brt.it/vas/sped_det_show.htm?brtCode=',
    ], 'https://vas.brt.it/vas/orm_det_show.htm?brtCode='],
    ['seur', '9900002', [
      'https://www.seur.com/miseur/mis-envios?tracking=',
      'https://www.seur.com/miseur/mis-envios/detalle?tracking=',
      'https://seur.com/en/miseur/mis-envios?tracking=',
    ], 'https://www.seur.com/envio-online/?tracking='],
    ['tipsa', '0990010990010000000017', [
      'https://www.tip-sa.com/cliente/datos_env.php?id=',
      'https://aplicaciones.tip-sa.com/cliente/datos.php?id=',
      'https://www.tip-sa.com/cliente/datos_prestashop.php?id=',
    ], 'https://www.tip-sa.com/contacto.php?id='],
    ['nacex', '9900/99000002', [
      'https://www.nacex.es/seguimientoFormularioExterno.do?intcli=',
      'https://nacex.es/seguimientoFormularioExterno.do;jsessionid=TEST?intcli=',
    ], 'https://www.nacex.es/irCerca.do?intcli='],
    ['estafeta', '9000000001', [
      'https://cs.estafeta.com/es/Tracking/searchByGet?isShipmentDetail=True&wayBill=',
      'https://cs.estafeta.com/en/Tracking/searchByGet/?wayBill=',
    ], 'https://cs.estafeta.com/es/Tracking/GetTrackingItemHistory?wayBill='],
    ['the-courier-guy', 'TESTA1', [
      'https://portal.thecourierguy.co.za/track?ref=',
      'https://track.thecourierguy.co.za/?ref=',
      'https://track.thecourierguy.co.za/track/?ref=',
    ], 'https://portal.thecourierguy.co.za/request-invoice?ref='],
    ['ppl', '29000000001', [
      'https://www.ppl.cz/?form=track-and-trace&shipmentId=',
      'https://www.ppl.cz/vyhledat-zasilku?shipmentId=',
      'https://www.ppl.cz/en/track-a-shipment?shipmentId=',
    ], 'https://www.ppl.cz/zasilky?shipmentId='],
    ['fukuyama', '12345678901', [
      'https://seikyu.fukuyama-tsuun.com/corp/tracking_no_hunt/',
      'https://corp.fukutsu.co.jp/corp/recieve/tracking_no_hunt/',
      'https://corp.fukutsu.co.jp/situation/tracking_no_hunt/',
    ], 'https://seikyu.fukuyama-tsuun.com/corp/'],
  ])('%s', (carrier, number, pages, other) => {
    // A reference detection alone does not recognize shows that the rule read it.
    for (const page of pages) {
      for (const reference of [number, 'TESTA1']) {
        expect(parseTrackingInput(`${page}${reference}`)).toMatchObject({
          trackingNumber: reference, carrier, confidence: 'high', source: 'link',
        });
      }
    }
    const { pathname, search } = new URL(`${other}TESTA1`);
    expect(parseTrackingInput(`${other}TESTA1`)).toEqual(parseTrackingInput(`https://example.test${pathname}${search}`));
    expect(parseTrackingInput(`${other}TESTA1`).carrier).not.toBe(carrier);
  });

  it('reads DHL Express waybills on its tracking page, and leaves DHL Paket its own numbers there', () => {
    const page = 'https://www.logistics.dhl/it-it/home/tracking/tracking-express.html?submit=1&tracking-id=';
    expect(parseTrackingInput(`${page}1234567891`)).toMatchObject({
      trackingNumber: '1234567891', carrier: 'dhl-express', confidence: 'high', source: 'link',
    });
    expect(parseTrackingInput(`${page}CX123456785DE`)).toMatchObject({
      trackingNumber: 'CX123456785DE', carrier: 'dhl', confidence: 'high', source: 'link',
    });
    const other = 'https://www.logistics.dhl/it-it/home/tracking.html?tracking-id=1234567891';
    expect(parseTrackingInput(other)).toEqual(parseTrackingInput('https://example.test/it-it/home/tracking.html?tracking-id=1234567891'));
  });

  it('reads TNT consignments on tnt.com tracking pages, and leaves other numbers there to detection', () => {
    for (const page of [
      'https://www.tnt.com/express/it_it/site/shipping-tools/tracking.html?searchType=con&cons=',
      'https://www.tnt.com/express/en_gb/site/shipping-tools/tracking.html?respCountry=gb&respLang=en&searchType=CON&cons=',
      'https://www.tnt.com/express/es_es/site/herramientas-envio/seguimiento.html?searchType=CON&cons=',
      'https://www.tnt.com/express/fr_fr/site/outils-expedition/suivi.html?searchType=con&cons=',
      'https://www.tnt.com/express/it_ch/site/strumenti-spedizione/tracking.html?searchType=con&cons=',
      'https://www.tnt.com/express/es_es/site/herramientas-envio/seguimiento.html?cons=',
    ]) {
      // tnt.com completes an eight-digit serial with its check digit, as the adapter does.
      for (const number of ['123456785', 'GE123456785WW', '12345678']) {
        expect(parseTrackingInput(`${page}${number}`)).toMatchObject({ trackingNumber: number, carrier: 'tnt', confidence: 'high', source: 'link' });
      }
      expect(parseTrackingInput(`${page}123456789`).carrier).not.toBe('tnt');
      expect(parseTrackingInput(`${page}1234567`).carrier).not.toBe('tnt');
    }
    // The page's share link.
    expect(parseTrackingInput('https://www.tnt.com/track?cons=12345678&searchType=CON&source=share'))
      .toMatchObject({ trackingNumber: '12345678', carrier: 'tnt', confidence: 'high', source: 'link' });
    // A search by the sender's reference holds no consignment number.
    for (const number of ['12345678', '123456785']) {
      expect(parseTrackingInput(`https://www.tnt.com/express/es_es/site/herramientas-envio/seguimiento.html?searchType=REF&cons=${number}`).carrier).not.toBe('tnt');
      expect(parseTrackingInput(`https://www.tnt.com/track?cons=${number}&searchType=ref`).carrier).not.toBe('tnt');
    }
  });

  it('reads the Freightways networks’ receiver and ITNG links, keeping a customer printed label’s consignment number', () => {
    for (const [carrier, domain, code] of [
      ['nz-couriers', 'nzcouriers.co.nz', 'nzc'],
      ['post-haste', 'posthaste.co.nz', 'phl'],
      ['castle-parcels', 'castleparcels.co.nz', 'cpl'],
      ['now-couriers', 'nowcouriers.co.nz', 'now'],
    ] as const) {
      const read = (url: string, trackingNumber: string) => expect(parseTrackingInput(url), url)
        .toMatchObject({ trackingNumber, carrier, confidence: 'high', source: 'link' });
      read(`https://receiver.${domain}/?consignmentid=CU..ZZZ047193.Z.0000000.1`, 'ZZZ047193');
      read(`https://receiver.${domain}/?consignmentId=CU..ZZZZ0471935.Z.ZZZZZZ0.1`, 'ZZZZ0471935');
      read(`https://receiver.${domain}/?track=ZZ%2004719352`, 'ZZ 04719352');
      read(`https://receiver.${domain}/?Key_Type=Charge&label_number=04719352`, '04719352');
      read(`https://tools.${domain}/${code}/servlet/ITNG_TAndTServlet?page=1&VCCA=Enabled&Key_Type=CustomerLabel`
        + '&customer_number=0000000&consignment_id=ZZZ047193', 'ZZZ047193');
      // A ticket's or charge label's composite names no number a tracker reads.
      expect(parseTrackingInput(`https://receiver.${domain}/?track=FW.TK..ZZ.04719352`).carrier).not.toBe(carrier);
    }
  });
});

describe('delivering partners\' links', () => {
  it.each([
    ['bpost', 'https://track.bpost.cloud/etr/light/performSearch.do?searchByItemCode=true&itemCodes='],
    ['poste-italiane', 'https://www.sda.it/wps/portal/Servizi_online/dettaglio-spedizione?locale=it&tracing.letteraVettura='],
  ])('%s %s', (carrier, page) => {
    expect(parseTrackingInput(`${page}TESTA1`)).toMatchObject({ trackingNumber: 'TESTA1', carrier, confidence: 'high', source: 'link' });
  });
});

describe('checksum rejections', () => {
  it('names the rule whose failed checksum kept its carrier out of the suggestions', () => {
    const waybill = { carrier: 'dhl-express', rule: 'dhl-express-waybill', checksum: 'dhl-express' };
    expect(checksumRejections('1234567890')).toEqual([{ carrier: 'acs-courier', rule: 'acs-courier-1', checksum: 'mod7' }, waybill,
      { carrier: 'geniki-taxydromiki', rule: 'geniki-taxydromiki-1', checksum: 'mod7' }]);
    // ACS and Geniki Taxydromiki print ten plain digits.
    expect(checksumRejections('1 234 567-890')).toEqual([waybill]);
    expect(checksumRejections('1234567891')).toEqual([]);
    expect(checksumRejections('RA123456789CH')).toContainEqual({ carrier: 'swiss-post', rule: 'swiss-post-1', checksum: 's10' });
    expect(checksumRejections('RA123456785CH')).toEqual([]);
    expect(checksumRejections('')).toEqual([]);
  });

  it('judges each number on its own check digit', () => {
    // The same 12 digits fail Yamato's mod 7 with one last digit and FedEx's check with the next.
    expect(checksumRejections('123456789012').map(({ rule }) => rule)).toContain('yamato-1');
    expect(checksumRejections('123456789012').map(({ carrier }) => carrier)).not.toContain('fedex');
    expect(checksumRejections('123456789013').map(({ rule }) => rule)).toContain('fedex-1');
    expect(checksumRejections('123456789013').map(({ carrier }) => carrier)).not.toContain('yamato');
    for (const number of ['1234567890', '123456789012', '123456789013', '123456789012345']) {
      const { candidates } = detectCarrierMatch(number);
      expect(checksumRejections(number).filter(({ carrier }) => candidates.includes(carrier))).toEqual([]);
    }
  });

  it('leaves out a carrier that another of its rules still suggests', () => {
    // A failed UPS check keeps UPS among the suggestions through its shape-only rule.
    expect(detectCarrierMatch('1Z999AA10123456785').candidates).toEqual(['ups']);
    expect(checksumRejections('1Z999AA10123456785')).toEqual([]);
  });

  it('leaves out a low-confidence rule that a high-confidence match would hide even if it passed', () => {
    expect(checksumRejections('123456789012345')).toContainEqual({ carrier: 'dpd', rule: 'dpd-3', checksum: 'dpd' });
    // DPD France's 250 range selects DPD France, which hides DPD's suggestion whatever its check says.
    expect(isValidDpdParcelNumber('250123456789010')).toBe(false);
    expect(detectCarrierMatch('250123456789010')).toMatchObject({ carrier: 'dpd-fr', confidence: 'high' });
    expect(checksumRejections('250123456789010')).toEqual([]);
  });

  it('lists every failed check, including those another carrier\'s match hides', () => {
    // For the callers whose carrier's adapter applies the check itself.
    expect(checksumFailures('250123456789010')).toContainEqual({ carrier: 'dpd', rule: 'dpd-3', checksum: 'dpd' });
    expect(checksumFailures('1 234 567-890')).toEqual(checksumRejections('1 234 567-890'));
    expect(checksumFailures('1234567891')).toEqual([]);
    expect(checksumFailures('')).toEqual([]);
    for (const number of ['1234567890', '123456789012', '123456789013', '123456789012345', '250123456789010', 'RA123456789CH']) {
      expect(checksumFailures(number)).toEqual(expect.arrayContaining(checksumRejections(number)));
    }
  });

  it('has one id for each catalog rule', () => {
    for (const [carrier, definition] of Object.entries(CARRIER_DEFINITIONS)) {
      expect(DETECTION_RULE_IDS[carrier as keyof typeof DETECTION_RULE_IDS]).toHaveLength(definition.detectionRules.length);
    }
  });
});

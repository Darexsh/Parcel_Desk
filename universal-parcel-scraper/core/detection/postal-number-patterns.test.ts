import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { isCttExpressTrackingNumber } from './cttExpress.js';
import { checksumRejections, detectCarrierMatch, parseTrackingInput } from './index.js';
import { carrierIdFromName } from '../catalog/hints.js';

describe('S10-shaped numbers', () => {
  it.each(['RR123456785TY', 'RR123456785MI', 'RR123456785XX', 'RR123456785YW', 'RR123456785CS', 'RR123456785EN'])(
    'leaves %s out of international mail: its suffix names no issuing country',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates).not.toContain('intl-post');
      expect(recognitionAskedCarriers(number)).not.toContain('intl-post');
      expect(checksumRejections(number)).toEqual([]);
    },
  );

  it('suggests AliExpress first for a TY number, a suffix Cainiao gives AliExpress parcels', () => {
    expect(detectCarrierMatch('rr 123 456 785 ty')).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['aliexpress', 'chronopost'], preferred: ['aliexpress'],
    });
    expect(recognitionCandidates('RR123456785TY')).toEqual([
      { carrier: 'aliexpress', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(detectCarrierMatch('RR123456789TY').candidates).toEqual([]);
    expect(checksumRejections('RR123456789TY')).toEqual([{ carrier: 'aliexpress', rule: 'aliexpress-ty', checksum: 's10' },
      { carrier: 'chronopost', rule: 'chronopost-3', checksum: 's10' }]);
  });

  it('suggests AliExpress first for an MI number, a suffix Cainiao gives an AliExpress parcel', () => {
    expect(detectCarrierMatch('rr 123 456 785 mi')).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['aliexpress', 'chronopost'], preferred: ['aliexpress'],
    });
    expect(recognitionCandidates('RR123456785MI')).toEqual([
      { carrier: 'aliexpress', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(detectCarrierMatch('RR123456789MI').candidates).toEqual([]);
    expect(checksumRejections('RR123456789MI')).toEqual([{ carrier: 'aliexpress', rule: 'aliexpress-mi', checksum: 's10' },
      { carrier: 'chronopost', rule: 'chronopost-3', checksum: 's10' }]);
  });

  it('suggests AliExpress first for an XX number, a suffix Cainiao gives an AliExpress parcel', () => {
    expect(detectCarrierMatch('rr 123 456 785 xx')).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['aliexpress', 'chronopost'], preferred: ['aliexpress'],
    });
    expect(recognitionCandidates('RR123456785XX')[0]).toEqual({ carrier: 'aliexpress', needsInput: null, preferred: true });
    expect(detectCarrierMatch('RR123456789XX').candidates).toEqual([]);
    expect(checksumRejections('RR123456789XX')).toEqual([{ carrier: 'aliexpress', rule: 'aliexpress-xx', checksum: 's10' },
      { carrier: 'chronopost', rule: 'chronopost-3', checksum: 's10' }]);
    for (const number of ['RR12345678XX', 'RR1234567850XX', 'R1234567850XX']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('aliexpress');
    }
  });

  it('suggests MailAmericas first for a Marshall Islands number, under which MailAmericas issues its S10 numbers', () => {
    for (const number of ['ML123456785MH', 'EE123456785MH']) {
      expect(detectCarrierMatch(number), number).toEqual({
        carrier: 'unknown', confidence: 'low', candidates: ['mailamericas', 'chronopost'], preferred: ['mailamericas'],
      });
      expect(recognitionCandidates(number)[0], number).toEqual({ carrier: 'mailamericas', needsInput: null, preferred: true });
    }
    expect(detectCarrierMatch('ML123456789MH').candidates).not.toContain('mailamericas');
    expect(checksumRejections('ML123456789MH')).toEqual([{ carrier: 'chronopost', rule: 'chronopost-3', checksum: 's10' },
      { carrier: 'mailamericas', rule: 'mailamericas-s10', checksum: 's10' }]);
    expect(detectCarrierMatch('ML12345678MH').candidates).not.toContain('mailamericas');
  });

  it('keeps a country suffix with no dedicated post in international mail', () => {
    expect(detectCarrierMatch('RR123456785GE')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
  });

  it('names DHL for Deutsche Post registered letters whose check digit holds', () => {
    for (const number of ['RR123456785DE', 'rk 123 456 785 de']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'dhl', confidence: 'high', candidates: ['dhl'] });
    }
    expect(detectCarrierMatch('RR123456789DE').candidates).not.toContain('dhl');
    expect(detectCarrierMatch('RR123456789DE').candidates).not.toContain('intl-post');
    expect(checksumRejections('RR123456789DE')).toEqual([{ carrier: 'dhl', rule: 'dhl-14', checksum: 's10' },
      { carrier: 'chronopost', rule: 'chronopost-3', checksum: 's10' }]);
    // Other German-issued services stay international mail.
    expect(detectCarrierMatch('EE123456785DE')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
  });

  it('names DHL for Deutsche Post items without customer tracking whose check digit holds', () => {
    for (const number of ['UL123456785DE', 'ux 123 456 785 de']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'dhl', confidence: 'high', candidates: ['dhl'] });
    }
    expect(detectCarrierMatch('UL123456789DE').candidates).not.toContain('dhl');
    expect(checksumRejections('UL123456789DE')).toContainEqual({ carrier: 'dhl', rule: 'dhl-16', checksum: 's10' });
    // Deutsche Post's offices abroad also issue UU under DE: the postal answer stays.
    expect(detectCarrierMatch('UU123456785DE')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(detectCarrierMatch('UL123456785AT').carrier).not.toBe('dhl');
  });

  it('asks Poczta Polska first about a Polish-issued number it does not own without selecting it', () => {
    expect(detectCarrierMatch('vv 123 456 785 pl')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionCandidates('vv 123 456 785 pl')).toEqual([
      { carrier: 'poczta-polska', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionAskedCarriers('VV123456789PL')).not.toContain('poczta-polska');
  });

  it('asks Correo Argentino first about an Argentine-issued number without selecting it', () => {
    expect(detectCarrierMatch('hc 123 456 785 ar')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionCandidates('hc 123 456 785 ar')).toEqual([
      { carrier: 'correo-argentino', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionAskedCarriers('HC123456789AR')).not.toContain('correo-argentino');
  });

  it('asks the national posts first about the S10 numbers they issue without selecting them', () => {
    const posts = { PK: 'pakistan-post', SA: 'saudi-post', UY: 'correo-uruguayo', KG: 'kyrgyz-post', BF: 'la-poste-burkina-faso', ID: 'pos-indonesia',
      CO: '4-72', SN: 'la-poste-senegal', MZ: 'corre' };
    for (const [country, post] of Object.entries(posts)) {
      expect(detectCarrierMatch(`rr 123 456 785 ${country}`), country).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
      expect(recognitionCandidates(`RR123456785${country}`)[0], country).toEqual({ carrier: post, needsInput: null, preferred: true });
      // A failing check digit or another post's suffix does not suggest it.
      expect(recognitionAskedCarriers(`RR123456789${country}`), country).not.toContain(post);
      expect(recognitionAskedCarriers('RR123456785AR'), country).not.toContain(post);
    }
  });

  it('asks EMS Vietnam first about the EMS items Vietnam issues, not the national post’s other items', () => {
    expect(detectCarrierMatch('ee 123 456 785 vn')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionCandidates('EE123456785VN')[0]).toEqual({ carrier: 'ems-vietnam', needsInput: null, preferred: true });
    for (const number of ['EE123456789VN', 'RR123456785VN', 'CC123456785VN']) {
      expect(recognitionAskedCarriers(number), number).not.toContain('ems-vietnam');
    }
  });

  it('asks Australia Post and Ukrposhta first about the numbers they issue without selecting them', () => {
    expect(detectCarrierMatch('rr 123 456 785 au')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionCandidates('rr 123 456 785 au')).toEqual([
      { carrier: 'australia-post', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionAskedCarriers('RR123456789AU')).not.toContain('australia-post');
    expect(detectCarrierMatch('PA123456785UA')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionCandidates('PA123456785UA')).toEqual([
      { carrier: 'ukrposhta', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionAskedCarriers('PA123456789UA')).not.toContain('ukrposhta');
  });

  it('names USPS for the parcels, EMS, registered and tracked-letter items it issues', () => {
    for (const number of ['EC123456785US', 'LV123456785US', 'RR123456785US', 'CP123456785US', 'lz 123 456 785 us']) {
      expect(detectCarrierMatch(number), number).toEqual({ carrier: 'usps', confidence: 'high', candidates: ['usps'], preferred: [] });
    }
    for (const number of ['EC123456789US', 'LV123456784US']) expect(detectCarrierMatch(number).candidates, number).not.toContain('usps');
  });

  it('offers USPS its other US-issued numbers in the browser phase only', () => {
    // Meest's CV codes and a CDEK Forward CE code stay with international mail.
    for (const number of ['CV123456785US', 'CE123456785US', 'VV123456785US']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
      expect(recognitionAskedCarriers(number), number).not.toContain('usps');
      expect(recognitionCandidates(number, { phase: 'browser' }), number).toEqual([
        { carrier: 'usps', needsInput: null, preferred: true },
      ]);
    }
    expect(recognitionCandidates('VV123456789US', { phase: 'browser' })).toEqual([]);
    // Asendia USA's own numbers keep their carrier.
    expect(detectCarrierMatch('AS123456785US')).toMatchObject({ carrier: 'asendia', confidence: 'high' });
    expect(recognitionCandidates('AS123456785US', { phase: 'browser' })).toEqual([]);
  });
});

describe('Korea Post domestic numbers', () => {
  it('suggests Korea Post for thirteen digits that start with 1 to 6', () => {
    for (const number of ['1000000000001', '3000000000001', '5000000000001', '6000000000001']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates).toContain('korea-post');
    }
    for (const number of ['0000000000001', '7000000000001', '100000000001', '10000000000001']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('korea-post');
    }
  });
});

describe('Magyar Posta numbers', () => {
  it('suggests Magyar Posta first for a domestic number whose check digit holds', () => {
    expect(detectCarrierMatch('pn zzz 0000 0013')).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['magyar-posta'], preferred: ['magyar-posta'],
    });
    expect(detectCarrierMatch('PNZZZ00000014')).toMatchObject({ confidence: 'none', candidates: [] });
    expect(checksumRejections('PNZZZ00000014')).toEqual([{ carrier: 'magyar-posta', rule: 'magyar-posta-domestic', checksum: 'magyar-posta' }]);
    // A numeric customer code also fits La Poste's two-characters-and-eleven-digits rule.
    expect(detectCarrierMatch('PB00000000013').candidates).toEqual(['magyar-posta', 'la-poste']);
    expect(detectCarrierMatch('PB00000000014').candidates).toEqual(['la-poste']);
  });

  it('suggests Magyar Posta for its sixteen-character domestic letters and its MPL Europe Standard numbers', () => {
    for (const number of ['RL00000000000013', 'rl 0000 000 000 001 2', 'JJH30ZZZZZPL00000001', 'JJH12A1B2C3D4E5F6G7H']) {
      expect(detectCarrierMatch(number), number).toEqual({
        carrier: 'unknown', confidence: 'low', candidates: ['magyar-posta'], preferred: ['magyar-posta'],
      });
      expect(recognitionAskedCarriers(number), number).not.toContain('magyar-posta');
      expect(recognitionCandidates(number, { phase: 'browser' }).map(({ carrier }) => carrier), number).toEqual(['magyar-posta']);
    }
    for (const number of ['RL0000000000001', 'RL000000000000013', 'RX00000000000013', 'RL0000000000001A', 'JJH30ZZZZZPL0000001', 'JJH30ZZZZZPL000000012', 'JJD30ZZZZZPL00000001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('magyar-posta');
    }
  });

  it('suggests Magyar Posta first for a package number: the shipment number, a package index and ten digits', () => {
    expect(detectCarrierMatch('PNZZZ000000130010000000000')).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['magyar-posta'], preferred: ['magyar-posta'],
    });
    expect(recognitionCandidates('PNZZZ000000130010000000000', { phase: 'browser' }).map(({ carrier }) => carrier)).toEqual(['magyar-posta']);
    for (const number of ['PNZZZ00000013001000000000', 'PNZZZ0000001300100000000000', 'PNZZZ00000013001000000000A', 'P0ZZZ000000130010000000000']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('magyar-posta');
    }
  });

  it('keeps a Hungarian S10 number in international mail and asks Magyar Posta, whose tracker needs a solved checkbox, in the browser phase only', () => {
    expect(detectCarrierMatch('RR123456785HU')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    for (const number of ['RR123456785HU', 'PNZZZ00000013', 'PB00000000013']) {
      expect(recognitionAskedCarriers(number)).not.toContain('magyar-posta');
      expect(recognitionCandidates(number, { phase: 'browser' }).map(({ carrier }) => carrier)).toEqual(['magyar-posta']);
    }
    expect(checksumRejections('RR123456789HU')).toContainEqual({ carrier: 'magyar-posta', rule: 'magyar-posta-s10', checksum: 's10' });
  });
});

describe('Poste Italiane registered mail', () => {
  it('suggests Poste Italiane for twelve digits whose check digit holds, typed with or without the dash', () => {
    for (const number of ['990000000010', '99000000001-0', '99000000001 0']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates).toContain('poste-italiane');
      expect(checksumRejections(number).map(({ carrier }) => carrier)).not.toContain('poste-italiane');
    }
    // The check is the digit sum of the weighted total, 109 here, not the total itself.
    expect(detectCarrierMatch('990000001000').candidates).toContain('poste-italiane');
  });

  it('leaves out other lengths and a failed check digit', () => {
    for (const number of ['99000000001', '9900000000100', '990000000011', '990000001009']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('poste-italiane');
      expect(recognitionAskedCarriers(number, { countryHint: 'IT' })).not.toContain('poste-italiane');
    }
    expect(checksumRejections('990000001009')).toContainEqual({
      carrier: 'poste-italiane', rule: 'poste-italiane-registered', checksum: 'poste-italiane',
    });
  });

  it('keeps a valid FedEx number first and asks Poste Italiane before the unchecked twelve-digit carriers', () => {
    expect(detectCarrierMatch('990000001000')).toMatchObject({ preferred: ['fedex'] });
    expect(detectCarrierMatch('990000001000').candidates[0]).toBe('fedex');
    const asked = recognitionAskedCarriers('200000000013');
    expect(asked).toContain('poste-italiane');
    expect(asked.indexOf('poste-italiane')).toBeLessThan(asked.indexOf('brt'));
    expect(recognitionAskedCarriers('200000000013', { countryHint: 'IT' })[0]).toBe('poste-italiane');
  });
});

describe('Nordic SSCCs behind the 00 identifier', () => {
  it.each(['00357123456789012348', '00073123456789012347', '00573123456789012342'])(
    'lists PostNord first for %s, a Danish or Swedish GS1 prefix',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates[0]).toBe('postnord');
    },
  );

  it('keeps PostNord out when the SSCC check digit fails', () => {
    expect(detectCarrierMatch('00357123456789012349').candidates).not.toContain('postnord');
    expect(checksumRejections('00357123456789012349')).toEqual(expect.arrayContaining([
      { carrier: 'postnord', rule: 'postnord-5', checksum: 'sscc' },
      { carrier: 'postnord', rule: 'postnord-3', checksum: 'sscc' },
    ]));
  });

  it.each(['00370123456789012347', '00373123456789012348'])('keeps Bring first for its parcel SSCC %s', (number) => {
    const { candidates } = detectCarrierMatch(number);
    expect(candidates[0]).toBe('bring-posten');
    expect(candidates).toContain('postnord');
  });

  it('lists and asks Posti first for a Finnish GS1 prefix', () => {
    expect(detectCarrierMatch('00264123456789012349')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('00264123456789012349').candidates[0]).toBe('posti');
    expect(recognitionAskedCarriers('00264123456789012349')[0]).toBe('posti');
    for (const number of ['00264123456789012340', '00265123456789012346']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('posti');
    }
  });
});

describe('Australia Post barcodes', () => {
  it('keeps CTT Express to references whose two agency codes start with 00', () => {
    expect(isCttExpressTrackingNumber('0001001234567812340995')).toBe(false);
    expect(detectCarrierMatch('0001001234567812340995').candidates).not.toContain('ctt-express');
    expect(detectCarrierMatch('0082800082801234567890')).toMatchObject({ carrier: 'ctt-express', confidence: 'high' });
    expect(detectCarrierMatch('0082800082801234567890001')).toMatchObject({ carrier: 'ctt-express', confidence: 'high' });
  });

  it.each(['33ABC123456701000935106', 'XY1234567801000935107'])('selects Australia Post for the article ID %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
  });

  it('selects Australia Post for an all-digit article ID that also passes the GS1 check', () => {
    expect(detectCarrierMatch('99722123456701000830900')).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
    expect(detectCarrierMatch('90000000000000123000001')).toMatchObject({ carrier: 'unknown', candidates: ['correos-express'] });
  });

  it('suggests Australia Post first for a twelve-character consignment number whose location ID has a letter', () => {
    expect(detectCarrierMatch('33ABC1234567')).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['australia-post', 'colis-prive'], preferred: ['australia-post'],
    });
    expect(recognitionAskedCarriers('33ABC1234567')).toEqual(['australia-post', 'colis-prive']);
    expect(detectCarrierMatch('343AY1234567').candidates).toContain('australia-post');
    expect(detectCarrierMatch('331231234567').candidates).not.toContain('australia-post');
  });

  it.each(['ABCZ12345678', '1ABZ12345678', 'A1BZ12345678'])('suggests Australia Post first for the StarTrack consignment number %s', (number) => {
    expect(detectCarrierMatch(number)).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['australia-post', 'colis-prive'], preferred: ['australia-post'],
    });
    expect(recognitionAskedCarriers(number)[0]).toBe('australia-post');
  });

  it.each(['ABCD12345678', 'ABZ12345678', 'ABCZ123456789', 'ABCZ1234567A'])(
    'leaves %s, which is not a StarTrack consignment number, to the carriers that share its shape',
    (number) => {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('australia-post');
    },
  );

  it.each(['2AB1234567', 'A2B1234567', 'ABC1234567', '12A1234567', 'A121234567'])(
    'suggests Australia Post alone for the ten-character consignment number %s',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['australia-post'] });
    },
  );

  it.each(['AB12345678', '1231234567'])('leaves the ten-character number %s to the carriers that share its shape', (number) => {
    expect(detectCarrierMatch(number).candidates).not.toContain('australia-post');
  });

  it('suggests Australia Post alone for R and twenty-four digits, and asks it', () => {
    expect(detectCarrierMatch('R000000000000000000000001')).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['australia-post'], preferred: [],
    });
    expect(recognitionAskedCarriers('R000000000000000000000001')).toEqual(['australia-post']);
    for (const number of ['R00000000000000000000001', 'R0000000000000000000000001', 'RR00000000000000000000001', 'S000000000000000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('australia-post');
    }
  });

  it('suggests Australia Post for a 22-digit prepaid barcode only when its GS1 check passes', () => {
    expect(detectCarrierMatch('0208061234567890123456')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('0208061234567890123456').candidates).toContain('australia-post');
    expect(recognitionAskedCarriers('0208061234567890123456')[0]).toBe('australia-post');
    expect(detectCarrierMatch('0208061234567890123457').candidates).not.toContain('australia-post');
    expect(checksumRejections('0208061234567890123457')).toEqual([
      { carrier: 'australia-post', rule: 'australia-post-prepaid', checksum: 'gs1' },
    ]);
    expect(detectCarrierMatch('0408061234567890123454').candidates).not.toContain('australia-post');
  });
});

describe('a mistyped postal number', () => {
  // A synthetic Cyprus Post item, valid and with its check digit changed.
  it('suggests no carrier when its S10 check digit fails, while Chronopost\'s own codes stay suggestions', () => {
    expect(detectCarrierMatch('RR123456785CY')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(detectCarrierMatch('RR123456784CY').candidates ?? []).toEqual([]);
    expect(recognitionCandidates('RR123456784CY')).toEqual([]);
    for (const number of ['XW123456784FR', 'RR123456784RV', 'RR123456784VF']) {
      expect(detectCarrierMatch(number).candidates, number).toContain('chronopost');
    }
  });
});

describe('ePost Global shipments under a USPS code', () => {
  // Synthetic USPS codes; none is a real shipment.
  it('names USPS, the issuing post, for the LV codes ePost Global sends on', () => {
    expect(detectCarrierMatch('LV123456785US')).toMatchObject({ carrier: 'usps', confidence: 'high' });
    for (const number of ['LV123456785US', 'LV123456784US', 'LW123456785US', 'LV123456785NL', 'LV12345678US']) {
      expect(recognitionAskedCarriers(number), number).not.toContain('epost-global');
    }
  });
});

describe('Russian Post domestic numbers', () => {
  // Synthetic numbers; none is a real shipment.
  it('puts Russian Post first for fourteen digits starting with 80 whose GS1 check digit passes', () => {
    const match = detectCarrierMatch('80123456789018');
    expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(match.candidates?.[0]).toBe('russian-post');
    expect(match.candidates).toContain('dpd');
    for (const number of ['80123456789017', '40123456789010', '8012345678901', '801234567890180']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('russian-post');
    }
  });
});

describe('Singapore Post and Canada Post numbers beyond the S10 form', () => {
  it('suggests Singapore Post for CNSGS and ten digits', () => {
    expect(detectCarrierMatch('CNSGS0000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['singapore-post'] });
    for (const number of ['CNSGS000000001', 'CNSGS00000000001', 'CNSGA0000000001', 'CNSGS0000000001SG']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('singapore-post');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('singapore-post');
    }
  });

  it('asks Canada Post first for sixteen digits passing the GS1 check in Canada, and among the first without a hint', () => {
    expect(recognitionAskedCarriers('7000000000000016', { countryHint: 'CA' })[0]).toBe('canada-post');
    expect(recognitionAskedCarriers('7000000000000016')).toContain('canada-post');
  });
});

describe('Åland, Aruba, Gibraltar, Samoa, Burundi and Paraguay posts', () => {
  it('leaves their S10 numbers to postal detection', () => {
    for (const code of ['AX', 'AW', 'GI', 'WS', 'BI', 'PY']) {
      expect(detectCarrierMatch(`RR000000005${code}`), code).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    }
  });

  it('reads the Åland and Aruba trackers\' links', () => {
    expect(parseTrackingInput('https://www.alandpost.ax/en/track?shipmentid=RR000000005AX'))
      .toMatchObject({ trackingNumber: 'RR000000005AX', carrier: 'aland-post', source: 'link' });
    expect(parseTrackingInput('https://cds.postaruba.com/ipswt/IPSWeb_item_events.aspx?itemid=RR000000005AW'))
      .toMatchObject({ trackingNumber: 'RR000000005AW', carrier: 'aruba-post', source: 'link' });
  });

  it('names them from their names', () => {
    for (const [name, carrier] of [['Posten Åland', 'aland-post'], ['Aruba Post', 'aruba-post'], ['Gibraltar Post', 'gibraltar-post'],
      ['Samoa Post Ltd', 'samoa-post'], ['Poste du Burundi', 'burundi-post'], ['DINACOPA', 'correo-paraguayo']] as const) {
      expect(carrierIdFromName(name), name).toBe(carrier);
    }
  });
});

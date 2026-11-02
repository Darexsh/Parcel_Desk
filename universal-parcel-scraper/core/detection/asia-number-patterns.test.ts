import { describe, expect, it } from 'vitest';
import { carrierIdFromName } from '../catalog/hints.js';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { checksumRejections, detectCarrierMatch, parseTrackingInput } from './index.js';

describe('prefixed Asian shipment references and shared numeric formats', () => {
  it('selects the documented SF waybill family without widening bare numeric attribution', () => {
    expect(detectCarrierMatch('sf 000 000 000 0000')).toMatchObject({ carrier: 'sf-express', confidence: 'high' });
    expect(parseTrackingInput('Tracking number: SF0000000000000')).toMatchObject({
      trackingNumber: 'SF0000000000000', carrier: 'sf-express', confidence: 'high',
    });
    expect(detectCarrierMatch('SF0000000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['sf-express'] });
    expect(detectCarrierMatch('000000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    for (const number of ['SF000000000001', 'SF00000000000001', 'XSF0000000000001', 'SF0000000000001CN']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('sf-express');
    }
  });

  it('selects JD Logistics for its prefixed domestic waybills at their own length only', () => {
    for (const number of ['JD0000000000000', 'JDV000000000000', 'JDVA00000000000', 'jdx 000000000000']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'jd-logistics', confidence: 'high' });
    }
    for (const number of ['JD000000000000', 'JD00000000000000', 'JDVAB0000000000', 'XJD0000000000000']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('jd-logistics');
    }
  });

  it.each([
    ['LP00000000000001', 'aliexpress'],
    ['LP00000000000000001', 'aliexpress'],
    ['LP0000000000001CN', 'four-px'],
    ['1000000000016', 'delhivery'],
    ['10000000000016', 'delhivery'],
  ])('keeps %s ambiguous while allowing its direct HTTP confirmation', (number, carrier) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(number).candidates).toContain(carrier);
    expect(recognitionCandidates(number).map(candidate => candidate.carrier)).toContain(carrier);
  });

  it('anchors the two LP reference families independently of postal suffixes', () => {
    for (const number of ['LP0000000000001', 'LP000000000000001', 'LP0000000000000001', 'LP000000000000000001', 'XLP00000000000001', 'LP00000000000001CN']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('aliexpress');
    }
    for (const number of ['LP000000000001CN', 'LP00000000000001CN', 'LP0000000000001SG']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('four-px');
    }
  });

  it('includes the LP and thirteen-digit Delhivery candidates within bounded HTTP preflight', () => {
    expect(recognitionAskedCarriers('LP00000000000001')).toContain('aliexpress');
    expect(recognitionAskedCarriers('LP00000000000000001')).toContain('aliexpress');
    expect(recognitionAskedCarriers('LP0000000000001CN')).toContain('four-px');
    expect(recognitionAskedCarriers('2820000000001')).toContain('delhivery');
  });

  it('ranks a carrier whose check digit passes ahead of popularity alone', () => {
    // Synthetic twelve digits; only the first passes Purolator's Luhn check.
    expect(recognitionCandidates('300000000004')[0]!.carrier).toBe('purolator');
    expect(recognitionCandidates('300000000005').map(candidate => candidate.carrier)).not.toContain('purolator');
  });

  it('names Ekart for its known merchant codes and only suggests it for other letters', () => {
    for (const number of ['FMPP0000000001', 'MYSR0000000001', 'BSIC0000000001', 'SRTP0000000001', 'fmpp 0000000001']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'ekart', confidence: 'high' });
    }
    expect(detectCarrierMatch('QXRC0123456789')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ekart'] });
    for (const number of ['PBXC0000000001', 'FMPX0000000001', 'FMPP000000001', 'FMPP00000000001', 'FM1P0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('ekart');
    }
  });

  it('suggests Cainiao alone for HRBC and ten digits, which its tracker answered and Ekart\'s did not know', () => {
    expect(detectCarrierMatch('HRBC0123456789')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['aliexpress'] });
    expect(recognitionCandidates('HRBC0123456789')[0]!.carrier).toBe('aliexpress');
    for (const number of ['HRBC012345678', 'HRBC01234567890', 'HRBX0123456789']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('aliexpress');
    }
  });

  it('selects OnTrac only in its own C and D ranges while preserving LaserShip detection', () => {
    for (const number of ['C10000000000004', 'C17000000000007', 'D10000000000003']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'ontrac', confidence: 'high', candidates: ['ontrac'] });
      expect(recognitionCandidates(number)).toEqual([]);
    }
    for (const number of ['C00000000000006', 'C25000000000007', 'D00000000000005', 'D11000000000002']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ontrac'] });
      expect(recognitionCandidates(number).map(candidate => candidate.carrier)).toContain('ontrac');
    }
    for (const number of ['C10000000000001', 'C00000000000001']) expect(detectCarrierMatch(number).candidates).not.toContain('ontrac');
    expect(detectCarrierMatch('1LS0000000000001')).toMatchObject({ carrier: 'ontrac', confidence: 'high' });
  });

  it('keeps other national SPX networks outside the Philippines adapter', () => {
    for (const number of ['SPXID000000000001', 'SPXMY00000000001C']) {
      expect(detectCarrierMatch(number).carrier).not.toBe('spx-ph');
      expect(detectCarrierMatch(number).candidates).not.toContain('spx-ph');
    }
  });

  it('selects Pos Laju consignments only when their S10 check digit holds', () => {
    // The ninth digit checks the eight before it; the third letter is outside the check.
    for (const number of ['EHE000000005MY', 'ERA123456785MY', 'XYZ000000080MY', 'ehe 000000005 my']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'pos-malaysia', confidence: 'high' });
    }
    for (const number of ['EHE000000006MY', 'ERA123456780MY', 'XYZ000000085MY']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('pos-malaysia');
      expect(checksumRejections(number)).toEqual([{ carrier: 'pos-malaysia', rule: 'pos-malaysia-4', checksum: 'pos-laju' }]);
    }
  });

  it('selects China Post for ZS, ZC and ZA numbers with eleven digits, even when they close La Poste\'s key', () => {
    // The second set closes La Poste's GS1 key by chance; no La Poste number uses these prefixes.
    for (const number of ['ZS00000000001', 'ZC00000000001', 'ZA00000000001', 'zs 0000 0000 001', 'ZS00000000000', 'ZC00000000000', 'ZA00000000000']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'china-post', confidence: 'high', candidates: ['china-post'] });
      expect(recognitionAskedCarriers(number)).toEqual([]);
    }
    // Other Z prefixes and other lengths keep La Poste's broad rule alone, or nothing.
    for (const number of ['ZT00000000001', 'ZB00000000001', 'AZ00000000001', 'CZ00000000001']) {
      expect(detectCarrierMatch(number).candidates).toEqual(['la-poste']);
    }
    for (const number of ['ZC0000000001', 'ZC000000000001', 'ZC00000000001CN', 'ZA0000000001', 'ZA000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('china-post');
    }
  });

  it('names China Post for its own numbers in an ems.com.cn link', () => {
    for (const url of [
      'https://www.ems.com.cn/mailtracking/e_you_jian_cha_xun.html?mailNum=ZS00000000001',
      'http://www.ems.com.cn/qcgzOutQueryAction.do?reqCode=gotoSearchE&mailNum=RR123456785CN',
      'http://www.ems.com.cn/english.html?TrackingNumber=EE123456785CN',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ carrier: 'china-post', confidence: 'high', source: 'link' });
    }
    // China Post's tracker takes only its own numbers, so any other is detected on its own.
    expect(parseTrackingInput('http://www.ems.com.cn/english.html?TrackingNumber=EE123456785FR'))
      .toMatchObject({ carrier: 'la-poste', source: 'link' });
    expect(parseTrackingInput('http://www.ems.com.cn/mailtracking/e_you_jian_cha_xun.html?mailNum=1000000000001').carrier)
      .not.toBe('china-post');
  });

  it('gives each forwarder\'s YQ code to the carrier of its prefix alone', () => {
    // Forwarders on one Chinese platform share the YQ ending and ten digits; the customer prefix names the forwarder.
    const owners = { JSEJY0000000001YQ: 'js-express', WNBZZ0000000001YQ: 'wanbexpress', FEISH0000000001YQ: '17feia',
      SFCAA0000000001YQ: 'sfc', CJPZZA0000000001YQ: 'cj-packet', BUFZA0000000001YQ: 'buffalo-ex',
      JXCYT0000000001YQ: 'juxi-express', FARZZ0000000001YQ: 'far-international' };
    for (const [number, carrier] of Object.entries(owners)) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier, confidence: 'high', candidates: [carrier] });
      expect(recognitionCandidates(number), number).toEqual([]);
    }
    // JS Express and WanbExpress never stand in for each other.
    expect(detectCarrierMatch('JSEZZ0000000001YQ').candidates).not.toContain('wanbexpress');
    expect(detectCarrierMatch('WNBJS0000000001YQ').candidates).not.toContain('js-express');
    // A prefix no catalog forwarder uses, or a code a digit short, is left to the user.
    for (const number of ['ABCDE0000000001YQ', 'JSEJY000000001YQ', 'WNBZZ000000001YQ', 'JSWNB0000000001YQ',
      'JXCYT000000001YQ', 'JXCY0000000001YQ', 'JXCYT0000000001Y', 'FARZZ000000001YQ', 'FARZ0000000001YQ']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', candidates: [] });
    }
    expect(detectCarrierMatch('YL0000000001YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['gzyl'] });
  });

  it('names Shouwu International for SWECN, twelve digits and YQ, and only that layout', () => {
    for (const number of ['SWECN000000000017YQ', 'swecn 000000 000017 yq']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'shouwu', confidence: 'high', candidates: ['shouwu'] });
    }
    for (const number of ['SWECN0000000017YQ', 'SWECN00000000017YQ', 'SWECN0000000000017YQ', 'SWEHK000000000017YQ',
      'SWECN000000000017', 'SWECN000000000017YT']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('shouwu');
    }
  });

  it('suggests KTD after DHLink for KTDWE and ten digits, and only that layout', () => {
    for (const number of ['KTDWE0000000017', 'ktdwe 00000 00017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink', 'ktd'] });
    }
    for (const number of ['KTDWE000000017', 'KTDWE00000000017', 'KTDWA0000000017', 'KTD0000000017', 'KTDWE0000000017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ktd');
    }
  });

  it('names MeiHoo Pegasus for MYH, nine digits and CN, and only that layout', () => {
    for (const number of ['MYH900000001CN', 'myh 900 000 001 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'meihoo-pegasus', confidence: 'high', candidates: ['meihoo-pegasus'] });
    }
    for (const number of ['MYH90000001CN', 'MYH9000000001CN', 'MYH900000001US', 'MYX900000001CN', 'MYH900000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('meihoo-pegasus');
    }
  });

  it('names Techlink for its dated ZHPHD waybills ending in ML', () => {
    expect(detectCarrierMatch('ZHPHD260101000001ML')).toMatchObject({ carrier: 'techlink', confidence: 'high', candidates: ['techlink'] });
    expect(detectCarrierMatch('zhphd 260101 000001 ml')).toMatchObject({ carrier: 'techlink', confidence: 'high' });
    // A month or day that cannot be a date, another prefix or ending, or a digit too many or too few is no Techlink waybill.
    for (const number of ['ZHPHD261301000001ML', 'ZHPHD260132000001ML', 'ZHPHX260101000001ML', 'ZHPHD260101000001MX',
      'ZHPHD26010100001ML', 'ZHPHD2601010000001ML', 'CJPHD260101000001ML']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('techlink');
    }
  });

  it('asks Huiyi Logistics about its lettered numbers without naming it from the shape', () => {
    expect(detectCarrierMatch('ABCD00D0000EFGH')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['hywl'] });
    expect(recognitionAskedCarriers('ABCD00D0000EFGH')).toEqual(['hywl']);
    for (const number of ['ABCD00E0000EFGH', 'ABCD00D0000EFG', 'ABC00D0000EFGH', 'ABCD000D0000EFGH', 'ABCD00D00000EFGH']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('hywl');
    }
  });

  it('asks DHLink about its line provider\'s XZG tracking numbers without naming it from the shape', () => {
    expect(detectCarrierMatch('XZG000000001WL')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('XZG000000001WL')).toEqual(['dhlink']);
    for (const number of ['XZG00000001WL', 'XZG0000000001WL', 'XZG000000001WX', 'XZH000000001WL', 'YIL000000001WL']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about YLUS tracking numbers on its GOFO line without naming it from the shape', () => {
    expect(detectCarrierMatch('YLUS0000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(detectCarrierMatch('ylus 0000 0000 01')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('YLUS0000000001')).toEqual(['dhlink']);
    for (const number of ['YLUS000000001', 'YLUS00000000001', 'YLUK0000000001', 'XLUS0000000001', 'YLUS000000000A', 'YL0000000001YQ']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about EYT tracking numbers on its SwiftX line without naming it from the shape', () => {
    expect(detectCarrierMatch('EYT0000000001HZ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('EYT0000000001HZ')).toEqual(['dhlink']);
    for (const number of ['EYT000000001HZ', 'EYT00000000001HZ', 'EYT0000000001HX', 'EYZ0000000001HZ', 'XZG000000001HZ']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about QH tracking numbers on its GOFO line without naming it from the shape', () => {
    expect(detectCarrierMatch('QH000000000001FS')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('QH000000000001FS')).toEqual(['dhlink']);
    for (const number of ['QH00000000001FS', 'QH0000000000001FS', 'QH000000000001FX', 'QX000000000001FS', 'QH000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about YF tracking numbers on its GOFO line without naming it from the shape', () => {
    expect(detectCarrierMatch('YF0000000001CN')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(detectCarrierMatch('yf 0000 0000 01 cn')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('YF0000000001CN')).toEqual(['dhlink']);
    for (const number of ['YF000000001CN', 'YF00000000001CN', 'YF0000000001CX', 'YX0000000001CN', 'YF0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about KTD\'s KTDWE tracking numbers on its SwiftX line before a provider names KTD', () => {
    expect(detectCarrierMatch('KTDWE0000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink', 'ktd'] });
    expect(recognitionAskedCarriers('KTDWE0000000001')).toEqual(['dhlink']);
    for (const number of ['KTDWE000000001', 'KTDWE00000000001', 'KTDWA0000000001', 'KTD0000000001', 'KTDWE0000000001CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about YHKJ tracking numbers on its line to Britain without naming it from the shape', () => {
    expect(detectCarrierMatch('YHKJ1000000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(detectCarrierMatch('yhkj 1000 0000 17')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('YHKJ1000000017')).toEqual(['dhlink']);
    for (const number of ['YHKJ100000017', 'YHKJ10000000017', 'YHKX1000000017', 'YHKJ1000000017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about YLE line numbers, two letters, ten digits and YQ, without naming it from the shape', () => {
    expect(detectCarrierMatch('YLEAA1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(detectCarrierMatch('yleaa 1000000017 yq')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink'] });
    expect(recognitionAskedCarriers('YLEAA1000000017YQ')).toEqual(['dhlink']);
    for (const number of ['YLEAA100000017YQ', 'YLEAA10000000017YQ', 'YLEA1000000017YQ', 'YLXAA1000000017YQ', 'YLEAA1000000017YX', 'YLEAA1000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dhlink');
    }
  });
});

describe('wave seven South-East Asian courier rules', () => {
  // Synthetic numbers in each carrier's layout; none is a real parcel.
  it('names SPX Express Singapore for SPXSG numbers and only suggests it for SLS numbers', () => {
    for (const number of ['SPXSG000000000011', 'SPXSG00000000001A']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'spx-sg', confidence: 'high' });
    }
    expect(detectCarrierMatch('SG0000000000011')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['spx-sg'] });
    for (const number of ['SPXSG0000000001', 'SPXSG0000000000001', 'SG000000000001', 'SG00000000000011']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('spx-sg');
    }
  });

  it('names GoTo Logistics for TKGTL numbers, with or without the hyphen', () => {
    for (const number of ['TKGTL-0000000000A', 'TKGTL0000000000A']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'gtl-goto', confidence: 'high', candidates: ['gtl-goto'] });
    }
    for (const number of ['TKGTL000000000A', 'TKGTL00000000000A', 'TKGTM0000000000A']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('gtl-goto');
    }
  });

  it('names Paxel for its dated AWB, written with or without separators', () => {
    for (const number of ['EM.000000000A-20260101-0-00000A', 'EM000000000A20260101000000A']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'paxel', confidence: 'high', candidates: ['paxel'] });
    }
    for (const number of ['EM000000000A19260101000000A', 'EM00000000A20260101000000A', 'EN000000000A20260101000000A']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('paxel');
    }
  });

  it('keeps IDexpress for its ID waybills and leaves SGX IDA air waybills unnamed', () => {
    for (const number of ['IDS000000000001', 'IDE0000000000001', 'IDA0000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'idexpress', confidence: 'high' });
    }
    expect(detectCarrierMatch('IDA000000000001').candidates ?? []).not.toContain('idexpress');
  });

  it('names the Pickupp network its region suffix shows', () => {
    expect(detectCarrierMatch('PU000000000001HK')).toMatchObject({ carrier: 'pickupp', confidence: 'high', candidates: ['pickupp'] });
    expect(detectCarrierMatch('PU000000000001SG')).toMatchObject({ carrier: 'pickupp-sg', confidence: 'high', candidates: ['pickupp-sg'] });
    for (const number of ['PU000000000001MY', 'PU00000000001HK', 'PU0000000000001SG']) {
      const candidates = detectCarrierMatch(number).candidates ?? [];
      expect(candidates, number).not.toContain('pickupp');
      expect(candidates, number).not.toContain('pickupp-sg');
    }
  });
});

describe('wave seven South Asian courier rules', () => {
  it('names Valmo for VL and thirteen digits only', () => {
    expect(detectCarrierMatch('VL0000000000001')).toMatchObject({ carrier: 'valmo', confidence: 'high', candidates: ['valmo'] });
    expect(detectCarrierMatch('vl 0000 0000 00001')).toMatchObject({ carrier: 'valmo', confidence: 'high' });
    for (const number of ['VL000000000001', 'VL00000000000001', 'VA0000000000001', 'V00000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('valmo');
    }
  });
});

describe('wave eight Australian courier rules', () => {
  // Synthetic numbers in Micro Express's layout; none is a real parcel.
  it('names Micro Express for ME, thirteen digits and three letters', () => {
    expect(detectCarrierMatch('ME0000000000001AAA')).toMatchObject({ carrier: 'micro-express', confidence: 'high' });
    for (const number of ['ME000000000001AAA', 'ME00000000000001AAA', 'ME0000000000001AA', 'MX0000000000001AAA']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('micro-express');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('micro-express');
    }
  });
});

describe('Chinese fulfilment warehouse numbers', () => {
  it('names DayOne for DOT and sixteen digits, and only that layout', () => {
    for (const number of ['DOT0000000000000017', 'DOT1000000000000017', 'dot 0000 0000 0000 0017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'dayone', confidence: 'high' });
    }
    for (const number of ['DOT000000000000001', 'DOT00000000000000017', 'DOT000000000000001A', 'DOC0000000000000017']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('dayone');
    }
  });

  it('suggests Z-Leading for ZL, two letters and nine digits, and only that layout', () => {
    for (const number of ['ZLXX000000017', 'zlab 000 000 001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['z-leading'] });
    }
    for (const number of ['ZLXX00000001', 'ZLXX0000000017', 'ZLX0000000017', 'ZL0X000000017', 'ZMXX000000017', 'XLXX000000017']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('z-leading');
    }
  });

  it('suggests Pengyou for three letters, nine digits and PY, and only that layout', () => {
    for (const number of ['ZZZ000000017PY', 'zzz 000 000 017 py']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['pengyou'] });
    }
    for (const number of ['ZZZ00000017PY', 'ZZZ0000000017PY', 'ZZ000000017PY', 'ZZZ000000017PX', 'ZZ0000000017PY']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('pengyou');
    }
  });

  it('names Jifan for JFGJ, nine digits and CN, with or without an S10 check digit', () => {
    for (const number of ['JFGJ000000017CN', 'JFGJ000000010CN', 'jfgj 000 000 017 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'jifan', confidence: 'high' });
    }
    for (const number of ['JFGJ00000017CN', 'JFGJ0000000017CN', 'JFGX000000017CN', 'JFGJ000000017CX']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('jifan');
    }
  });

  it('suggests YouBang Express for YB, ten digits and CN, and only that layout', () => {
    for (const number of ['YB0000000017CN', 'yb 0000 0000 17 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['youbang-express'] });
    }
    for (const number of ['YB000000017CN', 'YB00000000017CN', 'YC0000000017CN', 'YB0000000017CX']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('youbang-express');
    }
  });

  it('names Xinghe Freight for GZXH, its company code, ten digits and YQ, and only that layout', () => {
    for (const number of ['GZXH0000000017YQ', 'gzxh 0000 0000 17 yq']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'xinghe-freight', confidence: 'high' });
    }
    for (const number of ['GZXH000000017YQ', 'GZXH00000000017YQ', 'GZYL0000000017YQ', 'GZXH0000000017YT']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('xinghe-freight');
    }
  });

  it('names Fastbox for FB, a date and ten digits, and only that layout', () => {
    for (const number of ['FB2610010000000017', 'fb 261001 0000 000 017', 'FB1712310000000010']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'fastbox', confidence: 'high' });
    }
    for (const number of ['FB261001000000017', 'FB26100100000000017', 'FB2613010000000017', 'FB2610320000000017', 'FB2600010000000017', 'FC2610010000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fastbox');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('fastbox');
    }
  });

  it('names Meso-global for ZJKJ and ten digits, and only that layout', () => {
    for (const number of ['ZJKJ1000000017', 'zjkj 1000 0000 17']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'meso-global', confidence: 'high' });
    }
    for (const number of ['ZJKJ100000017', 'ZJKJ10000000017', 'ZJKX1000000017', 'ZJKJ1000000017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('meso-global');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('meso-global');
    }
  });

  it('names YDH for YDH, ten digits and YQ or AZ, and reads its tracking link', () => {
    for (const number of ['YDH1000000017YQ', 'YDH1000000017AZ', 'ydh 1000 0000 17 yq']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'ydh', confidence: 'high' });
    }
    for (const number of ['YDH100000017YQ', 'YDH10000000017YQ', 'YDX1000000017YQ', 'YDH1000000017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ydh');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('ydh');
    }
    expect(parseTrackingInput('https://track.ydhex.com/track_query.aspx?track_number=YDH1000000017YQ')).toMatchObject({
      trackingNumber: 'YDH1000000017YQ', carrier: 'ydh', source: 'link',
    });
  });

  it('suggests Take Send for TS, a registration date and seven digits without naming it', () => {
    for (const number of ['TS2609040000017', 'ts 260904 0000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['takesend'] });
    }
    for (const number of ['TS2613040000017', 'TS2609320000017', 'TS260904000017', 'TS26090400000017', 'TX2609040000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('takesend');
    }
    expect(parseTrackingInput('http://k5.takesend.com:8180/WebTrack?action=list&language=en&bills=TS2609040000017')).toMatchObject({
      trackingNumber: 'TS2609040000017', carrier: 'takesend', source: 'link',
    });
  });

  it('reads Joom Logistics tracking links on both of its hosts', () => {
    for (const link of ['https://joomlogistics.com/en/track?id=ZZ000000000HK', 'https://logistics.joom.com/de/track/?id=ZZ000000000HK']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'ZZ000000000HK', carrier: 'joom-logistics', source: 'link' });
    }
  });

  it('names TopYou for TYZR, a letter, ten digits and YQ, and only that layout', () => {
    for (const number of ['TYZRZ0000000017YQ', 'tyzrz 0000 0000 17 yq']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'topyou', confidence: 'high' });
    }
    for (const number of ['TYZRZ000000001YQ', 'TYZRZ00000000017YQ', 'TYZR00000000017YQ', 'TYZXZ0000000017YQ', 'TYZRZ0000000017YX']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('topyou');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('topyou');
    }
  });
});

describe('First Flight (Middle East) and DD Express links', () => {
  it('reads a First Flight (Middle East) waybill from its tracking path', () => {
    expect(parseTrackingInput('https://firstflightme.com/tracking/awb/10000017')).toMatchObject({
      trackingNumber: '10000017', carrier: 'first-flight-me', source: 'link',
    });
  });

  it('reads a DD Express tracking id from its tracker query', () => {
    expect(parseTrackingInput('https://tracking.dd.express/?tracking_ids=DD100000017')).toMatchObject({
      trackingNumber: 'DD100000017', carrier: 'dd-express', source: 'link',
    });
  });
});

describe('Boyuan tracking numbers', () => {
  it('suggests Boyuan and DHLink for BY, fourteen digits and CN, and only that layout', () => {
    for (const number of ['BY10000000000017CN', 'by 10000000000017 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['boyuan', 'dhlink'] });
    }
    for (const number of ['BY1000000000017CN', 'BY100000000000017CN', 'BY10000000000017US', 'BX10000000000017CN', 'BYHD100000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('boyuan');
    }
  });

  it('asks DHLink about the number and names Boyuan from a provider', () => {
    expect(recognitionAskedCarriers('BY10000000000017CN')).toEqual(['dhlink']);
    expect(carrierIdFromName('Boyuan')).toBe('boyuan');
    expect(carrierIdFromName('博远供应链')).toBe('boyuan');
  });

  it('reads Boyuan tracker links', () => {
    expect(parseTrackingInput('https://tms.boyuangyl.com/trackIndex.htm?documentCode=BY10000000000017CN')).toMatchObject({
      trackingNumber: 'BY10000000000017CN', carrier: 'boyuan', source: 'link',
    });
  });
});

describe('Tuodatong tracking numbers', () => {
  it('suggests DHLink and Tuodatong for TDT, ten digits and CN, and only that layout', () => {
    for (const number of ['TDT1000000017CN', 'tdt 1000000017 cn']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhlink', 'tuodatong'] });
    }
    for (const number of ['TDT100000017CN', 'TDT10000000017CN', 'TDT1000000017US', 'TDX1000000017CN', 'TD1000000017CN']) {
      const { carrier, candidates = [] } = detectCarrierMatch(number);
      expect([carrier, ...candidates], number).not.toContain('tuodatong');
      expect([carrier, ...candidates], number).not.toContain('dhlink');
    }
  });

  it('asks DHLink about the number, names Tuodatong from a provider and reads its tracker links', () => {
    expect(recognitionAskedCarriers('TDT1000000017CN')).toEqual(['dhlink']);
    for (const name of ['Tuodatong', 'TDTWL', '拓达通物流']) expect(carrierIdFromName(name), name).toBe('tuodatong');
    expect(parseTrackingInput('https://www.tuodatong56.com/tms/trackIndex.htm?documentCode=TDT1000000017CN')).toMatchObject({
      trackingNumber: 'TDT1000000017CN', carrier: 'tuodatong', source: 'link',
    });
  });
});

describe('UTEC Logistics, DEX-I, JY Express and PPX Track', () => {
  it('suggests UTEC Logistics for UTECP, ten digits and two letters only', () => {
    expect(detectCarrierMatch('UTECP1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['utec-logistics'] });
    for (const number of ['UTECP100000017YQ', 'UTECP10000000017YQ', 'UTEC1000000017YQ', 'UTECX1000000017YQ', 'UTECP1000000017Y']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('utec-logistics');
    }
  });

  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['UTEC', 'utec-logistics'], ['UTEC Express', 'utec-logistics'], ['DEX-I', 'dex-i'], ['递壹时', 'dex-i'],
      ['JY Express', 'jy-express'], ['JY-EXP', 'jy-express'], ['捷优国际', 'jy-express'], ['PPX Track', 'epost-global']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    // DEX Pakistan and a China to Russia line also go by these short names.
    for (const name of ['DEX', 'JY']) expect(carrierIdFromName(name), name).toBeUndefined();
    expect(parseTrackingInput('https://utec.ua/tracking/UTECP1000000017YQ')).toMatchObject({
      trackingNumber: 'UTECP1000000017YQ', carrier: 'utec-logistics', source: 'link',
    });
    expect(parseTrackingInput('https://www.dex-i.com/site/tracking?trackingNums=DX1000000017')).toMatchObject({
      trackingNumber: 'DX1000000017', carrier: 'dex-i', source: 'link',
    });
    for (const link of ['https://ppxtrack.com/?id=EPG100000000000017', 'https://www.ppxtrack.com/t/shop/EPG100000000000017']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'EPG100000000000017', carrier: 'epost-global', source: 'link' });
    }
  });
});

describe('ComOne Express, GESWL Express, DPX Logistics, Citilogistics and Arrow Express', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['ComOne Express', 'comone-express'], ['商壹国际', 'comone-express'], ['ZCE', 'geswl'],
      ['ZCE - Geswl Express', 'geswl'], ['翼速国际物流', 'geswl'], ['DPX Logistics', 'dpx-logistics'],
      ['Document Parcel Express', 'dpx-logistics'], ['Citilogistics', 'citilogistics'], ['Arrow Express', 'arrow-express']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    // DPX Express and Arrow XL also go by these short names.
    for (const name of ['DPX', 'Arrow']) expect(carrierIdFromName(name), name).toBeUndefined();
    expect(parseTrackingInput('https://www.com1logistics.com/tracking.html?trackNo=CM1000000017')).toMatchObject({
      trackingNumber: 'CM1000000017', carrier: 'comone-express', source: 'link',
    });
    expect(parseTrackingInput('https://www.geswl.com:8088/ld_express//businessExpressController.do?gotrack&ids=100000000017')).toMatchObject({
      trackingNumber: '100000000017', carrier: 'geswl', source: 'link',
    });
    expect(parseTrackingInput('https://dpxlogistics.com/en/track/index.html#100000000017')).toMatchObject({
      trackingNumber: '100000000017', carrier: 'dpx-logistics', source: 'link',
    });
  });
});

describe('QLS, HSD Express, Expedico, PasarEX, Parceljet, LetterTrack, Frontier Courier, E24, Hecny E-com and Jaskipin', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['QLS Quince', 'qls-quince'], ['Quince Logistics Services', 'qls-quince'], ['HongSuDa', 'hongsuda'],
      ['鸿速达', 'hongsuda'], ['SW Express', 'shouwu'], ['Expedico', 'expedico'], ['Vinteco', 'expedico'], ['PasarEx', 'pasarex'],
      ['Pasar Express', 'pasarex'], ['Parceljet', 'parceljet'], ['派速捷', 'parceljet'], ['Letter Track', 'letter-track'],
      ['Frontier', 'frontier-ca'], ['Frontier Supply Chain Solutions', 'frontier-ca'], ['E24', 'e24metro-ca'],
      ['Metro Supply Chain', 'e24metro-ca'], ['Hecny E-com', 'hecny-ecom'], ['Хекни Групп СНГ', 'hecny-ecom'],
      ['Jaskipin', 'jaskipin'], ['Parcll', 'gofo'], ['PARCLL', 'gofo'], ['CIRRO Parcel Netherlands', 'gofo-nl'], ['YY Postal', 'yypost'], ['ECO Freight', 'eco-express-ae']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    expect(carrierIdFromName('CIRRO E-Commerce')).not.toBe('gofo-nl');
    for (const [url, number, carrier] of [
      ['https://qls.quince.com/qls/track/QL0123456789', 'QL0123456789', 'qls-quince'],
      ['https://qls.quince.com/quince/track/QL0123456789/', 'QL0123456789', 'qls-quince'],
      ['https://expedico.eu/tracking?code=0123456789012', '0123456789012', 'expedico'],
      ['https://tracking.pasarex.com/?awb=AMZPSR012345678', 'AMZPSR012345678', 'pasarex'],
      ['https://tracking.carrierlogistics.com/scripts/fscf.pol/boldetail.htm?wbtn=PRO&wpro1=10123456', '10123456', 'frontier-ca'],
      ['https://ecom.yolka.io/parcels/2000012345678901', '2000012345678901', 'hecny-ecom'],
      ['https://e-com.hecny.ru/ru/parcels/2000012345678901', '2000012345678901', 'hecny-ecom'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
    expect(parseTrackingInput('https://tracking.carrierlogistics.com/scripts/rxic.pol/boldetail.htm?wbtn=PRO&wpro1=10123456').carrier)
      .not.toBe('frontier-ca');
  });

  it('suggests PasarEX for AMZPSR and nine digits', () => {
    expect(detectCarrierMatch('AMZPSR012345678')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['pasarex'] });
    for (const number of ['AMZPSR01234567', 'AMZPSR0123456789', 'AMZPSX012345678', 'XAMZPSR012345678']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('pasarex');
    }
  });
});

describe('FlashBird', () => {
  it('names FlashBird and reads its tracker links', () => {
    expect(carrierIdFromName('FlashBird')).toBe('flashbird-ca');
    for (const url of ['https://flashbird.ca/tracking/123456789012', 'https://www.flashbird.ca/tracking/123456789012/']) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: '123456789012', carrier: 'flashbird-ca', source: 'link' });
    }
  });
});

describe('Zippd, Global Delivery Network, VIP Posta, SFYD Express, BFE Express, Paisley Freight, MAX Pakket and Diakinisis', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['Zippd', 'zippd'], ['DeliveryApp', 'zippd'], ['Global Delivery Network', 'global-delivery-network'],
      ['VIP Posta', 'vip-posta'], ['Вип Пошта', 'vip-posta'], ['SFYD Express', 'sfyd-express'], ['云速递', 'sfyd-express'],
      ['BFE Express', 'bfe-express'], ['Paisley Freight', 'paisley-freight'], ['Max Pakket', 'max-pakket'],
      ['Diakinisis', 'diakinisis'], ['Διακίνησις', 'diakinisis']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const [url, number, carrier] of [
      ['https://www.zippd.com/tracking/?code=DAAB12CD-12345-12345678', 'DAAB12CD-12345-12345678', 'zippd'],
      ['https://pds.gdnparcel.com/pds_tracking.asp?track=100000000017', '100000000017', 'global-delivery-network'],
      ['https://vipposta.mk/home/tracking?id=1000017', '1000017', 'vip-posta'],
      ['https://sfydexpress.com/tracking.html?c=SF1000000017', 'SF1000000017', 'sfyd-express'],
      ['https://www.bfeexpress.com/track?track_number=CK512100000000017', 'CK512100000000017', 'bfe-express'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
  });
});

describe('Chinese, Hong Kong and Australian lines from TrackingMore\'s Chinese names', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['Feiyang GCEx', 'shipgce'], ['GCEx', 'shipgce'], ['飛洋轉運', 'shipgce'],
      ['Espeedpost', 'espeedpost'], ['易速国际物流', 'espeedpost'], ['360 Zebra', '360zebra'], ['斑马物联网', '360zebra'],
      ['AuExpress', 'auexpress'], ['澳邮', 'auexpress'], ['ANE Logistics', 'ane-logistics'], ['Ane Express', 'ane-logistics'],
      ['安能物流', 'ane-logistics'], ['China Railway Express', 'china-railway-express'], ['中铁快运', 'china-railway-express'],
      ['LHT Express', 'lhtex'], ['联昊通速递', 'lhtex'], ['Showl', 'showl'], ['森鸿国际物流', 'showl'], ['Elianpost', 'elianpost'],
      ['易连供应链', 'elianpost'], ['BQC Logistics', 'bqc-logistics'], ['百千诚物流', 'bqc-logistics'],
      ['King Kong Express', 'king-kong-express'], ['京廣速遞', 'king-kong-express'],
      ['LiBang International Logistics', 'libang-logistics'], ['立邦国际物流', 'libang-logistics'], ['Sumxpress', 'sumxpress'],
      ['速玛物流', 'sumxpress'], ['Suning Logistics', 'suning-logistics'], ['苏宁物流', 'suning-logistics'],
      ['RRS Logistics', 'rrs-logistics'], ['日日顺', 'rrs-logistics'], ['ChangJiang Express', 'changjiang-express'],
      ['长江国际速递', 'changjiang-express']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const [url, number, carrier] of [
      ['https://www.espeedpost.com/html-tracking.html?trackingnumber=AB1000000017', 'AB1000000017', 'espeedpost'],
      ['https://www.360zebra.com/web/tracking?trackingnbrs=AB1000000017', 'AB1000000017', '360zebra'],
      ['https://www.auexpress.com/tracking?OrderId=AB1000000017', 'AB1000000017', 'auexpress'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
  });
});

describe('EES Logistics, ANNTO and JDIEX from TrackingMore\'s Chinese names', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['EES Logistics', 'ees-logistics'], ['EES', 'ees-logistics'], ['百福东方', 'ees-logistics'],
      ['ANNTO', 'annto'], ['安得智联', 'annto'], ['安得物流', 'annto'], ['JDIEX', 'jdiex'], ['JDI国际物流', 'jdiex'],
      ['JDI International Logistics', 'jdiex']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const [url, carrier] of [
      ['https://www.annto.com/order?orderNoFormMain=AB1000000017', 'annto'],
      ['https://www.jdiex.com/select.html?type=cnum&num=AB1000000017', 'jdiex'],
      ['https://www.jdiex.com/select.html?num=AB1000000017&type=cnum', 'jdiex'],
      ['https://oms.sumxpress.com/#/query?trackingNo=AB1000000017', 'sumxpress'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'AB1000000017', carrier, source: 'link' });
    }
    // the same page looks up a phone number when type is mobile
    expect(parseTrackingInput('https://www.jdiex.com/select.html?type=mobile&num=6260000000').carrier ?? 'none').not.toBe('jdiex');
  });
});

describe('SXJD, CPSZY, Valueway, Jiachen, LONGCPS, Bridge Intl, JiuFang and CEL Changda', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['SXJD Freight', 'sxjd-freight'], ['顺心捷达', 'sxjd-freight'], ['CPSZY', 'cpszy'],
      ['華中轉運', 'cpszy'], ['Valueway Express', 'valueway'], ['美通快递', 'valueway'],
      ['JIACHEN INTERNATIONAL', 'jiachen-express'], ['佳辰国际速递', 'jiachen-express'], ['LONGCPS', 'longcps'],
      ['龙行速运', 'longcps'], ['Bridge Intl', 'bridge-intl'], ['珀斯宏桥国际速递', 'bridge-intl'], ['JiuFang Logistics', 'jiufang'],
      ['九方通逊', 'jiufang'], ['CEL HCCD', 'cel-changda'], ['珲春畅达', 'cel-changda'], ['Jiacheng International', 'jcex']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const [url, carrier] of [
      ['https://www.cpszy.com/trace.html?sn=AB1000000017', 'cpszy'],
      ['https://www.jiachenexpress.com/select.html?num=AB1000000017', 'jiachen-express'],
      ['https://www.longcps.com/select.html?type=cnum&num=AB1000000017', 'longcps'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'AB1000000017', carrier, source: 'link' });
    }
    expect(parseTrackingInput('https://www.longcps.com/select.html?type=mobile&num=6470000000').carrier ?? 'none').not.toBe('longcps');
  });
});

describe('Kuayuan Express and CMT Express', () => {
  it('names the carriers from providers', () => {
    for (const [name, id] of [['Kuayuan Express', 'kuayuan-express'], ['跨源速递', 'kuayuan-express'], ['CMT', 'cmt-express'],
      ['诚贸通', 'cmt-express']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    // Kuayue, the express network, keeps its own name.
    expect(carrierIdFromName('Kuayue Express')).not.toBe('kuayuan-express');
  });
});

describe('Too Express, Go World, Shenghang, HZT, WLD, 3CQ, Banling, Jikuaida, HYE and Jet', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['TooExpress', 'too-express'], ['Too Express', 'too-express'], ['Go World Express', 'go-world-express'],
      ['行界物流', 'go-world-express'], ['Shenghang', 'shenghang'], ['盛航国际物流', 'shenghang'], ['HZT', 'hzt'], ['豪泽通', 'hzt'],
      ['Wld Express', 'wld-express'], ['万立德', 'wld-express'], ['3CQ', 'wangjing-3cq'], ['旺鲸', 'wangjing-3cq'],
      ['Banling', 'banling'], ['斑羚国际', 'banling'], ['ji Kuaida logistics', 'jikuaida'], ['吉快达物流', 'jikuaida'],
      ['HYE', 'hye'], ['环洋国际', 'hye'], ['Jet Global Express', 'jet-global'], ['捷通物流', 'jet-global']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const [url, carrier] of [
      ['https://www.shenghanggj.com/checkexpress?act=cx&order_tracking_search=AB1000000017', 'shenghang'],
      ['https://track.wjdrop.com/tracking/index?nums=AB1000000017', 'wangjing-3cq'],
      ['https://www.jikuaida.com/track.html?nums=AB1000000017', 'jikuaida'],
      ['https://www.jetft.com/tracking.html?order=AB1000000017', 'jet-global'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'AB1000000017', carrier, source: 'link' });
    }
    expect(parseTrackingInput('https://www.shenghanggj.com/checkexpress?order_tracking_search=AB1000000017').carrier ?? 'none')
      .not.toBe('shenghang');
  });
});

describe('Performance Freight, STG LTL, TSB and Senyu International', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['Performance Freight Systems, Inc.', 'performance-freight'], ['STG LTL', 'stg-ltl'],
      ['Frontline Freight', 'stg-ltl'], ['TSB', 'tsb-es'], ['Transdina Cargo', 'tsb-es'], ['Senyu International', 'senyu'],
      ['森屿国际', 'senyu'], ['Swift Span', 'senyu']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const [url, carrier] of [
      ['https://tracking.carrierlogistics.com/scripts/pfeg.pol/boldetail.htm?wbtn=PRO&wpro1=1000017', 'performance-freight'],
      ['https://tracking.carrierlogistics.com/scripts/pfeg.pol/facts.htm?pronum=1000017', 'performance-freight'],
      ['https://tracking.carrierlogistics.com/scripts/fro.pol/boldetail.htm?wbtn=PRO&wpro1=1000017', 'stg-ltl'],
      ['https://tracking.carrierlogistics.com/scripts/fro.pol/facts.htm?pronum=1000017', 'stg-ltl'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: '1000017', carrier, source: 'link' });
    }
  });
});

describe('LM Parcel, Emirates Courier Express, Viet An Express and ESPOIRER', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['LM Parcel', 'lm-parcel'], ['六脉速运', 'lm-parcel'], ['Emirates Courier Express', 'emirates-courier-express'],
      ['Emirates Courier', 'emirates-courier-express'], ['Viet An Express', 'viet-an-express'], ['Việt An Express', 'viet-an-express'],
      ['ESPOIRER', 'espoirer'], ['エスポ便', 'espoirer']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    expect(carrierIdFromName('Emirates Post')).toBe('emirates-post');
    for (const [url, number, carrier] of [
      ['https://www.lmparcel.com/search?nums=LM0123456789', 'LM0123456789', 'lm-parcel'],
      ['https://www.emiratescx.com/en/tracking-details?awb_number=123456789012', '123456789012', 'emirates-courier-express'],
      ['https://vietanexpress.com/tracking-2?tracking_num=1234567', '1234567', 'viet-an-express'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
  });

  it('suggests LM Parcel for LM and ten digits', () => {
    expect(detectCarrierMatch('LM0123456789').candidates).toContain('lm-parcel');
    for (const number of ['LM012345678', 'LM01234567890', 'LN0123456789', 'XLM0123456789']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('lm-parcel');
    }
  });
});

describe('Komon Express, BEL, ParcelABC, PAGO Logistics, Safe Way Express Cargo, W Express and Ecohai', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['Komon Express', 'komon-express'], ['可蒙快运', 'komon-express'], ['BEL', 'bel'], ['北俄国际', 'bel'],
      ['Parcelabc', 'parcelabc'], ['Parcel ABC', 'parcelabc'], ['Pago', 'pago'], ['派格国际物流', 'pago'],
      ['Safeway Express Cargo', 'safeway-express-cargo'], ['W Express Cargo Philippines', 'w-express-ph'], ['WWWExpress', 'w-express-ph'],
      ['Ecohai', 'ecohai'], ['エコ配', 'ecohai'], ['Dognposten', 'postnord'], ['Døgnposten', 'postnord']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    expect(carrierIdFromName('DHL Philippines')).not.toBe('w-express-ph');
    for (const [url, number, carrier] of [
      ['https://8256.kingtrans.cn/WebTrack?action=list&language=en&istrack=false&bills=BE1000000017', 'BE1000000017', 'bel'],
      ['https://www.parcelabc.com/track/GBUS-123456789', 'GBUS-123456789', 'parcelabc'],
      ['https://www.szpago.com/?number=PG1000000017', 'PG1000000017', 'pago'],
      ['https://www.safewayxp.com/track.php?awb=BH12345678', 'BH12345678', 'safeway-express-cargo'],
      ['https://www.wwwexpress.com.ph/track-and-trace/?trackingNo=1234567890', '1234567890', 'w-express-ph'],
      ['https://track.wwwexpress.com.ph/WExTrackAndTrace/trackAndTrace/trackAndTraceClient.htm?trackingNo=1234567890', '1234567890', 'w-express-ph'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
  });

  it('suggests Komon Express for KOMON, ten digits and YQ, and Safe Way for BH and eight digits', () => {
    expect(detectCarrierMatch('KOMON1234567890YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['komon-express'] });
    expect(detectCarrierMatch('BH12345678')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['safeway-express-cargo', 'tnt-it'] });
    for (const number of ['KOMON123456789YQ', 'KOMON12345678901YQ', 'KOMAN1234567890YQ', 'KOMON1234567890YZ']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('komon-express');
    }
    for (const number of ['BH1234567', 'BH123456789', 'BA12345678']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('safeway-express-cargo');
    }
    expect(detectCarrierMatch('GBUS123456789').candidates ?? []).not.toContain('parcelabc');
  });
});

describe('Aquiline, Wiio, UKP Worldwide, BTD and XYL', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['Aquiline', 'aquiline'], ['AQ Tracking', 'aquiline'], ['Wiio', 'wiio'], ['PD Express', 'wiio'],
      ['蓬达物流', 'wiio'], ['UKP Worldwide', 'ukp-worldwide'], ['UK Postings', 'ukp-worldwide'], ['BTD', 'btd'], ['宝通达', 'btd'],
      ['XYL', 'xyl'], ['兴远国际', 'xyl'], ['FDM', 'landmark-global'], ['Freight Distribution Management', 'landmark-global']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const name of ['UKP', 'Xingyuan']) expect(carrierIdFromName(name), name).toBeUndefined();
    for (const [url, number, carrier] of [
      ['https://aq-track.com/app/track/AQUAA1234567890YQ', 'AQUAA1234567890YQ', 'aquiline'],
      ['https://aquiline-tracking.com/app/?track=AQUAA1234567890YQ', 'AQUAA1234567890YQ', 'aquiline'],
      ['http://www.hzpdex.com:8082/trackIndex.htm?documentCode=ZLXAB1234567890CD', 'ZLXAB1234567890CD', 'wiio'],
      ['https://www.ukpworldwide.com/tracking/?x=WHISU123456789', 'WHISU123456789', 'ukp-worldwide'],
      ['https://816kf.kingtrans.cn/WebTrack?action=list&language=en&istrack=false&bills=XY1000000017', 'XY1000000017', 'xyl'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
  });

  it('suggests Aquiline, Wiio and UKP Worldwide for their own prefixes only', () => {
    for (const [number, carrier] of [['AQUAA1234567890YQ', 'aquiline'], ['ZLXAB1234567890CD', 'wiio'], ['WHISU123456789', 'ukp-worldwide']] as const) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: [carrier] });
    }
    for (const number of ['AQUAB1234567890YQ', 'AQUAA123456789YQ', 'AQUAA1234567890YZ', 'ZLXA11234567890CD', 'ZLXAB123456789CD',
      'ZLYAB1234567890CD', 'WHISU12345678', 'WHISU1234567890', 'WHISA123456789']) {
      const candidates = detectCarrierMatch(number).candidates ?? [];
      for (const carrier of ['aquiline', 'wiio', 'ukp-worldwide']) expect(candidates, number).not.toContain(carrier);
    }
  });
});

describe('Asiafly, ShunBang Express, Topex Logistics, 360Lion, Cititrans, SYD Express, We World Express, Vnlin and XingYunYi', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['ASIAFLY', 'asiafly'], ['亚翔国际', 'asiafly'], ['KJY', 'shunbang-express'], ['ShunBang', 'shunbang-express'],
      ['顺邦科技物流', 'shunbang-express'], ['迅派物流', 'topex-logistics'], ['Topex Logistics', 'topex-logistics'], ['WSH', '360lion'],
      ['360 Lion', '360lion'], ['纬狮物流', '360lion'], ['Wish Global Logistics', '360lion'], ['CITITRANS', 'cititrans'], ['亦邦物流', 'cititrans'],
      ['SYD', 'syd'], ['速邮达物流', 'syd'], ['We World Express', 'we-world-express'], ['WeWorld Express', 'we-world-express'],
      ['Vnlin', 'vnlin'], ['合聯國際', 'vnlin'], ['Winlink Logistics', 'vnlin'], ['XYY / XingYunYi', 'xingyunyi'], ['行运易物流', 'xingyunyi']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const name of ['TOPEX', '速邮达']) expect(carrierIdFromName(name), name).toBeUndefined();
    expect(carrierIdFromName('WWE')).not.toBe('we-world-express');
    for (const [url, number, carrier] of [
      ['https://www.asiaflyexp.com/order-search.html?no=AF1000000017', 'AF1000000017', 'asiafly'],
      ['https://toms.360lion.com/track?trackNumber=LN1000000017', 'LN1000000017', '360lion'],
      ['https://sud.kingtrans.cn/WebTrack?action=list&language=en&istrack=false&bills=SY1000000017', 'SY1000000017', 'syd'],
      ['https://www.xingyunyi.com/tracking?nums=XY1000000017', 'XY1000000017', 'xingyunyi'],
      ['https://www.xingyunyi.cn/cn/tracking?nums=XY1000000017', 'XY1000000017', 'xingyunyi'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
  });

  it('suggests 360Lion and We World Express for their prefixes, two letters, ten digits and YQ', () => {
    expect(detectCarrierMatch('WSHMX1234567890YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['360lion'] });
    expect(detectCarrierMatch('WWETA1234567890YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['we-world-express'] });
    for (const number of ['WSHM11234567890YQ', 'WSHMX123456789YQ', 'WSHMX1234567890YZ', 'WWETA12345678901YQ', 'WWET11234567890YQ', 'WWXTA1234567890YQ']) {
      const candidates = detectCarrierMatch(number).candidates ?? [];
      expect(candidates, number).not.toContain('360lion');
      expect(candidates, number).not.toContain('we-world-express');
    }
  });
});

describe('Ecom Logistics, FragilePAK, HKD Express, Canada Air Express, Bombax and SM Express', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['Ecom Logistics', 'ecom-logistics'], ['ShipEcom', 'ecom-logistics'], ['FragilePAK', 'fragilepak'],
      ['Hkdexpress', 'hkd-express'], ['昊坤达国际物流', 'hkd-express'], ['Canada Air Express', 'canada-air-express'],
      ['加拿大民航快递', 'canada-air-express'], ['bombax', 'bombax'], ['SM Express', 'sm-express'], ['GLOBALTRANS', 'gls-es']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const [url, number, carrier] of [
      ['https://shipecom.com/fr/track/E12A3456789', 'E12A3456789', 'ecom-logistics'],
      ['https://tracking.agentgrid.net/progistics/?id=ZZ1000000017', 'ZZ1000000017', 'fragilepak'],
      ['https://main.air-gtc.cn/WaybillInfo.aspx?KeyWord=GT1000000017', 'GT1000000017', 'canada-air-express'],
      ['https://book.bombax.in/booking/Tracking?OrderNo=BX1000000017', 'BX1000000017', 'bombax'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
  });

  it('suggests Ecom Logistics for E, two digits, a letter and seven digits only', () => {
    expect(detectCarrierMatch('E12A3456789')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ecom-logistics'] });
    for (const number of ['E1A23456789', 'F12A3456789', 'E12A345678', 'E12A34567890', 'E123456789A']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ecom-logistics');
    }
  });

  it('suggests FragilePAK for 902, six digits and a digit or X', () => {
    expect(detectCarrierMatch('902123463X')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['fragilepak'] });
    expect(detectCarrierMatch('9021234563').candidates).toContain('fragilepak');
    for (const number of ['9031234565', '902123463Y', '90212345656', '902123456']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fragilepak');
    }
  });
});

describe('UVAN, Fast World Logistic, TIG Freight and YHA Logistics', () => {
  it('names the carriers from providers and reads their tracker links', () => {
    for (const [name, id] of [['UVAN', 'uvan'], ['宇环国际物流', 'uvan'], ['Fast World Logistic - FWL', 'fastwl'], ['FastWL', 'fastwl'],
      ['TIG Freight', 'tig-freight'], ['YHA', 'yha'], ['越航物流', 'yha'], ['Easyway PEK', 'pecom'], ['ПЭК: EASYWAY', 'pecom'],
      ['VIR Transport', 'jp-home']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
    for (const name of ['FWL', 'TIG']) expect(carrierIdFromName(name), name).toBeUndefined();
    expect(parseTrackingInput('https://www.fastwl.com/suivre-un-colis/?trackingNumber=FW1000000017')).toMatchObject({
      trackingNumber: 'FW1000000017', carrier: 'fastwl', source: 'link',
    });
    expect(parseTrackingInput('https://www.yha56.com/page/indexDetail/indexDetail2.html?manifestId=YH100000017')).toMatchObject({
      trackingNumber: 'YH100000017', carrier: 'yha', source: 'link',
    });
  });

  it('keeps a partner carrier\'s number on a TIG Freight link with that carrier', () => {
    expect(parseTrackingInput('https://tracking.open360.com/tracking/ABC1000000017')).toMatchObject({
      trackingNumber: 'ABC1000000017', carrier: 'tig-freight', source: 'link',
    });
    expect(parseTrackingInput('https://tracking.open360.com/tracking/1Z999AA10123456784')).toMatchObject({
      trackingNumber: '1Z999AA10123456784', carrier: 'ups', source: 'link',
    });
  });
});

describe('Sending, YWE and ECMS Express links', () => {
  it('reads Sending\'s tracker link', () => {
    expect(parseTrackingInput('https://info.sending.es/fgts/pub/locNumSeguimiento.seam?web=S&localizador=100000000017')).toMatchObject({
      trackingNumber: '100000000017', carrier: 'sending', source: 'link',
    });
  });

  it('names YWE from its tracker link only for its own numbers', () => {
    expect(parseTrackingInput('https://www.yanwenexpress.com/tracking.html?label=YWE10000000000017')).toMatchObject({
      trackingNumber: 'YWE10000000000017', carrier: 'ywe', source: 'link',
    });
    expect(parseTrackingInput('https://www.yanwenexpress.com/tracking.html?label=YWABC100000000017')).toMatchObject({
      trackingNumber: 'YWABC100000000017', carrier: 'yanwen', source: 'link',
    });
  });

  it('reads both query names of ECMS tracking pages', () => {
    for (const url of ['https://www.ecmsglobal.com/en-us/tracking.html?number=ECABC10000000017',
      'https://www.ecmsglobal.com/en-uk/tracking.html?orderNumber=ECABC10000000017']) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'ECABC10000000017', carrier: 'ecms-express', source: 'link' });
    }
  });
});

describe('Parcel Freight Logistics numbers', () => {
  it('suggests Parcel Freight Logistics for NEXAU, ten digits and YQ only', () => {
    expect(detectCarrierMatch('NEXAU1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['pflogistics'] });
    for (const number of ['ABCAU1000000017YQ', 'NEXUS1000000017YQ', 'NEXAU100000017YQ', 'NEXAU1000000017YT']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('pflogistics');
    }
    expect(parseTrackingInput('https://pflogistics.com.au/tracking-result?tracking=NEXAU1000000017YQ')).toMatchObject({
      trackingNumber: 'NEXAU1000000017YQ', carrier: 'pflogistics', source: 'link',
    });
  });
});

describe('Dakota Cargo numbers, and Sentral Cargo links', () => {
  it('suggests Dakota Cargo for a branch code, month, year, A and six digits', () => {
    const match = detectCarrierMatch('001012026A000017');
    expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(match.candidates).toContain('dakota-cargo');
    for (const number of ['001132026A000017', '001011926A000017', '0010120260000017', '001012026B000017', '001012026A00001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dakota-cargo');
    }
  });

  it('reads Sentral Cargo tracking links', () => {
    for (const link of ['https://sentralcargo.co.id/cekresi?resi=1000017', 'https://sentralcargo.co.id/en/tracking?resi=1000017']) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: '1000017', carrier: 'sentral-cargo', source: 'link' });
    }
  });
});

describe('Kuayue Express waybills and links', () => {
  it('names Kuayue Express for KY and thirteen digits, and only that layout', () => {
    for (const number of ['KY1000000000017', 'ky 1000000000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'kuayue-express', confidence: 'high' });
    }
    for (const number of ['KY100000000017', 'KY10000000000017', 'KYE100000000017', 'KX1000000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('kuayue-express');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('kuayue-express');
    }
    expect(carrierIdFromName('跨越速运')).toBe('kuayue-express');
    expect(carrierIdFromName('KY Express')).toBe('kuayue-express');
  });

  it('reads its search page, its frame and its mobile route page', () => {
    for (const url of [
      'https://www.ky-express.com/88.html?tab=3&orders=KY1000000000017',
      'https://u.ky-express.com/diyServiceNews?tab=3&v=2.0&orders=KY1000000000017',
      'https://ic-h5.kye-erp.com/waybill-route.html#/?isShowMarketing=1&waybillNo=KY1000000000017',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'KY1000000000017', carrier: 'kuayue-express', source: 'link' });
    }
  });
});

describe('Tonami and Okaken links and names', () => {
  it('reads Tonami\'s tracker and leaves both carriers\' ten digits unruled', () => {
    expect(parseTrackingInput('https://trc1.tonami.co.jp/trc/search3/excSearch3?id%5B0%5D=1000000017')).toMatchObject({
      trackingNumber: '1000000017', carrier: 'tonami', source: 'link',
    });
    for (const carrier of ['tonami', 'okaken']) expect(detectCarrierMatch('1000000017').candidates).not.toContain(carrier);
    expect(carrierIdFromName('トナミ運輸')).toBe('tonami');
    expect(carrierIdFromName('岡山県貨物運送')).toBe('okaken');
    expect(carrierIdFromName('Okayamaken Freight Transportation')).toBe('okaken');
  });
});

describe('Inter Express Logistics and four Australian and New Zealand carriers', () => {
  it('suggests IEL for its own prefix with a valid month and day only', () => {
    expect(detectCarrierMatch('IEL6012300017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['inter-express-logistics'] });
    for (const number of ['IEL6132300017', 'IEL6013200017', 'IEL601230001', 'FCD6012300017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('inter-express-logistics');
    }
  });

  it('reads their tracker links and names', () => {
    for (const [url, number, carrier] of [
      ['https://iel.co.th/tracking/?trackingNo=IEL6012300017', 'IEL6012300017', 'inter-express-logistics'],
      ['https://iel.co.th/en/tracking/?trackingNo=IEL6012300017', 'IEL6012300017', 'inter-express-logistics'],
      ['https://www.centurion.net.au/TrackAndTrace/?track=on&con=AB10000017', 'AB10000017', 'centurion-transport'],
      ['https://my.kiwiexpress.co.nz/barcode/KO1000000017', 'KO1000000017', 'kiwi-express'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
    expect(carrierIdFromName('IEL - Inter Express Logistics')).toBe('inter-express-logistics');
    expect(carrierIdFromName('อินเตอร์ เอ็กซ์เพรส โลจิสติกส์')).toBe('inter-express-logistics');
    expect(carrierIdFromName('Centurion Transport Co')).toBe('centurion-transport');
    expect(carrierIdFromName('AirRoad Pty Ltd')).toBe('airroad');
    expect(carrierIdFromName('Janala Pty Limited')).toBe('cope-sensitive-freight');
    expect(carrierIdFromName('Kiwi Oversize')).toBe('kiwi-express');
  });
});

describe('ETS Express and Rincos', () => {
  it('suggests ETS Express for its RETS code only', () => {
    expect(detectCarrierMatch('RETS100000000017UES')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ets-express'] });
    for (const number of ['RETS10000000017UES', 'RETS1000000000017UES', 'RETS100000000017US', 'RETX100000000017UES']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ets-express');
    }
  });

  it('leaves Rincos numbers to the carriers that share fourteen digits', () => {
    expect(detectCarrierMatch('82100000000017').candidates ?? []).not.toContain('rincos');
  });

  it('reads their tracker links and names', () => {
    for (const url of [
      'https://www.rincos.asia/out/TraceInfo_kr.do?SCGBN=20&P_VAL=82100000000017',
      'https://www.rincos.asia/out/TraceInfo_en.do?SCGBN=20&P_VAL=82100000000017',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: '82100000000017', carrier: 'rincos', source: 'link' });
    }
    expect(carrierIdFromName('RETS')).toBe('ets-express');
    expect(carrierIdFromName('俄通收国际物流')).toBe('ets-express');
    expect(carrierIdFromName('주식회사 린코스')).toBe('rincos');
    expect(carrierIdFromName('Globegistics Inc.')).toBe('asendia');
  });
});

describe('KEC eCommerce and TheLorry', () => {
  it('suggests TheLorry for TLZ and seven digits only', () => {
    expect(detectCarrierMatch('TLZ1000007').candidates).toContain('thelorry');
    for (const number of ['TLZ100007', 'TLZ10000007', 'TLX1000007']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('thelorry');
    }
  });

  it('leaves the numbers KEC eCommerce tracks to their own carriers', () => {
    expect(detectCarrierMatch('KECID10000007').candidates ?? []).not.toContain('kec-ecommerce');
    expect(detectCarrierMatch('YT2532100000000017')).toMatchObject({ carrier: 'yunexpress', confidence: 'high' });
  });

  it('reads their tracker links and names', () => {
    for (const url of [
      'https://kec.kln.com/en/logistics-tracking/?tracking=KECID10000007',
      'https://kec.kln.com/hk/track-trace/?tracking=KECID10000007',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'KECID10000007', carrier: 'kec-ecommerce', source: 'link' });
    }
    for (const url of [
      'https://tracking.thelorry.com/parcel/tracking/TLZ1000007',
      'https://bookings.thelorry.com/my/web/tracking/TLZ1000007',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'TLZ1000007', carrier: 'thelorry', source: 'link' });
    }
    expect(carrierIdFromName('Kerry eCommerce')).toBe('kec-ecommerce');
    expect(carrierIdFromName('嘉順達')).toBe('kec-ecommerce');
    expect(carrierIdFromName('The Lorry')).toBe('thelorry');
  });
});

describe('ZES Express, Profit Fields, AllJoy, DPE Express and Goodmaji', () => {
  it('suggests each forwarder for its own prefix only', () => {
    expect(detectCarrierMatch('ZESZE1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['zes-express'] });
    expect(detectCarrierMatch('EWSUS1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['profit-fields'] });
    expect(detectCarrierMatch('ALJTR2601010000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['alljoy'] });
    expect(detectCarrierMatch('ALJCD1000000017YQ')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['alljoy'] });
    for (const number of ['ZESZE100000017YQ', 'ZESXX1000000017YQ', 'EWSUS1000000017', 'EWS1000000017YQ', 'ALJTR260101000017', 'ALJCD1000000017']) {
      const candidates = detectCarrierMatch(number).candidates ?? [];
      for (const carrier of ['zes-express', 'profit-fields', 'alljoy']) expect(candidates, number).not.toContain(carrier);
    }
  });

  it('leaves DPE Express waybills to the carriers that share eleven digits', () => {
    expect(detectCarrierMatch('10000000017').candidates ?? []).not.toContain('dpe-express');
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://www.8dt.com/tracking?track=EWSUS1000000017YQ'))
      .toMatchObject({ trackingNumber: 'EWSUS1000000017YQ', carrier: 'profit-fields', source: 'link' });
    expect(parseTrackingInput('https://web.alljoylogistics.com/track?order=ALJTR2601010000017'))
      .toMatchObject({ trackingNumber: 'ALJTR2601010000017', carrier: 'alljoy', source: 'link' });
    expect(carrierIdFromName('Eshun International Logistics')).toBe('zes-express');
    expect(carrierIdFromName('俄顺国际物流')).toBe('zes-express');
    expect(carrierIdFromName('EWS Profit Fields')).toBe('profit-fields');
    expect(carrierIdFromName('8DT')).toBe('profit-fields');
    expect(carrierIdFromName('全和悦')).toBe('alljoy');
    expect(carrierIdFromName('递必易')).toBe('dpe-express');
    expect(carrierIdFromName('好馬吉')).toBe('goodmaji');
  });
});

describe('LEX Malaysia, DEX Pakistan, ShipGlobal India, Parxl, EFS Asia and Faster Express', () => {
  it('names DEX Pakistan from its hyphenated prefix and suggests LEX and ShipGlobal for their own layouts', () => {
    for (const number of ['PK-DEX100000017', 'pk DEX 100000017', 'PKDEX100000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'dex-pk', confidence: 'high' });
    }
    expect(detectCarrierMatch('TMYLE100000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['lex-my'] });
    expect(detectCarrierMatch('SG32610010000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['shipglobal-in'] });
    for (const number of ['PK-DEX10000017', 'LK-DEX-100000017', 'TMYLE10000017', 'TMYSU100000017', 'SG32613010000017', 'SG32610320000017', 'SG3261001000017']) {
      const candidates = detectCarrierMatch(number).candidates ?? [];
      for (const carrier of ['dex-pk', 'lex-my', 'shipglobal-in']) expect(candidates, number).not.toContain(carrier);
    }
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://lex.com.my/tracking?references=TMYLE100000017'))
      .toMatchObject({ trackingNumber: 'TMYLE100000017', carrier: 'lex-my', source: 'link' });
    expect(parseTrackingInput('https://www.dex.com.pk/tracking?references=PK-DEX100000017'))
      .toMatchObject({ carrier: 'dex-pk', source: 'link' });
    expect(parseTrackingInput('https://shipglobal.in/tracking/?awb=SG32610010000017'))
      .toMatchObject({ trackingNumber: 'SG32610010000017', carrier: 'shipglobal-in', source: 'link' });
    expect(parseTrackingInput('https://track.parxl.com/PX10000017')).toMatchObject({ trackingNumber: 'PX10000017', carrier: 'parxl', source: 'link' });
    expect(parseTrackingInput('https://web.efs.asia/script/users/tracking.php?search_no=EFS10000017&mode=search&lang='))
      .toMatchObject({ trackingNumber: 'EFS10000017', carrier: 'efs-asia', source: 'link' });
    expect(parseTrackingInput('https://faster.ae/track?no=FST10000000017')).toMatchObject({ trackingNumber: 'FST10000000017', carrier: 'faster-ae', source: 'link' });
    expect(carrierIdFromName('Lazada Express Malaysia')).toBe('lex-my');
    expect(carrierIdFromName('Daraz Express Pakistan')).toBe('dex-pk');
    expect(carrierIdFromName('DEX PK')).toBe('dex-pk');
    expect(carrierIdFromName('Ship Global Express')).toBe('shipglobal-in');
    expect(carrierIdFromName('SIA Parxl')).toBe('parxl');
    expect(carrierIdFromName('이에프에스')).toBe('efs-asia');
    expect(carrierIdFromName('迅捷中东物流')).toBe('faster-ae');
    // Lazada and Daraz run their networks in several countries on separate sites.
    expect(carrierIdFromName('Lazada Express')).toBeUndefined();
    expect(carrierIdFromName('Daraz Express')).toBeUndefined();
  });
});

describe('Shipter, Tonda Global, Liuchen, EAC and LBTX', () => {
  it('suggests Shipter for its own layout beside the broad Colis Privé shape', () => {
    expect(detectCarrierMatch('H3AU100017KR')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['shipter']) });
    for (const number of ['H3AU10017KR', 'H3AU1000017KR', 'H3A1100017KR', 'H4AU100017KR', 'H3AU100017CN']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('shipter');
    }
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://www.shipter.kr/tracking/H3AU100017KR'))
      .toMatchObject({ trackingNumber: 'H3AU100017KR', carrier: 'shipter', source: 'link' });
    expect(parseTrackingInput('https://shiptertracking.com/trackingResult/H3AU100017KR'))
      .toMatchObject({ trackingNumber: 'H3AU100017KR', carrier: 'shipter', source: 'link' });
    expect(parseTrackingInput('https://www.tarrive.com/track?q=TD1000000017'))
      .toMatchObject({ trackingNumber: 'TD1000000017', carrier: 'tonda-global', source: 'link' });
    expect(parseTrackingInput('https://www.liuchenwl.com/index/tracknumber/track?nos=LC1000000017'))
      .toMatchObject({ trackingNumber: 'LC1000000017', carrier: 'liuchen', source: 'link' });
    expect(carrierIdFromName('H3 Networks')).toBe('shipter');
    expect(carrierIdFromName('通达全球')).toBe('tonda-global');
    expect(carrierIdFromName('六尘物流')).toBe('liuchen');
    expect(carrierIdFromName('富皇美运')).toBe('eac-cn');
    expect(carrierIdFromName('龙本天下')).toBe('lbtx');
  });
});

describe('Super Parcel Track, Ural Express, Onex, GCX, Tusou and Wise Express', () => {
  it('reads Super Parcel Track\'s and Ant Parcel\'s tracker links, and names Ant Parcel as Super Parcel Track', () => {
    for (const url of ['https://track-sp.com/tracking/detail?tracking_num=AP0000000001', 'https://ant-parcel.com/tracking/detail?tracking_num=AP0000000001',
      'https://ant-parcel.com/tracking/detail/AP0000000001']) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'AP0000000001', carrier: 'super-parcel-track', source: 'link' });
    }
    expect(carrierIdFromName('Ant Parcel')).toBe('super-parcel-track');
  });

  it('reads their names and Tusou\'s tracker links', () => {
    expect(parseTrackingInput('https://tusou.kingtrans.net/WebTrack?action=list&language=en&istrack=false&bills=TS1000000017'))
      .toMatchObject({ trackingNumber: 'TS1000000017', carrier: 'tusou', source: 'link' });
    expect(carrierIdFromName('Super Parcel')).toBe('super-parcel-track');
    expect(carrierIdFromName('乌拉尔国际物流')).toBe('ural-express');
    expect(carrierIdFromName('Onex Armenia')).toBe('onex');
    expect(carrierIdFromName('Global Courier Express')).toBe('gcx');
    expect(carrierIdFromName('图搜网络科技')).toBe('tusou');
    expect(carrierIdFromName('万色速递')).toBe('wise-express');
    // WanB Express is a different company.
    expect(carrierIdFromName('WanB Express')).not.toBe('wise-express');
  });

  it('leaves the inbound carrier\'s number on an Onex tracker link to that carrier', () => {
    // Onex tracks parcels by the number of the carrier that brought them to its warehouse.
    expect(parseTrackingInput('https://onex.am/en/onextrack?track=RR100000017AM').carrier).not.toBe('onex');
  });
});

describe('Morning Global waybills', () => {
  it('suggests Morning Global for BR, nine digits and MG that fail the S10 check, and asks it', () => {
    expect(detectCarrierMatch('BR000000017MG')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['morning-global'] });
    expect(recognitionAskedCarriers('BR000000017MG')).toEqual(['morning-global']);
    expect(detectCarrierMatch('BR000000014MG').carrier).toBe('intl-post');
    for (const number of ['BR00000017MG', 'BR0000000017MG', 'BX000000017MG', 'BR000000017MX', 'HK000000017PH01']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('morning-global');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('morning-global');
    }
  });
});

describe('Holisol, and four Australian couriers', () => {
  it('reads their trackers\' links', () => {
    for (const [url, trackingNumber, carrier] of [
      ['https://www.holisoldelivery.com/api/tracking/TrackAwb?awb=HL00000000001', 'HL00000000001', 'holisol'],
      ['https://online.amaldist.com.au/track/?item=1000001', '1000001', 'amalgamated-distribution'],
      ['https://web.victorianfreight.com.au/webconsignment/FTSSearch-v2.aspx?connum=1000001', '1000001', 'victorian-freight-specialists'],
      ['https://portal.vtfe.com.au/Track/VTFE/ZZZZ0000001', 'ZZZZ0000001', 'vt-freight-express'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber, carrier, source: 'link' });
    }
  });

  it('names them from their names', () => {
    expect(carrierIdFromName('Holisol Logistics')).toBe('holisol');
    expect(carrierIdFromName('Bonds Transport Group')).toBe('bonds-couriers');
    expect(carrierIdFromName('Amaldist')).toBe('amalgamated-distribution');
    expect(carrierIdFromName('Victorian Freight Specialists')).toBe('victorian-freight-specialists');
    expect(carrierIdFromName('VicTas Freight Express')).toBe('vt-freight-express');
  });
});

describe('FM Transportes, Fez Delivery, LEX Vietnam, BEST Express Thailand, J&T Express Egypt, EGXPRESS and fourteen more', () => {
  it('names FM Transportes from its dated codes and suggests the others for their own layouts', () => {
    for (const number of ['010125A00000000001', '311224ZZ0000000001', '290226000000000A01']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'fm-transportes', confidence: 'high' });
    }
    // Zeleris keeps its own layout inside the dated shape.
    expect(detectCarrierMatch('010125AB000000000Z')).toMatchObject({ carrier: 'zeleris', confidence: 'high' });
    for (const [number, carrier] of [
      ['0AAA01012501', 'fez-delivery'], ['AAAA31122401', 'fez-delivery'],
      ['LMP0000000001VNA', 'lex-vn'], ['LEXST0000000001VN', 'lex-vn'], ['LEXRT0000000001VNA', 'lex-vn'],
      ['66850000000001', 'best-express-th'], ['JEG000000000001', 'j-and-t-eg'],
      ['FED2026010100000001', 'egxpress'], ['FED2025123100000002', 'egxpress'],
    ] as const) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining([carrier]) });
    }
    for (const number of [
      '010125000000000001', '320125A00000000001', '011325A00000000001', '010119A00000000001', '010125A0000000001',
      'AB0001012501', 'ABC001012501', '1G0A01012501', 'ASE001012501', '0AAA32012501', '0AAA01132501', '0AAA01011901',
      'LMP000000001VNA', 'LMP0000000001VN', 'LMP0000000001MYA', 'LEXST0000000001VNA', 'LEXRT0000000001VN',
      '6685000000001', '668500000000001', '66820000000001', 'JEG00000000001', 'JEG0000000000001', 'JTE000000000001',
      'FED2026130100000001', 'FED2026013200000001', 'FED1926010100000001', 'FED202601010000001',
    ]) {
      const { carrier, candidates = [] } = detectCarrierMatch(number);
      for (const id of ['fm-transportes', 'fez-delivery', 'lex-vn', 'best-express-th', 'j-and-t-eg', 'egxpress']) {
        expect([carrier, ...candidates], number).not.toContain(id);
      }
    }
  });

  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://rastreio.fmtransportes.com.br/#/010125A00000000001'))
      .toMatchObject({ trackingNumber: '010125A00000000001', carrier: 'fm-transportes', source: 'link' });
    expect(parseTrackingInput('https://web.fezdelivery.co/track-delivery/0AAA01012501'))
      .toMatchObject({ trackingNumber: '0AAA01012501', carrier: 'fez-delivery', source: 'link' });
    expect(parseTrackingInput('https://logistics.lazada.vn/tracking?references=LMP0000000001VNA'))
      .toMatchObject({ trackingNumber: 'LMP0000000001VNA', carrier: 'lex-vn', source: 'link' });
    expect(parseTrackingInput('https://www.best-inc.co.th/wapp/track?waybill=66850000000001'))
      .toMatchObject({ trackingNumber: '66850000000001', carrier: 'best-express-th', source: 'link' });
    expect(parseTrackingInput('https://www.jtexpress-eg.com/trajectoryQuery?waybillNo=JEG000000000001'))
      .toMatchObject({ trackingNumber: 'JEG000000000001', carrier: 'j-and-t-eg', source: 'link' });
    expect(parseTrackingInput('https://tcc.com.co/rastreo/?documento=000000001'))
      .toMatchObject({ trackingNumber: '000000001', carrier: 'tcc-co', source: 'link' });
    expect(parseTrackingInput('https://tcc.com.co/rastreo/?tipo=PE&documento=000000001').carrier).not.toBe('tcc-co');
    expect(parseTrackingInput('https://logistics.airspeed.com.ph/track/TrackingSearch.aspx?waybill=000000001'))
      .toMatchObject({ trackingNumber: '000000001', carrier: 'airspeed', source: 'link' });
    for (const [name, id] of [
      ['TCC', 'tcc-co'], ['FM Transportes', 'fm-transportes'], ['X-Cargo', 'xcargo'], ['Paket Chile', 'paket-cl'],
      ['Fez Delivery', 'fez-delivery'], ['FamiPort', 'famiport'], ['全統物流', 'ctc-express'], ['便利帶', 'maple-logistics'],
      ['Seino Super Express', 'seino-super-express'], ['TA-Q-BIN Hong Kong', 'taqbin-hk'], ['Safexpress', 'safexpress'],
      ['MOVIN Express', 'movin'], ['Lazada Express Vietnam', 'lex-vn'], ['BEST Express Thailand', 'best-express-th'],
      ['Airspeed', 'airspeed'], ['J&T Express Egypt', 'j-and-t-eg'], ['Egypt Express', 'egxpress'], ['Tawssil', 'tawssil'],
      ['ASE Express', 'ase-express'], ['Zimbabwe Post', 'zimpost'],
    ] as const) expect(carrierIdFromName(name), name).toBe(id);
    // Seino Super Express and TA-Q-BIN Hong Kong keep their own names apart from Seino Transportation's and Yamato's.
    expect(carrierIdFromName('Seino')).not.toBe('seino-super-express');
    expect(carrierIdFromName('Yamato')).not.toBe('taqbin-hk');
  });
});

describe('SPT Express, Hitch, Consegnia, FMX, JANCO Express, ARK Express, Fastgo and twenty-seven more', () => {
  it('names Consegnia from its CLC numbers and suggests the others for their own layouts', () => {
    expect(detectCarrierMatch('CLC000000001')).toMatchObject({ carrier: 'consegnia', confidence: 'high', candidates: ['consegnia'] });
    for (const [number, carrier] of [
      ['SPT000000000001YQ', 'sptexp'], ['ZIP000000000001', 'hitch'], ['ZIPA0000000000B', 'hitch'],
      ['MYX0000000001', 'fmx'], ['JEAA00000001', 'janco-express'], ['JEZY00000001', 'janco-express'],
      ['AP0000001AU', 'ark-express'], ['AU000000001SG', 'fastgo'],
    ] as const) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining([carrier]) });
    }
    // Huahan keeps its own YQ layout, StarTrack its Z fourth letter, and Singapore Post its valid S10 numbers.
    expect(detectCarrierMatch('HHWAA0000000001YQ')).toMatchObject({ carrier: 'huahan', confidence: 'high' });
    expect(detectCarrierMatch('AU000000005SG')).toMatchObject({ carrier: 'singapore-post', confidence: 'high' });
    for (const number of [
      'SPT00000000001YQ', 'SPT0000000000001YQ', 'SPX000000000001YQ', 'SPT000000000001YX', 'HHWAA0000000001YQ',
      'ZIP00000000001', 'ZIP0000000000001', 'ZIQ000000000001', 'CLC00000001', 'CLC0000000001', 'CLD000000001',
      'MYX000000001', 'MYX00000000001', 'MYY0000000001', 'JEAZ00000001', 'JEA000000001', 'JEAA0000001', 'JEAA000000001',
      'AP00000001AU', 'AP000000005AU', 'AP000001AU', 'AU000000005SG', 'AU00000001SG', 'AU0000000001SG', 'AV000000001SG',
    ]) {
      const { carrier, candidates = [] } = detectCarrierMatch(number);
      for (const id of ['sptexp', 'hitch', 'consegnia', 'fmx', 'janco-express', 'ark-express', 'fastgo']) {
        expect([carrier, ...candidates], number).not.toContain(id);
      }
    }
  });

  it('reads their tracker links and names', () => {
    for (const [url, trackingNumber, carrier] of [
      ['https://www.sst.lt/en/sekti/000000001/', '000000001', 'nege'],
      ['https://spt-de.eu/status/index.html?key=000000001', '000000001', 'spt-logistics'],
      ['https://wpl-uk.couriernavigator-secure.com/tracking?consign_note=000000001', '000000001', 'world-package'],
      ['https://www.elog-luxembourg.com/tracking?q=000000001', '000000001', 'elog-luxembourg'],
      ['https://webtrackingprod.laposte.tg/WebTracking/IPSWeb_item_events.aspx?itemid=RR000000005TG', 'RR000000005TG', 'togo-post'],
      ['https://post.tm/tracking?q=RR000000005TM', 'RR000000005TM', 'turkmenpost'],
      ['https://thabit-logistics.com/track-shipment/000000001', '000000001', 'thabit-logistics'],
      ['https://portal.citisprint.co.za/track?ref=000000001', '000000001', 'citi-sprint'],
      ['https://hitch.com.ph/tracking?no=ZIP000000000001', 'ZIP000000000001', 'hitch'],
      ['https://clc-express.com/track-delivery?awb=CLC000000001', 'CLC000000001', 'consegnia'],
      ['https://www.fmx.asia/cn/result_detail.php?conno=MYX0000000001', 'MYX0000000001', 'fmx'],
      ['https://track.fgmailconnect.co.nz/GSS000000001', 'GSS000000001', 'freightways-global'],
      ['https://track.jancoexpress.com/cargotracking_xp/itxp/xpop/xpordertrack?as_order_no=JEAA00000001', 'JEAA00000001', 'janco-express'],
      ['https://corporate.apxlog.com/trc/tracking.php?id=000000001', '000000001', 'apx-logistics'],
      ['https://www.usasd.com/index.php?sn=000000001', '000000001', 'usasd'],
      ['https://jcwexpress.com/tracking?codes=000000001', '000000001', 'jcw-express'],
      ['https://myxmiles.com/?tracking_number=000000001', '000000001', 'xlmiles'],
      ['https://www.superb-express.com/site/searchview?tracking_code=000000001', '000000001', 'superb-express'],
      ['https://express.arkexpress.com.au/q?s=AP0000001AU', 'AP0000001AU', 'ark-express'],
      ['https://www.fastgo.com.au/WaybillQuery/?bill=AU000000001SG', 'AU000000001SG', 'fastgo'],
      ['https://www.parcelmate.co.nz/track?keywords=000000001', '000000001', 'chinz-logistics'],
      ['https://www.airwingsindia.com/tracking.html?awbno=000000001', '000000001', 'airwings-india'],
      ['https://crm.markerp.in/Frm_DocTrackWeb.aspx?docno=000000001', '000000001', 'mark-express'],
      ['https://shipx.asia/vi/toolkit/shipment-tracker?trackingNumber=000000001', '000000001', 'shipx-asia'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber, carrier, source: 'link' });
    }
    for (const [name, id] of [
      ['SPT', 'sptexp'], ['速派通', 'sptexp'], ['SST Express', 'nege'], ['SPT Furniture Logistics', 'spt-logistics'],
      ['World Package Logistics', 'world-package'], ['eLOG Luxembourg', 'elog-luxembourg'], ['La Poste du Togo', 'togo-post'],
      ['Türkmenpoçta', 'turkmenpost'], ['Thabit Logistics', 'thabit-logistics'], ['Citi-Sprint', 'citi-sprint'],
      ['Zip PH', 'hitch'], ['Consegnia', 'consegnia'], ['Freight Mark Express', 'fmx'], ['Sure-Reach', 'm-xpress'],
      ['Freightways Global', 'freightways-global'], ['JANCO Express', 'janco-express'], ['V-Xpress', 'v-xpress'],
      ['Tapuz', 'tapuz-delivery'], ['APX Logistics', 'apx-logistics'], ['S & D Logistics', 'usasd'], ['玥玛速运', 'yuema-express'],
      ['Yoseus', 'yoseus'], ['JCW Express', 'jcw-express'], ['Xmiles', 'xlmiles'], ['派通国际物流', 'patuen'],
      ['Superb Express', 'superb-express'], ['ProMed Delivery', 'promed-delivery'], ['XD Express', 'xd-express'],
      ['方舟速递', 'ark-express'], ['速派快递', 'fastgo'], ['Parcelmate', 'chinz-logistics'], ['Airwings India', 'airwings-india'],
      ['Mark Express', 'mark-express'], ['CityMail Pakistan', 'citymail-pk'], ['SG LINK', 'shipx-asia'],
    ] as const) expect(carrierIdFromName(name), name).toBe(id);
    // A bare 派通 names neither SPT Express nor Patuen, and Sweden's CityMail keeps its own name.
    expect(carrierIdFromName('派通')).toBeUndefined();
    expect(carrierIdFromName('CityMail')).toBe('citymail');
  });
});

describe('Etomars, HY Express, ten national posts and the other Ship24-listed carriers', () => {
  it('names the carriers from providers', () => {
    for (const [name, id] of [['2ebox', '2ebox'], ['BEE FAST', 'bee-fast'], ['Choir Express Indonesia', 'choir-express'],
      ['DTD Worldwide Express', 'dtd-pk'], ['Endeavour Delivery', 'endeavour-delivery'], ['ezShip', 'ezship'], ['Fast Track', 'fasttrack-ar'],
      ['HY Express', 'hy-express'], ['浩远快递', 'hy-express'], ['HYE', 'hye'], ['HYEXP', 'hye'], ['MOBI Logistica', 'mobi-logistica'],
      ['Tai Wan Global Business', 'global-business-tw'], ['Tolos', 'tolos'], ['ViaXpress', 'viaxpress'], ['Antaria Services', 'antaria'],
      ['Beexprss', 'beexprss'], ['Corporate Couriers', 'corporate-couriers'], ['Dan Niao', 'danniao'], ['丹鸟', 'danniao'],
      ['ETOMARS', 'etomars'], ['SHIPNERGY', 'etomars'], ['Mikropakket', 'mikropakket'], ['Royale International', 'royale-international'],
      ['Suto Logistics', 'suto-logistics'], ['Wepost', 'wepost'], ['FXDC Post', 'fxdc-post'], ['Carry Flap', 'carry-flap'],
      ['CKEEX', 'ckeex'], ['DDU Express', 'ddu-express'], ['INDOPAKET', 'indopaket'], ['Redbox MV', 'redbox-mv'], ['Shippify', 'shippify'],
      ['Swftbox', 'swftbox'], ['Xpressen', 'xpressen'], ['STO Global', 'sto'], ['申通国际', 'sto'],
      ['Correios de Angola', 'correios-angola'], ['Correios de Macau', 'macau-post'], ['Correos del Ecuador', 'correos-ecuador'],
      ['Honducor', 'honducor'], ['Ipostel', 'ipostel'], ['Libya Post', 'libya-post'], ['MPT', 'myanmar-post'],
      ['Paositra Malagasy', 'paositra-malagasy'], ['OPT (French Polynesia Post)', 'fare-rata'], ['Vatican Post', 'vatican-post']] as const) {
      expect(carrierIdFromName(name), name).toBe(id);
    }
  });

  it('offers Etomars its SN…JP registration numbers and leaves valid Japan Post items to Japan Post', () => {
    expect(detectCarrierMatch('SN000000000JP')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['etomars'] });
    expect(detectCarrierMatch('SN000000005JP')).toMatchObject({ carrier: 'japan-post', confidence: 'high' });
    for (const value of ['SA000000000JP', 'SN00000000JP', 'SN0000000000JP', 'SN000000000KR']) {
      expect(detectCarrierMatch(value).candidates ?? [], value).not.toContain('etomars');
    }
  });

  it('reads their tracker links', () => {
    for (const [url, carrier] of [
      ['https://portal.dtd.com.pk/index.php/public/tracking?tracking=AB1000000017', 'dtd-pk'],
      ['https://order.hy-express.com/track_query.aspx?track_number=AB1000000017', 'hy-express'],
      ['https://beexprss.com/tracking?tracking_name=AB1000000017', 'beexprss'],
      ['https://www.danniao.com/?mailNoList=AB1000000017', 'danniao'],
      ['https://cbt.shipnergy.com/Track/Result?mode=0&ids=AB1000000017&lang=en-US', 'etomars'],
      ['https://tracking.carry-flap.com/#/home?invoiceNo=AB1000000017', 'carry-flap'],
      ['https://rastreo.honducor.gob.hn/rastreo?tracking_number=AB1000000017', 'honducor'],
      ['https://tracking.libyapost.ly:7040/ipswt/IPSWeb_item_events.aspx?itemid=AB1000000017', 'libya-post'],
      ['https://myanmarpost.com.mm/track/AB1000000017', 'myanmar-post'],
      ['https://postevaticane.va/it/tracking?trackingNumber=AB1000000017', 'vatican-post'],
      ['https://track.xpressen.dk/Tracking?t=AB1000000017', 'xpressen'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: 'AB1000000017', carrier, source: 'link' });
    }
    // Order and delivery-number lookups on the same page are not Etomars registration numbers.
    expect(parseTrackingInput('https://cbt.shipnergy.com/Track/Result?mode=1&ids=AB1000000017').carrier ?? 'none').not.toBe('etomars');
  });
});

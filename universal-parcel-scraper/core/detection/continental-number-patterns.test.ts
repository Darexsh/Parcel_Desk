import { describe, expect, it } from 'vitest';
import { carrierIdFromName } from '../catalog/hints.js';
import { recognitionCandidates, recognitionAskedCarriers } from '../catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from './index.js';
import { isBrtTrackingNumber } from './brt.js';
import { isPosteItalianeTrackingNumber } from './posteItaliane.js';
import { SHEIN_PACKAGE_NUMBER, isSheinPackageNumber } from './shein.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';

describe('continental shipment candidates', () => {
  it('offers BRT shipment numbers without assigning ownership from twelve digits', () => {
    const number = '990000000001';
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['brt']) });
    expect(recognitionCandidates(number)).toEqual(expect.arrayContaining([expect.objectContaining({ carrier: 'brt' })]));
    expect(parseTrackingInput(`Tracking number: ${number}`)).toMatchObject({ trackingNumber: number, carrier: 'unknown', confidence: 'low' });
  });

  it("offers SEUR a sender's reference dated day before month, beside APC Overnight's barcode dated month first", () => {
    // Synthetic: 15 October 2026 reads only day first; 10 December or 12 October reads both ways.
    expect(detectCarrierMatch('2026151000000000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: [] });
    expect(detectCarrierMatch('2026151000000000000001').candidates).toContain('seur');
    expect(detectCarrierMatch('2026151000000000000001').candidates).not.toContain('apc-overnight');
    expect(recognitionAskedCarriers('2026151000000000000001')).toContain('seur');
    expect(detectCarrierMatch('2026101200000000000001')).toMatchObject({ confidence: 'low', preferred: ['apc-overnight'] });
    expect(detectCarrierMatch('2026101200000000000001').candidates).toEqual(expect.arrayContaining(['apc-overnight', 'seur']));
    for (const number of ['2026131300000000000001', '1926151000000000000001', '202615100000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('seur');
    }
  });

  it("offers SEUR a pickup's REC reference and asks it, and only that layout", () => {
    for (const number of ['REC000000000017', 'rec 0000 0000 0017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['seur'] });
      for (const countryHint of [undefined, 'ES', 'PT']) expect(recognitionAskedCarriers(number, { countryHint }), number).toEqual(['seur']);
    }
    for (const number of ['REC00000000017', 'REC0000000000017', 'RE0000000000017', 'RECX00000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('seur');
    }
  });

  it('asks BRT about EOB customer parcel IDs without naming BRT from the shape', () => {
    expect(isBrtTrackingNumber('EOB99099100000000015')).toBe(true);
    expect(detectCarrierMatch('EOB99099100000000015')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['brt'], preferred: [] });
    expect(recognitionAskedCarriers('EOB99099100000000015')).toEqual(['brt']);
    for (const number of ['EOB9909910000000001', 'EOB990991000000000150', 'EOC99099100000000015', 'XEOB99099100000000015', 'EOB9909910000000001A']) {
      expect(isBrtTrackingNumber(number)).toBe(false);
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('brt');
    }
    expect(isBrtTrackingNumber('eob99099100000000015')).toBe(false);
  });

  it('prioritizes documented bpost prefixes while preserving overlapping numeric candidates', () => {
    for (const number of ['323201000000000001', '323200000000000000000001', '329900000000000000000001']) {
      const detected = detectCarrierMatch(number);
      expect(detected).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['bpost'] });
      expect(detected.candidates[0]).toBe('bpost');
      expect(recognitionAskedCarriers(number)[0]).toBe('bpost');
      expect(detected.candidates.length).toBeGreaterThan(1);
    }
    for (const number of ['600000000000000000000001', '32320000000000001', '3232000000000000000000001']) {
      expect(detectCarrierMatch(number).preferred).not.toContain('bpost');
    }
    // Four zeros after five digits is also Ecoscooting's postcode layout.
    expect(detectCarrierMatch('323200000000000001').preferred).toEqual(['bpost', 'ecoscooting']);
  });

  it('lists InPost first for the 24-digit prefixes its tracker answers, beside the other 24-digit carriers', () => {
    for (const number of ['200000000000000000000001', '520000000000000000000001', '620000000000000000000001', '630000000000000000000001', '800000000000000000000001']) {
      const detected = detectCarrierMatch(number);
      expect(detected).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['inpost'] });
      expect(detected.candidates).toEqual(expect.arrayContaining(['austrian-post', 'bpost', 'ciblex']));
      expect(recognitionCandidates(number, { countryHint: 'AT' })[0]!.carrier).toBe('inpost');
      expect(recognitionCandidates(number)[0]!.carrier).toBe('inpost');
    }
    // Express One prints 60 too.
    for (const number of ['600000000000000000000001', '010000000000000000000001', '000000000000000000000001', '560000000000000000000001', '610000000000000000000001', '680000000000000000000001', '81000000000000000000001', '8000000000000000000000001']) {
      expect(detectCarrierMatch(number).preferred).not.toContain('inpost');
    }
    expect(recognitionCandidates('010000000000000000000001', { countryHint: 'AT' })[0]!.carrier).toBe('austrian-post');
  });

  it('names bpost for its S10 numbers, but not for a U barcode, which bpost does not track', () => {
    expect(detectCarrierMatch('CE123456785BE')).toMatchObject({ carrier: 'bpost', confidence: 'high' });
    for (const number of ['UA123456785BE', 'UZ123456785BE']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('bpost');
    }
  });

  it('names bpost for its JJBE licence plate in its letter and parcel lengths only', () => {
    for (const number of ['JJBEA000000000000000001', 'JJBEA0000000000000000000001']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'bpost', confidence: 'high' });
    }
    for (const number of ['JJBEA000000000000000000001', 'JJBEA00000000000000000000001']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('bpost');
    }
  });

  it('reads DHL eCommerce Iberia shipment links in each of the tracking page\'s languages', () => {
    for (const page of ['ModificarEnvio', 'ModificarMeuEnvio', 'ModifyMyShipment']) {
      for (const suffix of ['', '/', '/00000']) {
        expect(parseTrackingInput(`https://clientesparcel.dhl.es/LiveTracking/${page}/0000000001${suffix}`))
          .toMatchObject({ trackingNumber: '0000000001', carrier: 'dhl-ecommerce-es', confidence: 'high', source: 'link' });
      }
    }
    expect(parseTrackingInput('https://clientesparcel.dhl.es/LiveTracking/SinDatos').source).toBe('none');
  });

  it('reads DPD Ireland links from its tracker host and any dpd.ie page', () => {
    for (const link of [
      'https://tracking.dpd.ie/?deviceType=5&consignmentNumber=',
      'https://tracking.dpd.ie/?consignmentNumber=',
      'https://www.dpd.ie/tracking/?consignmentNumber=',
      'https://dpd.ie/tracking?deviceType=5&consignmentNumber=',
      'https://www.dpd.ie/track-my-parcel/?consignmentNumber=',
    ]) {
      expect(parseTrackingInput(`${link}000000001`))
        .toMatchObject({ trackingNumber: '000000001', carrier: 'dpd-ie', confidence: 'high', source: 'link' });
    }
  });

  it('lists Bring first for its GS1-checked parcel and consignment numbers and reads its tracking links', () => {
    for (const number of ['370001000000000003', '373001000000000004', '00370000000000000004', '70000000000000003']) {
      const detected = detectCarrierMatch(number);
      expect(detected).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['bring-posten'] });
      expect(detected.candidates.length).toBeGreaterThan(1);
      expect(recognitionAskedCarriers(number)[0]).toBe('bring-posten');
    }
    for (const number of ['370000000000000005', '371000000000000001', '70000000000000004', '71000000000000000']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('bring-posten');
    }
    expect(parseTrackingInput('https://tracking.bring.se/tracking/70000000000000003?packageNumber=370000000000000004&lang=en'))
      .toMatchObject({ trackingNumber: '370000000000000004', carrier: 'bring-posten', source: 'link' });
    expect(parseTrackingInput('https://tracking.bring.dk/tracking/00370000000000000004'))
      .toMatchObject({ trackingNumber: '00370000000000000004', carrier: 'bring-posten', source: 'link' });
    expect(parseTrackingInput('https://sporing.posten.no/sporing/70000000000000003'))
      .toMatchObject({ trackingNumber: '70000000000000003', carrier: 'bring-posten', source: 'link' });
    expect(parseTrackingInput('https://sporing.bring.no/sporing/RR000000005DE'))
      .toMatchObject({ trackingNumber: 'RR000000005DE', carrier: 'bring-posten', source: 'link' });
  });

  it('suggests ACS and Geniki Taxydromiki for ten digits whose modulo-7 check holds, first from Greece', () => {
    const detected = detectCarrierMatch('1000000002');
    expect(detected).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detected.candidates).toEqual(expect.arrayContaining(['acs-courier', 'geniki-taxydromiki', 'dhl-express']));
    expect(recognitionAskedCarriers('1000000002', { countryHint: 'GR' })).toEqual(expect.arrayContaining(['acs-courier', 'geniki-taxydromiki']));
    expect(recognitionAskedCarriers('1000000002', { countryHint: 'CY' })).toContain('acs-courier');
    for (const number of ['1000000001', '100000002', '10000000002', 'A100000002']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('acs-courier');
      expect(detectCarrierMatch(number).candidates).not.toContain('geniki-taxydromiki');
    }
  });

  it('reads the national posts\' links in each language and in their older layouts', () => {
    for (const [link, trackingNumber, carrier] of [
      ['https://sporing.bring.no/sporing/KMSporingslink.aspx?PackageNumber=370000000000000004', '370000000000000004', 'bring-posten'],
      ['https://www.posti.fi/seuranta/JJFI00000000000000001/12345', 'JJFI00000000000000001', 'posti'],
      ['https://www.posti.fi/sv/uppfoljning/RR900000019FI', 'RR900000019FI', 'posti'],
      ['https://www.posti.fi/itemtracking/posti/search_by_shipment_id?lang=en&ShipmentId=RR900000019FI', 'RR900000019FI', 'posti'],
      ['https://www.postnord.se/vara-verktyg/spara-brev-paket-och-pall?shipmentId=00573000000000000001', '00573000000000000001', 'postnord'],
      ['https://www.postnord.dk/en/tools/track-and-trace?shipmentId=RR900000019DK', 'RR900000019DK', 'postnord'],
      ['https://www.postaonline.cz/en/trackandtrace/-/zasilka/cislo?parcelNumbers=DR9000000002U', 'DR9000000002U', 'ceska-posta'],
      ['https://www.postaonline.cz/en/trackandtrace/-/zasilka/RR900000019CZ', 'RR900000019CZ', 'ceska-posta'],
      ['https://tandt.posta.sk/zasielky/RR900000019SK', 'RR900000019SK', 'slovenska-posta'],
      ['https://www.post.lt/siuntu-sekimas?parcels=RR900000019LT', 'RR900000019LT', 'lietuvos-pastas'],
      ['https://www.post.lt/lt/pagalba/siuntu-paieska?parcel_number=RR900000019LT', 'RR900000019LT', 'lietuvos-pastas'],
      ['https://www.posta.hr/pracenje-postanskih-posiljaka-track-trace/264?broj=RR900000019HR', 'RR900000019HR', 'hrvatska-posta'],
      ['https://posiljka.posta.hr/Tracking/Details?tracklng=en&Barcode=RR900000019HR', 'RR900000019HR', 'hrvatska-posta'],
      ['https://www.elta.gr/el-gr/εντοπισμόςαντικειμένου.aspx?qc=RR900000019GR', 'RR900000019GR', 'elta'],
      ['https://www.elta.gr/Personal/TrackTrace/tabid/93/qc/RR900000019GR/language/en-US/Default.aspx', 'RR900000019GR', 'elta'],
    ]) {
      expect(parseTrackingInput(link!), link).toMatchObject({ trackingNumber, carrier, source: 'link' });
    }
  });

  it('sends whole SDA candidates through Poste recognition and rejects truncated families', () => {
    // AliExpress shows buyers the last shape while the parcel is on Cainiao's leg, so Cainiao is asked beside Poste.
    for (const { number, candidates, asked } of [
      { number: '990001A000001', candidates: ['poste-italiane'], asked: ['poste-italiane'] },
      { number: '3C9900A000001', candidates: ['poste-italiane'], asked: ['poste-italiane'] },
      { number: '1C9900A000001', candidates: ['poste-italiane'], asked: ['poste-italiane'] },
      { number: '9C9900A000001', candidates: ['poste-italiane'], asked: ['poste-italiane'] },
      { number: 'D99000A000001', candidates: ['poste-italiane'], asked: ['poste-italiane'] },
      { number: '990A00000001A', candidates: ['aliexpress', 'poste-italiane'], asked: ['poste-italiane', 'aliexpress'] },
    ]) {
      expect(isPosteItalianeTrackingNumber(number)).toBe(true);
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates });
      expect(recognitionAskedCarriers(number)).toEqual(asked);
      expect(parseTrackingInput(`Tracking number: ${number}`)).toMatchObject({ trackingNumber: number, carrier: 'unknown', candidates });
      expect(isPosteItalianeTrackingNumber(number.slice(1))).toBe(false);
    }
    expect(isPosteItalianeTrackingNumber('ABCDEF0000001')).toBe(false);
  });

  it('lets Poste Italiane take the S10 numbers it issues and leaves foreign ones alone', () => {
    for (const number of ['CW123456785IT', 'CP123456785IT', 'KK123456785IT']) {
      expect(isPosteItalianeTrackingNumber(number)).toBe(true);
    }
    expect(detectCarrierMatch('CW123456785IT')).toMatchObject({ carrier: 'poste-italiane', confidence: 'high' });
    // A failed check digit is no Poste number, and foreign S10 numbers stay postal.
    expect(isPosteItalianeTrackingNumber('CW123456780IT')).toBe(false);
    expect(detectCarrierMatch('CW123456780IT').candidates).not.toContain('poste-italiane');
    for (const number of ['CW123456785FR', 'CP123456785PL']) {
      expect(isPosteItalianeTrackingNumber(number)).toBe(false);
      expect(detectCarrierMatch(number).carrier).not.toBe('poste-italiane');
    }
  });

  it('gives Poste Italiane its International Express codes whatever their last digit', () => {
    // Poste's tracker follows ZC codes whose last digit fails the S10 check.
    for (const number of ['ZC900000001IT', 'ZC900000005IT']) {
      expect(isPosteItalianeTrackingNumber(number)).toBe(true);
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'poste-italiane', confidence: 'high' });
    }
    for (const number of ['ZC90000001IT', 'ZC9000000001IT', 'ZD900000001IT', 'ZC900000001FR']) {
      expect(isPosteItalianeTrackingNumber(number)).toBe(false);
      expect(detectCarrierMatch(number).carrier).not.toBe('poste-italiane');
    }
  });

  it('retains the historical PostNL id for its complete 3S barcode', () => {
    expect(detectCarrierMatch('3SZZZZ1000001')).toMatchObject({ carrier: 'spring-gds', confidence: 'high' });
    expect(recognitionAskedCarriers('3SZZZZ1000001')).toEqual([]);
  });

  it('splits 3S barcodes between PostNL and DHL Parcel by the customer code', () => {
    for (const postnl of ['3SZZZZ1000001', '3SZZZZ100000001']) {
      expect(detectCarrierMatch(postnl)).toMatchObject({ carrier: 'spring-gds', confidence: 'high' });
    }
    for (const dhl of ['3SZZZ10000001', '3SZZZ100000001', '3SZZZ1000000001']) {
      expect(detectCarrierMatch(dhl)).toMatchObject({ carrier: 'dhl-ecommerce-nl', confidence: 'high' });
    }
    // PostNL's documentation also shows shorter customer codes; DHL prints two-letter ones.
    const shared = detectCarrierMatch('3SZZ10000000001');
    expect(shared).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect([...shared.candidates].sort()).toEqual(['dhl-ecommerce-nl', 'spring-gds']);
    expect(recognitionAskedCarriers('3SZZ10000000001')).toEqual(['dhl-ecommerce-nl']);
    expect(detectCarrierMatch('3SZ1000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['spring-gds'] });
    expect(detectCarrierMatch('3SZZZ100000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhl-ecommerce-nl'] });
    for (const neither of ['3SZZZZ10000001', '3SZZZZZ10000001', '3S1000000000001']) {
      expect(detectCarrierMatch(neither).candidates).toEqual([]);
    }
  });
});

describe('DHL piece identifiers', () => {
  // Synthetic identifiers in the JD01 range Express labels print as "(J)JD".
  it('gives an Express piece identifier to DHL Express, however the label is typed', () => {
    for (const input of ['JD014600012345678901', 'jd0146 0001 2345 6789 01', '(J)JD014600012345678901', 'JJD014600012345678901',
      'JD014600012345678901J', 'jd0146 0001 2345 6789 01 j', 'https://www.dhl.com/de-de/home/tracking.html?submit=1&tracking-id=JD014600012345678901']) {
      expect(parseTrackingInput(input)).toMatchObject({ carrier: 'dhl-express', confidence: 'high', candidates: ['dhl-express'] });
    }
  });

  it('offers DHL for a DHL Paket plate typed without its J, and keeps other JJD numbers with DHL', () => {
    for (const plate of ['JD149000012345678901', 'JD000390012345678901']) {
      expect(detectCarrierMatch(plate)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhl'] });
    }
    expect(detectCarrierMatch('JD0146000123456789012')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    // Only the 0146 range is seen with its J. DHL Paket's plates, and JD01 ranges not seen with their J, stay with DHL.
    for (const number of ['JJD000390012345678901', 'JJD149150012345678901', 'JJD012959123456789012', 'JJD01460001234567890123']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'dhl', confidence: 'high' });
    }
    // A zero-padded serial also fits Australia Post's article ID, which leaves a bare JJD plate to DHL.
    expect(detectCarrierMatch('JJD000390012000123456')).toMatchObject({ carrier: 'dhl', confidence: 'high' });
    expect(detectCarrierMatch('12JJD123456789000123456')).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
    for (const number of ['JD012959123456789012J', 'JD149000012345678901J', 'JD0146000123456789012J']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('dhl-express');
    }
  });
});

describe('wave six European prefixes', () => {
  // Synthetic numbers in each carrier's layout; none is a real parcel.
  it('names CityMail for its BCM references, including the twelve-character ones Colis Privé also fits', () => {
    for (const number of ['BCMAB0000001', 'BCMA00000001', 'BCMABC000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'citymail', confidence: 'high', candidates: ['citymail'] });
    }
    for (const number of ['BCM0000001', 'BCMAB00000', 'BCMABCD0000000']) expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('citymail');
  });

  it('names Intereuropa only for NRSI and nine digits', () => {
    expect(detectCarrierMatch('NRSI000000001')).toMatchObject({ carrier: 'intereuropa', confidence: 'high' });
    for (const number of ['NRSI00000001', 'NRSI0000000001', 'NRSIA00000001', 'NRSE000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('intereuropa');
    }
  });

  it('names Pannon XP for its 35814 parcels and leaves other 24-digit numbers to the carriers sharing that length', () => {
    expect(detectCarrierMatch('358140000000000000000001')).toMatchObject({ carrier: 'pannon-xp', confidence: 'high' });
    expect(detectCarrierMatch('358150000000000000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    for (const number of ['358150000000000000000001', '35814000000000000000001', '3581400000000000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('pannon-xp');
    }
  });

  it('names Torrestir for M001 numbers with their service character, and nothing else', () => {
    for (const number of ['M0010000A00000000001', 'M0010000000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'torrestir', confidence: 'high' });
    }
    for (const number of ['M001000000000000000001', 'M0020000A00000000001', 'M0010000AB0000000001', 'M001000A00000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('torrestir');
    }
  });
});

describe('wave six courier rules', () => {
  // Synthetic numbers in each carrier's layout; none is a real parcel.
  it('names FG Delivery for the Cainiao codes its FLM suffix hands to Fulmine', () => {
    expect(detectCarrierMatch('CNITAB00000001FLM')).toMatchObject({ carrier: 'fg-delivery', confidence: 'high', candidates: ['fg-delivery'] });
    for (const number of ['CNITAB0000001FLM', 'CNITA000000001FLM', 'CNITAB00000001FLX']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fg-delivery');
    }
  });

  it('names LogoiX only for LIX and ten digits', () => {
    expect(detectCarrierMatch('LIX0000000001')).toMatchObject({ carrier: 'logoix', confidence: 'high' });
    for (const number of ['LIX000000001', 'LIX00000000001', 'LIXA000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('logoix');
    }
  });

  it('suggests Fermopoint for Fermoticket codes without naming it', () => {
    expect(detectCarrierMatch('A0B0CDE000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['fermopoint'] });
    for (const number of ['00B0CDE000001', 'A0B0CD0000001']) expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fermopoint');
  });

  it('names Peddler for its P and NLEXP labels', () => {
    for (const number of ['P000000000000000001', 'NLEXP0000000001INTPED']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'peddler', confidence: 'high', candidates: ['peddler'] });
    }
    for (const number of ['P00000000000000001', 'P0000000000000000001', 'NLEXP000000001INTPED', 'NLEXP0000000001INTPOD']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('peddler');
    }
  });

  it('suggests TWS Express after Poste Italiane for the SDA-shaped waybills it delivers, and asks both', () => {
    expect(detectCarrierMatch('280000A000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['poste-italiane', 'tws-express'] });
    expect(recognitionAskedCarriers('280000A000001')).toEqual(['poste-italiane', 'tws-express']);
    for (const number of ['270000A000001', '280000A00001', '2800000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('tws-express');
    }
  });

  it('suggests nox for its dated 22000 barcodes beside the other 24-digit carriers', () => {
    const barcode = `22000${'0000001'}261017${'000001'}`;
    expect(detectCarrierMatch(barcode)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(barcode).candidates).toEqual(expect.arrayContaining(['nox', 'inpost']));
    for (const number of [`22000${'0000001'}261317${'000001'}`, `22000${'0000001'}261032${'000001'}`, `23000${'0000001'}261017${'000001'}`]) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('nox');
    }
  });
});

describe('SHEIN package numbers Paack and Ecoscooting deliver in Spain', () => {
  it.each(['C26010100000001', 'E25123100000001', 'C24022900000001'])('suggests Paack and Ecoscooting for %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['paack', 'ecoscooting'] });
    // Paack needs the postcode, so recognition asks only Ecoscooting.
    expect(recognitionAskedCarriers(number)).toEqual(['ecoscooting']);
  });

  it.each(['C26130100000001', 'C26003100000001', 'C26013200000001', 'D26010100000001', 'C16010100000001', 'C2601010000001', 'C260101000000001'])(
    'leaves %s, not a dated SHEIN number, without Paack or Ecoscooting', (number) => {
      expect(isSheinPackageNumber(number)).toBe(false);
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('paack');
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('ecoscooting');
    },
  );

  it('keeps both rules on the shared SHEIN check', () => {
    for (const carrier of ['paack', 'ecoscooting'] as const) {
      expect(CARRIER_DEFINITIONS[carrier].detectionRules.map((rule) => rule.pattern), carrier).toContain(SHEIN_PACKAGE_NUMBER.source);
    }
  });
});

describe('Paack label numbers of eighteen digits', () => {
  it('suggests Paack first for 5340 and fourteen digits, beside the bare eighteen-digit rules', () => {
    const detected = detectCarrierMatch('534000000000000001');
    expect(detected).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['paack'] });
    expect(detected.candidates[0]).toBe('paack');
    expect(detected.candidates).toEqual(expect.arrayContaining(['bpost', 'ecoscooting']));
    // Paack needs the postcode, so recognition does not ask it.
    expect(recognitionAskedCarriers('534000000000000001')).not.toContain('paack');
    for (const number of ['534100000000000001', '53400000000000001', '5340000000000000001', '354000000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('paack');
    }
  });
});

describe('FedEx Poland domestic numbers', () => {
  // Synthetic numbers in FedEx Poland's layout; none is a real parcel.
  it('suggests FedEx Poland for thirteen digits starting with 6 and a GS1 check digit, and asks it first in Poland', () => {
    for (const number of ['6230000000005', '6010000000003']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('fedex-pl');
      expect(recognitionAskedCarriers(number, { countryHint: 'PL' })[0], number).toBe('fedex-pl');
    }
    for (const number of ['6230000000006', '7230000000004', '623000000005', '62300000000005']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fedex-pl');
    }
  });

  it('names FedEx Poland for thirteen digits in a fedex.com tracking link, which FedEx\'s worldwide tracker refuses', () => {
    for (const url of [
      'https://www.fedex.com/fedextrack/?trknbr=6230000000005',
      'https://www.fedex.com/apps/fedextrack/index.html?action=track&tracknumbers=6230000000005&cntry_code=pl',
      'https://www.fedex.com/wtrk/track/?trknbr=7230000000004',
      'https://www.fedex.com/fedextrack/?tracknumbers=6230000000005,6010000000003',
    ]) {
      expect(parseTrackingInput(url), url).toMatchObject({ carrier: 'fedex-pl', confidence: 'high', source: 'link' });
    }
    for (const url of ['https://www.fedex.com/fedextrack/?trknbr=999999999999', 'https://www.fedex.com/fedextrack/?trknbr=62300000000005']) {
      expect(parseTrackingInput(url).carrier, url).not.toBe('fedex-pl');
    }
  });

  it('suggests FedEx Poland first for its 623 series with a passing check digit', () => {
    for (const number of ['6230000000005', '6231000000019']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['fedex-pl'] });
      expect(detectCarrierMatch(number).candidates[0], number).toBe('fedex-pl');
    }
    expect(detectCarrierMatch('6010000000003').preferred).not.toContain('fedex-pl');
    expect(detectCarrierMatch('6230000000006').candidates ?? []).not.toContain('fedex-pl');
  });
});

describe('City Express shipment and parcel numbers', () => {
  // Synthetic numbers in City Express's layout; none is a real parcel.
  it('suggests City Express first for its centre codes, and asks it first', () => {
    for (const number of ['68800500000001', '6880010000000216', '68800200000003']) {
      const detected = detectCarrierMatch(number);
      expect(detected, number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['city-express-rs'] });
      expect(detected.candidates[0], number).toBe('city-express-rs');
      expect(recognitionAskedCarriers(number)[0], number).toBe('city-express-rs');
    }
    for (const number of ['68800300000001', '6880040000000216', '688005000000011', '6880050000000']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('city-express-rs');
    }
  });
});

describe('Purolator PINs and TNT Australia consignments', () => {
  // Synthetic numbers in the three letters and nine digits both networks print; none is a real parcel.
  it('offers Purolator at low confidence and leaves TNT out, since tnt.com refuses TNT Australia domestic', () => {
    for (const number of ['APK000000001', 'KYV000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({
        carrier: 'unknown',
        confidence: 'low',
        candidates: expect.arrayContaining(['purolator']),
      });
      expect(detectCarrierMatch(number).candidates, number).not.toContain('tnt');
    }
    for (const number of ['APK00000001', 'APK0000000001', 'AP0000000001', 'CUB000000001', 'XLT000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('tnt');
    }
  });
});

describe('Nova Post international numbers', () => {
  // Synthetic numbers in the SH or TN, country and ten-digit layout novapost.com's tracker accepts,
  // at times after RS; none is a real parcel.
  // SHO with C, P or R and ten digits is Ekart's; none of those pairs is a country code.
  it('offers Nova Poshta at low confidence for SH or TN, two letters and ten digits, at times after RS', () => {
    for (const number of ['SHUA0000000001', 'SHPL0000000001', 'TNUA0000000001', 'RSSHUA0000000001', 'RSTNPL0000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({
        confidence: 'low',
        candidates: expect.arrayContaining(['nova-poshta']),
      });
    }
    for (const number of ['SHUA000000001', 'SHUA00000000001', 'TNUA00000000001', 'RSUA0000000001', 'RSRSSHUA0000000001', 'XTNUA0000000001',
      'SH1A0000000001', 'SHOC0000000001', 'RSSHOC0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('nova-poshta');
    }
  });
});

describe('Nova Global and ShipEntegra numbers', () => {
  // Synthetic numbers in the layouts Nova Global and ShipEntegra print; none is a real parcel.
  it('names Nova Global for two letters, nine to sixteen digits and NPG', () => {
    for (const number of ['NP00000000000001NPG', 'WB0000000000000001NPG', 'YW000000001NPG']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'nova-global', confidence: 'high' });
    }
    for (const number of ['NP00000001NPG', 'NP00000000000000001NPG', 'NP00000000000001NPX']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('nova-global');
    }
  });

  it('names ShipEntegra for 1SE and nine digits only', () => {
    expect(detectCarrierMatch('1SE000000001')).toMatchObject({ carrier: 'shipentegra', confidence: 'high' });
    for (const number of ['1SE00000001', '1SE0000000001', '2SE000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('shipentegra');
    }
  });
});

describe('J&T Express Middle East waybills', () => {
  // Synthetic numbers in the layout J&T Express Middle East's tracking form checks; none is a real parcel.
  it('names J&T Express Middle East for JTE and twelve digits only', () => {
    for (const number of ['JTE300000000001', 'JTE000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'j-and-t-middle-east', confidence: 'high' });
    }
    for (const number of ['JTE30000000001', 'JTE3000000000001', 'JTF300000000001', 'JT300000000001']) {
      const match = detectCarrierMatch(number);
      expect(match.carrier, number).not.toBe('j-and-t-middle-east');
      expect(match.candidates ?? [], number).not.toContain('j-and-t-middle-east');
    }
    expect(detectCarrierMatch('JMX300000000001')).toMatchObject({ carrier: 'j-and-t-mx', confidence: 'high' });
  });

  it('names J&T Express Australia for JTAU and twelve digits only', () => {
    expect(detectCarrierMatch('JTAU300000000001')).toMatchObject({ carrier: 'j-and-t-au', confidence: 'high' });
    for (const number of ['JTAU30000000001', 'JTAU3000000000001', 'JTNZ300000000001', 'JTA300000000001', 'JTAUX00000000001']) {
      const match = detectCarrierMatch(number);
      expect(match.carrier, number).not.toBe('j-and-t-au');
      expect(match.candidates ?? [], number).not.toContain('j-and-t-au');
    }
  });
});

describe('wave seven courier rules', () => {
  // Synthetic numbers in each carrier's layout; none is a real parcel.
  it('suggests DPD Austria first for its depot codes and asks it first in recognition', () => {
    for (const number of ['06200000000001', '06300000000001', '06350000000001', '06430000000001', '06490000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates?.[0], number).toBe('dpd-at');
      // The DPD networks asked after it leave a parcel in Austria alone.
      expect(recognitionAskedCarriers(number)[0], number).toBe('dpd-at');
    }
    for (const number of ['06310000000001', '06460000000001', '06100000000001', '0620000000001', '062000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dpd-at');
    }
  });

  it('suggests DPD Germany first for its depot codes and asks it first wherever the parcel is looked up', () => {
    for (const number of ['01010000000001', '01200000000001', '01990000000001', '012000000000019', '019900000000016']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates?.[0], number).toBe('dpd-de');
      // DPD Germany knows only a parcel that is in Germany, so asking it first files no other network's parcel.
      for (const countryHint of [undefined, 'DE', 'FR', 'GB', 'ES']) {
        expect(recognitionAskedCarriers(number, { countryHint })[0], `${number} ${countryHint}`).toBe('dpd-de');
      }
    }
    for (const number of ['01000000000001', '02000000000001', '09440000000001', '012000000000010', '0120000000001']) {
      expect(detectCarrierMatch(number).preferred ?? [], number).not.toContain('dpd-de');
    }
  });

  it('suggests Drop2Shop for GLB and thirteen digits without naming it', () => {
    expect(detectCarrierMatch('GLB0000000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['drop2shop'] });
    for (const number of ['GLB000000000001', 'GLB00000000000001', 'GLC0000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('drop2shop');
    }
  });

  it('names Precision Deliveries for ASL and ten digits, its former name', () => {
    expect(detectCarrierMatch('ASL0000000001')).toMatchObject({ carrier: 'precision-deliveries', confidence: 'high', candidates: ['precision-deliveries'] });
    for (const number of ['ASL000000001', 'ASL00000000001', 'ASM0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('precision-deliveries');
    }
  });

  it('names Energo only for its dashed EN numbers', () => {
    expect(detectCarrierMatch('EN00-000000-1')).toMatchObject({ carrier: 'energo', confidence: 'high', candidates: ['energo'] });
    for (const number of ['EN000000001', 'EN00-000000-12', 'EN0-0000000-1']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('energo');
    }
  });

  it('names Tgroup for 3010TGR and fourteen digits', () => {
    expect(detectCarrierMatch('3010TGR00000000000001')).toMatchObject({ carrier: 't-group', confidence: 'high', candidates: ['t-group'] });
    for (const number of ['3010TGR0000000000001', '3011TGR00000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('t-group');
    }
  });

  it('names TForce Logistics for TF and twelve, thirteen or eighteen digits', () => {
    for (const number of ['TF000000000001', 'TF0000000000001', 'TF100000000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'tforce-logistics', confidence: 'high', candidates: ['tforce-logistics'] });
    }
    for (const number of ['TF00000000001', 'TF00000000000001', 'TF200000000000000001', 'TG000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('tforce-logistics');
    }
  });

  it('names GlobalPost for GP, a service code, ten digits and its origin', () => {
    for (const number of ['GPABCD0000000001US', 'GPABCD0000000001GB']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'globalpost', confidence: 'high', candidates: ['globalpost'] });
    }
    for (const number of ['GPABCD0000000001DE', 'GPABC0000000001US', 'GPABCD000000001US']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('globalpost');
    }
  });

  it('names United Delivery Service only for its UDS labels', () => {
    for (const number of ['01UDS00000000001', 'APUDS00000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'united-delivery-service', confidence: 'high', candidates: ['united-delivery-service'] });
    }
    for (const number of ['01UDS0000000001', 'APUDS0000001', '01UDT00000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('united-delivery-service');
    }
  });

  it('names FleetOptics only for the shipper codes and lengths its tracker shows', () => {
    for (const number of ['FOAESH0000001', 'FONSP00000000001', 'FDAV0000000000000001', 'FDYNS0000000000A', 'FCLR000000000001', 'FSLS000000000000001', 'FEPO000000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'fleetoptics', confidence: 'high', candidates: ['fleetoptics'] });
    }
    for (const number of ['FOAESH000001', 'FONSP0000000001', 'FDAV000000000000001', 'FCLR00000000001', 'FXYZ000000000001', 'SON10000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fleetoptics');
    }
  });

  it('names Straightship for STRTD and STRCA numbers at their lengths', () => {
    for (const number of ['STRTD000000001', 'STRTD0000000000000001', 'STRTD00000000000000001', 'STRCA0000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'straightship', confidence: 'high', candidates: ['straightship'] });
    }
    for (const number of ['STRTD00000001', 'STRTD000000000001', 'STRCA000000000001', 'STSH0000000000000']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('straightship');
    }
  });

  it('names Apple Express for APPL references and leaves its bare order numbers open', () => {
    expect(detectCarrierMatch('APPL0000000000001')).toMatchObject({ carrier: 'apple-express', confidence: 'high' });
    for (const number of ['APPL000000000001', 'APPL00000000000001', 'APPX0000000000001', '00000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('apple-express');
    }
  });

  it('names AJEX for AJA or AJS and twelve digits', () => {
    for (const number of ['AJA000000000001', 'AJS000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'ajex', confidence: 'high', candidates: ['ajex'] });
    }
    for (const number of ['AJB000000000001', 'AJA00000000001', 'AJA0000000000001', 'A0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ajex');
    }
  });

  it('names Exelot for XLT and nine digits and leaves other prefixes to Purolator', () => {
    expect(detectCarrierMatch('XLT000000001')).toMatchObject({ carrier: 'exelot', confidence: 'high' });
    expect(detectCarrierMatch('XLU000000001')).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['purolator']) });
    for (const number of ['XLT00000001', 'XLT0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('exelot');
    }
  });

  it('suggests Starlinks for SL and ten digits without naming it', () => {
    expect(detectCarrierMatch('SL0000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('SL0000000001').candidates).toContain('starlinks');
    for (const number of ['SL000000001', 'SL00000000001', 'S0000000001', 'SM0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('starlinks');
    }
  });

  it('suggests Copa Courier for H and seven digits without naming it', () => {
    expect(detectCarrierMatch('H0000001')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('H0000001').candidates).toContain('copa-courier');
    for (const number of ['H000001', 'H00000001', 'HA000001', 'G0000001', '00000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('copa-courier');
    }
  });

  it('suggests TransMission for T or P and fourteen digits without naming it', () => {
    for (const number of ['T00000000000001', 'P00 000000 000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('transmission');
    }
    for (const number of ['T0000000000001', 'T000000000000001', 'R00000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('transmission');
    }
  });
});

describe('wave eight courier rules', () => {
  // Synthetic numbers in each carrier's layout; none is a real parcel.
  it('names A Tu Hora Express for its zero-padded sixteen digits and suggests it for the 24-digit label', () => {
    expect(detectCarrierMatch('0000001234567890')).toMatchObject({ carrier: 'a-tu-hora-express', confidence: 'high', candidates: ['a-tu-hora-express'] });
    expect(detectCarrierMatch('000000123456789000112345')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('000000123456789000112345').candidates).toContain('a-tu-hora-express');
    for (const number of ['0000011234567890', '000000123456789000212345', '00000012345678900011234']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('a-tu-hora-express');
    }
  });

  it('names Transaher for 27 digits starting 103', () => {
    expect(detectCarrierMatch('103000000000000000000000001')).toMatchObject({ carrier: 'transaher', confidence: 'high', candidates: ['transaher'] });
    for (const number of ['10300000000000000000000001', '1030000000000000000000000001', '104000000000000000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('transaher');
    }
  });

  it('names Chronodiali for CHPU and nineteen digits', () => {
    expect(detectCarrierMatch('CHPU0000000000000000001')).toMatchObject({ carrier: 'chronodiali', confidence: 'high', candidates: ['chronodiali'] });
    for (const number of ['CHPU000000000000000001', 'CHPU00000000000000000001', 'CHPV0000000000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('chronodiali');
    }
  });

  it('names CST Italia for CST or BDM and 18 or 22 digits', () => {
    for (const number of ['CST123456789012345678', 'CST1234567890123456780101', 'BDM123456789012345678', 'BDM1234567890123456780101']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'cst-italia', confidence: 'high', candidates: ['cst-italia'] });
    }
    for (const number of ['CST12345678901234567', 'CST12345678901234567801', 'CSU123456789012345678', 'BDN123456789012345678']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('cst-italia');
    }
  });

  it('names L-POST for ABC and eight digits', () => {
    expect(detectCarrierMatch('ABC00000001')).toMatchObject({ carrier: 'l-post', confidence: 'high', candidates: ['l-post'] });
    for (const number of ['ABC0000001', 'ABC000000001', 'ABD00000001', 'XABC00000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('l-post');
    }
  });

  it('names DobroPost for DBRPST and ten digits', () => {
    expect(detectCarrierMatch('DBRPST0000000001')).toMatchObject({ carrier: 'dobropost', confidence: 'high', candidates: ['dobropost'] });
    for (const number of ['DBRPST000000001', 'DBRPST00000000001', 'DBRPSX0000000001', 'DBPST0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('dobropost');
    }
  });

  it('suggests Quicksilver for QS and nine digits beside GLS Italy without naming it', () => {
    expect(detectCarrierMatch('QS000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('QS000000001').candidates).toEqual(expect.arrayContaining(['quicksilver-sa', 'gls-it']));
    for (const number of ['QS00000001', 'QS0000000001', 'QT000000001', 'XQS000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('quicksilver-sa');
    }
  });

  it('suggests TP Logistics for a branch code, a valid date and a counter', () => {
    expect(detectCarrierMatch('BKK112412300042')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['tp-logistics-th'] });
    for (const number of ['BKK112413300042', 'BKK112412320042', 'BKK11241230004', 'BK1112412300042', 'TRK112412300042']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('tp-logistics-th');
    }
  });

  it('suggests BEST Express Malaysia for fourteen digits after its calling-code prefix', () => {
    expect(detectCarrierMatch('60850000000017').candidates).toContain('best-express-my');
    for (const number of ['60860000000017', '84850000000017', '6085000000001', '608500000000171']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('best-express-my');
    }
  });

  it('suggests Makati Express for its branch codes, beside Australia Post at seven digits', () => {
    expect(detectCarrierMatch('DXB12345678')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['makati-express'] });
    expect(detectCarrierMatch('DOH1234567').candidates).toEqual(expect.arrayContaining(['makati-express', 'australia-post']));
    for (const number of ['DXB123456', 'DXB123456789', 'MNL12345678']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('makati-express');
    }
  });

  it('names Indah Logistik for a branch code, 1CS and its counters', () => {
    for (const number of ['JKT1CS000000000001', 'JKT1CSPL000000000001', 'SUB1CS00000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'indah-logistik', confidence: 'high' });
    }
    for (const number of ['JKT1CS0000000', 'JKT1CX00000001', 'JKT1CSPL00000001', 'JK1CS00000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('indah-logistik');
    }
  });

  it('names eParcel Korea for E, a destination country, nine digits and KR', () => {
    for (const number of ['EPH000000001KR', 'ETH000000001KR']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'eparcel-kr', confidence: 'high' });
    }
    for (const number of ['EPH00000001KR', 'XPH000000001KR', 'EP000000001KR', 'EPH000000001JP']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('eparcel-kr');
    }
  });

  it('names Exmate for EXK, eight digits and J over Colis Privé', () => {
    expect(detectCarrierMatch('EXK00000001J')).toMatchObject({ carrier: 'exmate', confidence: 'high' });
    for (const number of ['EXK0000001J', 'EXJ00000001J', 'EXK00000001K']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('exmate');
    }
  });

  it('names RPX Online for HKGL and ten digits', () => {
    expect(detectCarrierMatch('HKGL0000000001')).toMatchObject({ carrier: 'rpx-hk', confidence: 'high' });
    for (const number of ['HKGL000000001', 'HKGL00000000001', 'HKGX0000000001', 'HKG0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('rpx-hk');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('rpx-hk');
    }
  });

  it("leaves GAASH WorldWide's GWD and nine digits out of Purolator's rule", () => {
    expect(detectCarrierMatch('GWD000000001').carrier).not.toBe('purolator');
    expect(detectCarrierMatch('GWD000000001').candidates ?? []).not.toContain('purolator');
    expect(detectCarrierMatch('GWE000000001')).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['purolator']) });
  });

  it('names Qwintry for QR and eight digits', () => {
    expect(detectCarrierMatch('QR00000001')).toMatchObject({ carrier: 'qwintry', confidence: 'high' });
    for (const number of ['QR0000001', 'QR000000001', 'QS00000001', 'Q000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('qwintry');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('qwintry');
    }
  });

  it('names SkyPostal for SKAMZUS and ten digits, and suggests it for SP, eleven digits and BR', () => {
    expect(detectCarrierMatch('SKAMZUS0000000001')).toMatchObject({ carrier: 'skypostal', confidence: 'high' });
    expect(detectCarrierMatch('SP00000000001BR')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['skypostal'] });
    for (const number of ['SKAMZUS000000001', 'SKAMZUK0000000001', 'SP0000000001BR', 'SP00000000001US', 'SX00000000001BR']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('skypostal');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('skypostal');
    }
  });

  it('names HuaHan for HHW, two letters, ten digits and YQ', () => {
    expect(detectCarrierMatch('HHWAB0000000001YQ')).toMatchObject({ carrier: 'huahan', confidence: 'high' });
    expect(carrierIdFromName('Huanhan Logistics')).toBe('huahan');
    for (const number of ['HHWAB000000001YQ', 'HHWA0000000001YQ', 'HHXAB0000000001YQ', 'HHWAB0000000001YX']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('huahan');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('huahan');
    }
  });

  it('names Jumppoint for JP and twelve digits', () => {
    expect(detectCarrierMatch('JP000000000001')).toMatchObject({ carrier: 'jumppoint', confidence: 'high' });
    for (const number of ['JP00000000001', 'JP0000000000001', 'JX000000000001', 'JPA00000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('jumppoint');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('jumppoint');
    }
  });

  it('names AnserX for BTY, CN, ten digits and YQ', () => {
    expect(detectCarrierMatch('BTYCN0000000001YQ')).toMatchObject({ carrier: 'anserx', confidence: 'high' });
    for (const number of ['BTYCN000000001YQ', 'BTYUS0000000001YQ', 'BTXCN0000000001YQ', 'BTYCN0000000001YX']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('anserx');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('anserx');
    }
  });

  it('suggests Chukou1 for its dated processing numbers', () => {
    for (const number of ['CZN260101AB1000001', 'CRE170615ZAB0000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('chukou1');
    }
    for (const number of ['CZN261301AB1000001', 'CZN260132AB1000001', 'CZN2601011AB000001', 'CZN260101AB100001', 'CZ260101AB1000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('chukou1');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('chukou1');
    }
  });
});

describe('FAN Courier AWBs', () => {
  // Synthetic AWBs in FAN Courier's layout; none is a real parcel.
  it('suggests FAN Courier for thirteen digits starting with 2, 4 or 7000, and asks it first in Romania', () => {
    for (const number of ['2012345678901', '4098765432104', '7000123456785']) {
      expect(detectCarrierMatch(number).candidates, number).toContain('fan-courier');
      expect(detectCarrierMatch(number).confidence, number).toBe('low');
      expect(recognitionAskedCarriers(number, { countryHint: 'RO' })[0], number).toBe('fan-courier');
    }
    for (const number of ['3012345678901', '7001123456785', '201234567890', '20123456789012']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('fan-courier');
    }
  });

  it('suggests FAN Courier first for its 7000 series wherever the parcel comes from, but not for 2 and 4', () => {
    const detected = detectCarrierMatch('7000123456785');
    expect(detected).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['fan-courier'] });
    expect(detected.candidates[0]).toBe('fan-courier');
    expect(recognitionAskedCarriers('7000123456785')[0]).toBe('fan-courier');
    for (const number of ['2012345678901', '4098765432104']) {
      expect(detectCarrierMatch(number).preferred, number).not.toContain('fan-courier');
    }
  });

  it('reads an AWB from the English and Romanian tracker links', () => {
    for (const url of ['https://www.fancourier.ro/en/awb-track/?tracking=2012345678901',
      'https://www.fancourier.ro/awb-tracking/?tracking=2012345678901', 'https://www.fancourier.ro/awb-tracking/?awb=2012345678901']) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: '2012345678901', carrier: 'fan-courier', source: 'link' });
    }
  });
});

describe('Sameday tracker links', () => {
  it('reads an AWB from the Romanian and Bulgarian trackers\' parameter and fragment', () => {
    for (const url of ['https://sameday.ro/status-colet/?awb=1ZZZ000000001', 'https://sameday.ro/status-colet/?lang=en&awb=1ZZZ000000001',
      'https://sameday.bg/status-na-pratkata/?awb=1ZZZ000000001', 'https://sameday.ro/#awb=1ZZZ000000001']) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: '1ZZZ000000001', carrier: 'sameday', source: 'link' });
    }
    expect(parseTrackingInput('https://sameday.ro/easybox/').source).toBe('none');
  });

  it('suggests Sameday for client XL and eleven digits, not for the prefixes of First Line or OnTrac', () => {
    expect(detectCarrierMatch('1XL00000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['sameday'] });
    for (const number of ['1XL0000000001', '1XL000000000001', '1XM00000000001', '1ST00000000001', '1LS000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('sameday');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('sameday');
    }
  });
});

describe('PIN AG numbers', () => {
  it('lists PIN AG first for sixteen digits opening 0100, without naming it', () => {
    expect(detectCarrierMatch('0100800000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['pin-ag'] });
    expect(detectCarrierMatch('0100800000000001').candidates[0]).toBe('pin-ag');
    for (const number of ['0101800000000001', '010080000000001', '01008000000000001']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('pin-ag');
    }
    expect(parseTrackingInput('https://sendungsverfolgung.pin-ag.de/?sendung=0100800000000001')).toMatchObject({
      trackingNumber: '0100800000000001', carrier: 'pin-ag', source: 'link',
    });
  });
});

describe('networks whose links route to an existing carrier', () => {
  it('reads France Express recipient links as GEODIS', () => {
    for (const link of [
      'https://espace-client.france-express.com/services/destinataires/#/fr/suivi/1G0000000000',
      'https://espace-client.geodis.com/services/destinataires/#/fr/suivi/1G0000000000',
    ]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: '1G0000000000', carrier: 'geodis', source: 'link' });
    }
  });

  it('reads Royal Shipments links as SP Express', () => {
    expect(parseTrackingInput('https://royalshipments.com/tt/483260904000001')).toMatchObject({
      trackingNumber: '483260904000001', carrier: 'sp-express', source: 'link',
    });
  });

  it('reads PARCEL.ONE tracking links', () => {
    for (const link of ['https://parcel.one/tracking?trackno=1000000000017', 'https://parcel.one/de/tracking/?trackno=1000000000017']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: '1000000000017', carrier: 'parcel-one', source: 'link' });
    }
  });
});

describe('One by Allegro CZ, Post One, FámaFutár and TAS Courier', () => {
  it('names One by Allegro CZ for a customer prefix with a letter and eight digits', () => {
    for (const number of ['1A200000017', '1AB00000017', '12A00000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'wedo', confidence: 'high' });
    }
    for (const number of ['12300000017', '7D100000017', '7X100000017', '1A20000001', '1A2000000017', 'A1200000017']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('wedo');
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('wedo');
    }
  });

  it('reads One by Allegro CZ links, old WE|DO and IN TIME ones included', () => {
    for (const link of [
      'https://onedelivery.cz/sledovani-zasilky?numer=1A200000017',
      'https://onedelivery.cz/?numer=1A200000017',
      'https://trace.wedo.cz/index.php?orderNumber=1A200000017',
      'http://trace.intime.cz/index.php?orderNumber=1A200000017',
    ]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: '1A200000017', carrier: 'wedo', source: 'link' });
    }
  });

  it('suggests Post One for R and ten digits beside GLS Italy', () => {
    expect(detectCarrierMatch('R1000000017')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['post-one', 'gls-it']) });
    for (const number of ['R100000017', 'R10000000017', 'RR1000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('post-one');
    }
    for (const link of ['https://postone.eu/en/track?code=R1000000017', 'https://postone.eu/track?code=R1000000017']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'R1000000017', carrier: 'post-one', source: 'link' });
    }
  });

  it('reads FámaFutár and TAS Courier tracking links', () => {
    expect(parseTrackingInput('https://famafutar.hu/tracking/#100000000000000000000017')).toMatchObject({
      trackingNumber: '100000000000000000000017', carrier: 'famafutar', source: 'link',
    });
    expect(parseTrackingInput('https://www.tascourier.gr/track?v=1000017')).toMatchObject({
      trackingNumber: '1000017', carrier: 'tas-courier', source: 'link',
    });
  });
});

describe('In Time Bulgaria, EMEX and Runner Express links', () => {
  it('reads their tracking links without naming them for a bare number', () => {
    expect(parseTrackingInput('https://intime.bg/tracking/?track_number=100000017')).toMatchObject({
      trackingNumber: '100000017', carrier: 'intime-bg', source: 'link',
    });
    expect(parseTrackingInput('https://courier.intime.bg/bg/tracking/code/100000017')).toMatchObject({
      trackingNumber: '100000017', carrier: 'intime-bg', source: 'link',
    });
    expect(parseTrackingInput('https://www.emex.kz/otslezhivanie-po-kazahstanu?id=100000017')).toMatchObject({
      trackingNumber: '100000017', carrier: 'emex', source: 'link',
    });
    expect(parseTrackingInput('https://runnerexpress.co.il/track/?search_query=RE100000017')).toMatchObject({
      trackingNumber: 'RE100000017', carrier: 'runner-express', source: 'link',
    });
    expect(detectCarrierMatch('100000017').candidates ?? []).not.toContain('intime-bg');
  });
});

describe('JP HOME, CargoLine and Ambro Express links', () => {
  it('reads their tracking links without naming them for a bare number', () => {
    expect(parseTrackingInput('https://jphome.eu/suivi-de-livraison/?reference=10000017&zipcode=00000')).toMatchObject({
      trackingNumber: '10000017', carrier: 'jp-home', source: 'link',
    });
    expect(parseTrackingInput('https://www.agediss.com/fr/suivi/100000017/')).toMatchObject({
      trackingNumber: '100000017', carrier: 'jp-home', source: 'link',
    });
    expect(parseTrackingInput('https://trackandtrace.cepra.de/Track/00100000000000000017/00000')).toMatchObject({
      trackingNumber: '00100000000000000017', carrier: 'cargoline', source: 'link',
    });
    expect(parseTrackingInput('https://ambroexpress.pl/sledzenie-przesylek#AB10000000017')).toMatchObject({
      trackingNumber: 'AB10000000017', carrier: 'ambro-express', source: 'link',
    });
    expect(detectCarrierMatch('10000017').candidates ?? []).not.toContain('jp-home');
  });
});

describe('PostNL eighteen-digit numbers for Italy', () => {
  it('offers PostNL for 1810 and fourteen digits and asks it, and only for that series', () => {
    for (const number of ['181011000000000017', '1810 1100 0000 0000 17']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['spring-gds']) });
      expect(recognitionAskedCarriers(number, { countryHint: 'IT' }), number).toEqual(['spring-gds']);
    }
    for (const number of ['182011000000000017', '18101100000000017', '1810110000000000170']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('spring-gds');
      expect(recognitionAskedCarriers(number), number).not.toContain('spring-gds');
    }
  });
});

describe('Avis Logistics, Depo and e-Cargo links', () => {
  it('reads the number from each tracking link', () => {
    expect(parseTrackingInput('https://avislogistics.kz/?trace=0000000000017')).toMatchObject({
      trackingNumber: '0000000000017', carrier: 'avis-logistics', source: 'link',
    });
    expect(parseTrackingInput('https://depo.sk/sledovanie-zasielky/?number=2000000000017')).toMatchObject({
      trackingNumber: '2000000000017', carrier: 'depo', source: 'link',
    });
    expect(parseTrackingInput('https://tracking.e-cargo.co.il/CargoTracking/public-tracking/search?searchKey=EC1000017')).toMatchObject({
      trackingNumber: 'EC1000017', carrier: 'e-cargo', source: 'link',
    });
  });
});

describe('Sengi Express numbers for Malta', () => {
  it('suggests MaltaPost and Sengi Express for five letters, nine digits and MT, and only that layout', () => {
    for (const number of ['SNGXP100000017MT', 'sngxp 100000017 mt']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['maltapost', 'sengi-express'] });
    }
    for (const number of ['SNGX100000017MT', 'SNGXPQ100000017MT', 'SNGXP10000017MT', 'SNGXP1000000017MT', 'SNGXP100000017IT', 'SNGX1100000017MT']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('sengi-express');
    }
  });

  it('asks MaltaPost about the number and names Sengi Express from a provider', () => {
    expect(recognitionAskedCarriers('SNGXP100000017MT')).toEqual(['maltapost']);
    expect(carrierIdFromName('Sengi')).toBe('sengi-express');
    expect(carrierIdFromName('SENGI Express')).toBe('sengi-express');
  });
});

describe('Western Bid numbers and links', () => {
  it('suggests Western Bid for WBX and twelve digits, and only that layout', () => {
    for (const number of ['WBX100000000017', 'wbx 100000000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['western-bid'] });
    }
    for (const number of ['WBX10000000017', 'WBX1000000000017', 'WB100000000017', 'WBY100000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('western-bid');
    }
    expect(carrierIdFromName('WestParcel')).toBe('western-bid');
  });

  it('reads both tracker hosts', () => {
    for (const host of ['track.westparcel.com', 'track.westernbid.com']) {
      expect(parseTrackingInput(`https://${host}/?trackNumber=WBX100000000017`)).toMatchObject({
        trackingNumber: 'WBX100000000017', carrier: 'western-bid', source: 'link',
      });
    }
  });
});

describe('ACE Logistics, FOFR, AKIS Express, ColliCare, Pall-Ex and Parcel Right links', () => {
  it('files an ACE tracker address under its office', () => {
    for (const [office, carrier] of [['LT', 'ace-lt'], ['LV', 'ace-lv'], ['EE', 'ace-ee']] as const) {
      expect(parseTrackingInput(`https://www.acelogistics.eu/tracker/tracker_en.php?office=${office}&cc=${office}&ref=1234567`)).toMatchObject({
        trackingNumber: '1234567', carrier, source: 'link',
      });
    }
    expect(parseTrackingInput('https://www.acelogistics.eu/tracker/tracker_en.php?office=FI&ref=1234567').carrier ?? 'none').not.toMatch(/^ace-/);
  });

  it('reads the other trackers', () => {
    for (const [url, number, carrier] of [
      ['https://objednavky.fofrcz.cz/sledovani-zasilek-fofr?shipment_num=1000000017', '1000000017', 'fofr'],
      ['https://gapakisexpress.com/track-your-packages/?tracking_num=AK1000017', 'AK1000017', 'akis-express'],
      ['https://www.collicare.no/track-and-trace?s=70000000000000017', '70000000000000017', 'collicare'],
      ['https://www.collicare.no/track-and-trace#/s/70000000000000017', '70000000000000017', 'collicare'],
      ['https://mynexus.pallex.com/NexusTracking/1000000000000017/AB12CD', '1000000000000017', 'pallex'],
      ['https://parcelright.com.au/track?tracknbr=NZC100000017', 'NZC100000017', 'dai-post'],
      ['https://parcelrig.ht/NZC100000017', 'NZC100000017', 'dai-post'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
    expect(carrierIdFromName('Parcel Right')).toBe('dai-post');
    expect(carrierIdFromName('Pall-Ex')).toBe('pallex');
  });
});

describe('ROZETKA Delivery, HRX, Cargobus and Jetpak numbers and links', () => {
  it('suggests ROZETKA Delivery for RMP and nine digits, which Purolator leaves to it', () => {
    for (const number of ['RMP-100000017', 'rmp 100000017', 'RMP100000017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('rozetka-delivery');
      expect(detectCarrierMatch(number).candidates, number).not.toContain('purolator');
    }
    for (const number of ['RMP10000017', 'RMP1000000017', 'RMQ100000017', '101000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('rozetka-delivery');
    }
    expect(detectCarrierMatch('RMQ100000017')).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['purolator']) });
  });

  it('reads their trackers and names them', () => {
    for (const [url, number, carrier] of [
      ['https://rozetka.delivery/tracking?parcel_id=RMP-100000017', 'RMP-100000017', 'rozetka-delivery'],
      ['https://rozetka.delivery/tracking?parcel_id=101000000017', '101000000017', 'rozetka-delivery'],
      ['https://wop.hrx.eu/public/tracking/TRK1000000017', 'TRK1000000017', 'hrx'],
      ['https://cargobusee.opter.cloud/TT?keyword=1000017', '1000017', 'cargobus'],
      ['https://my.jetpak.com/app/en/track/awb/JET1000017', 'JET1000017', 'jetpak'],
    ] as const) {
      expect(parseTrackingInput(url), url).toMatchObject({ trackingNumber: number, carrier, source: 'link' });
    }
    expect(parseTrackingInput('https://my.jetpak.com/app/sv/track/c/abcdef_S').carrier ?? 'none').not.toBe('jetpak');
    expect(carrierIdFromName('Rozetka Delivery')).toBe('rozetka-delivery');
    expect(carrierIdFromName('HR-Express')).toBe('hrx');
    expect(carrierIdFromName('T Grupp')).toBe('cargobus');
    expect(carrierIdFromName('Jetpak Group')).toBe('jetpak');
  });
});

describe('TransNatur, Rhenus Italia, Rhenus Germany, Emons and Noerpel', () => {
  it('reads their tracker links and names', () => {
    expect(parseTrackingInput('https://portal.transnatur.com/crm/track/TN10000017/'))
      .toMatchObject({ trackingNumber: 'TN10000017', carrier: 'transnatur', source: 'link' });
    expect(parseTrackingInput('https://tracking.rhenusitalia.it/rhenus/tracking.jsf?s=I100000017'))
      .toMatchObject({ trackingNumber: 'I100000017', carrier: 'rhenus-it', source: 'link' });
    expect(carrierIdFromName('Transnatur S.A.')).toBe('transnatur');
    expect(carrierIdFromName('Rhenus Italia')).toBe('rhenus-it');
    expect(carrierIdFromName('Emons Spedition')).toBe('emons');
    expect(carrierIdFromName('C.E. Noerpel')).toBe('noerpel');
    expect(carrierIdFromName('Rhenus Germany')).toBe('rhenus-de');
    expect(carrierIdFromName('Rhenus Home Delivery GmbH')).toBe('rhenus-de');
    // Rhenus runs separate networks in each country.
    expect(carrierIdFromName('Rhenus')).toBeUndefined();
  });

  it('leaves the numbers they print to the carriers that claim the shapes', () => {
    // Rhenus Italia's placeholder shape is another carrier's rule; no number names it.
    expect(detectCarrierMatch('I100000017').candidates ?? []).not.toContain('rhenus-it');
  });
});

describe('Inntralog and DG Transporte', () => {
  it('names them apart from Rhenus Germany', () => {
    expect(carrierIdFromName('Inntralog GmbH')).toBe('inntralog');
    expect(carrierIdFromName('Rhenus Home Delivery GmbH')).toBe('rhenus-de');
    expect(carrierIdFromName('DG Transporte GmbH')).toBe('dg-transporte');
  });
});

describe('Andreani shipment numbers', () => {
  it('suggests Andreani first for its fifteen-digit prefixes and leaves other fifteen-digit runs alone', () => {
    for (const number of ['360000000000001', '310000000000002', '300000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: expect.arrayContaining(['andreani']) });
      expect(recognitionAskedCarriers(number), number).toContain('andreani');
    }
    for (const number of ['320000000000001', '360010000000001', '900000000000001', '36000000000001', '3600000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('andreani');
    }
  });
});

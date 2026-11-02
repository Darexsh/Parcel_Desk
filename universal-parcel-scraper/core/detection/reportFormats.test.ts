import { describe, expect, it } from 'vitest';
import { detectCarrierMatch, parseTrackingInput, validTrackingNumber } from './index.js';

describe('evidence-backed tracking formats', () => {
  it.each(['87001234567890I', '88001234567890V', '86301234567890D', '86401234567890V'])('keeps the tracked-mail key in %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'la-poste', confidence: 'high' });
    expect(parseTrackingInput(`Suivi : ${number}`)).toMatchObject({
      trackingNumber: number, carrier: 'la-poste', confidence: 'high', source: 'text',
    });
    expect(parseTrackingInput(`https://www.laposte.fr/outils/suivre-vos-envois?code=${number}`))
      .toMatchObject({ trackingNumber: number, carrier: 'la-poste', source: 'link' });
  });

  it('bounds the tracked-mail rule to its evidenced prefixes and length', () => {
    for (const number of ['89001234567890A', '86201234567890I', '8800123456789A', '880012345678901A']) {
      expect(detectCarrierMatch(number).carrier).not.toBe('la-poste');
    }
  });

  it.each(['5N12345678905', '5Z12345678905'])('recognizes the documented Colissimo family: %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'la-poste', confidence: 'high' });
  });

  it('routes Canadian postal identifiers only when their checksum passes', () => {
    expect(parseTrackingInput('EE 123 456 785 CA')).toMatchObject({ carrier: 'canada-post', confidence: 'high' });
    expect(detectCarrierMatch('EE123456785CA').candidates).not.toContain('intl-post');
    expect(detectCarrierMatch('EE123456789CA').candidates).not.toContain('canada-post');
  });

  it('keeps a Relais Colis numeric parcel ambiguous', () => {
    expect(detectCarrierMatch('1234567890')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('1234567890').candidates).toContain('relais-colis');
    // Fourteen digits are DPD's parcel number; Relais Colis is not offered for them.
    expect(detectCarrierMatch('12345678901234').candidates).not.toContain('relais-colis');
  });

  it('offers a normalized legacy DTDC reference without selecting it', () => {
    expect(detectCarrierMatch('v12345678')).toMatchObject({
      carrier: 'unknown', confidence: 'low', candidates: ['dtdc'],
    });
    expect(detectCarrierMatch('V1234567').candidates).not.toContain('dtdc');
    expect(detectCarrierMatch('V123456789').candidates).not.toContain('dtdc');
  });

  it.each(['B12345678', 'f12345678', 'Z12345678'])('suggests DTDC for the legacy waybill %s without selecting it', (number) => {
    expect(detectCarrierMatch(number)).toEqual({
      carrier: 'unknown', confidence: 'low', candidates: ['dtdc'], preferred: [],
    });
  });

  it('leaves letters no DTDC reply showed, and other lengths, out of the legacy waybill rule', () => {
    for (const number of ['W12345678', 'E12345678', 'Z1234567', 'Z123456789']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('dtdc');
    }
    // One DTDC reply shows an A waybill, a shape a Day & Ross sample shares.
    expect(detectCarrierMatch('A12345678').candidates).not.toContain('dtdc');
    // Packeta keeps its ten-digit Z barcodes.
    expect(detectCarrierMatch('Z1234567890')).toMatchObject({ carrier: 'packeta', confidence: 'high' });
  });

  it('gives the JVGL family to the Benelux network without changing GM routing', () => {
    expect(detectCarrierMatch('JVGL01234567890123456789')).toMatchObject({
      carrier: 'dhl-ecommerce-nl', confidence: 'high', candidates: ['dhl-ecommerce-nl'],
    });
    expect(parseTrackingInput('https://www.dhl.com/ch-en/home/tracking.html?tracking-id=JVGL01234567890123456789&submit=1'))
      .toMatchObject({ carrier: 'dhl-ecommerce-nl', confidence: 'high', source: 'link' });
    expect(parseTrackingInput('https://my.dhlecommerce.nl/home/tracktrace/JVGL01234567890123456789?lang=nl-NL'))
      .toMatchObject({ carrier: 'dhl-ecommerce-nl', trackingNumber: 'JVGL01234567890123456789', source: 'link' });
    expect(parseTrackingInput('https://www.dhl.de/en/privatkunden/dhl-sendungsverfolgung.html?piececode=JVGL01234567890123456789'))
      .toMatchObject({ carrier: 'dhl', confidence: 'high', source: 'link' });
    expect(detectCarrierMatch('GM1234567890123456')).toMatchObject({ carrier: 'dhl-ecommerce', confidence: 'high' });
  });

  it.each(['GM10293847', 'GM1029384756', 'GM10293847561', 'GM102938475610293'])(
    'suggests DHL eCommerce first for a shorter GM number without selecting it: %s',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['dhl-ecommerce'] });
      expect(detectCarrierMatch(number).candidates[0]).toBe('dhl-ecommerce');
    },
  );

  it.each(['GM1029384', 'GX1029384756'])('does not suggest DHL eCommerce for %s', (number) => {
    expect(detectCarrierMatch(number).candidates).not.toContain('dhl-ecommerce');
  });

  it.each([
    ['https://allegro.pl/allegrodelivery/sledzenie-paczki?numer=', 'A0000000A1', 'allegro-one'],
    ['https://allegro.pl/kampania/one/kurier/sledzenie-paczki?numer=', 'AD00000000', 'allegro-one'],
    ['https://www.orangeconnex.com/tracking?trackingNumber=', 'EE000000000000000000000000AB', 'speedpak'],
  ])('names the carrier of a tracker that shows other numbers only for its own: %s', (link, own, carrier) => {
    expect(parseTrackingInput(`${link}${own}`))
      .toMatchObject({ trackingNumber: own, carrier, confidence: 'high', candidates: [carrier], source: 'link' });
    for (const other of ['1Z999AA10123456784', 'XYZ12345']) {
      expect(parseTrackingInput(`${link}${other}`))
        .toEqual({ ...parseTrackingInput(other), source: 'link' });
    }
  });

  it.each(['GM1234567890123456', '1234567890', '9261290100130412345678'])('reads a DHL eCommerce tracking page link like the global one: %s', (number) => {
    expect(parseTrackingInput(`https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html?submit=1&tracking-id=${number}`))
      .toEqual(parseTrackingInput(`https://www.dhl.com/us-en/home/tracking.html?submit=1&tracking-id=${number}`));
  });

  it('reads DHL links on its local tracking and service pages, not on its division pages', () => {
    // A reference detection alone does not recognize shows that DHL's rule read it.
    for (const page of ['de-de/home/sendungsverfolgung.html', 'fr-fr/home/service-client.html', 'gb-en/home/tracking/tracking-parcel.html']) {
      expect(parseTrackingInput(`https://www.dhl.com/${page}?tracking-id=TESTA1`)).toMatchObject({
        trackingNumber: 'TESTA1', carrier: 'dhl', confidence: 'high', source: 'link',
      });
    }
    for (const page of ['gb-en/home/our-divisions/parcel/business-users/help.html', 'gb-en/ecommerce/uk/about/privacy-notice.html']) {
      expect(parseTrackingInput(`https://www.dhl.com/${page}?tracking-id=TESTA1`))
        .toEqual(parseTrackingInput(`https://example.test/${page}?tracking-id=TESTA1`));
    }
  });

  it.each(['JX1234567890', 'jx 1234 5678 90'])('selects J&T for its Indonesian JX waybill: %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'j-and-t', confidence: 'high' });
  });

  it('bounds the JX and Ninja Van families to their reported lengths', () => {
    expect(detectCarrierMatch('NJVTT12345678901')).toMatchObject({ carrier: 'ninja-van', confidence: 'high' });
    for (const number of ['JX123456789', 'JX12345678901', 'NJVTT1234567890', 'NJVTT123456789012', 'NJVAB12345678901']) {
      expect(detectCarrierMatch(number).candidates).not.toContain(number.startsWith('JX') ? 'j-and-t' : 'ninja-van');
    }
  });

  it('suggests J&T for its other two-letter waybills without selecting it', () => {
    for (const number of ['JP1234567890', 'JO1234567890', 'JT1234567890']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['colis-prive', 'j-and-t', 'aramex-au', 'aramex-nz'] });
    }
    expect(detectCarrierMatch('J11234567890').candidates).not.toContain('j-and-t');
  });

  it('offers Correos Express for a 23-digit reference and nothing shorter or longer', () => {
    expect(detectCarrierMatch('90000000000000123000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['correos-express'] });
    expect(detectCarrierMatch('9000000000000000000001').candidates).not.toContain('correos-express');
    expect(detectCarrierMatch('900000000000000000000001').candidates).not.toContain('correos-express');
  });

  it('selects CNE for its own family and only suggests the carriers of shared ones', () => {
    expect(detectCarrierMatch('3a5v 123456789')).toMatchObject({ carrier: 'cne', confidence: 'high' });
    expect(detectCarrierMatch('3A5V12345678').carrier).toBe('unknown');
    expect(detectCarrierMatch('CRIN26010112345678')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['intelcom'] });
  });

  it('keeps the 000010 account ambiguous between TIPSA and CTT Express', () => {
    const shared = detectCarrierMatch('0000100000101234567890');
    expect(shared).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['tipsa'] });
    expect(shared.candidates).toEqual(expect.arrayContaining(['tipsa', 'ctt-express']));
    expect(detectCarrierMatch('0082800082801234567890')).toMatchObject({ carrier: 'ctt-express', confidence: 'high' });
    expect(detectCarrierMatch('0000100000101234567890001')).toMatchObject({ carrier: 'ctt-express', confidence: 'high' });
  });

  it('selects Posti for its 21-character parcel ID', () => {
    expect(detectCarrierMatch('JJFI 654321 55555123456')).toMatchObject({ carrier: 'posti', confidence: 'high' });
    for (const number of ['JJFI6543215555512345', 'JJFI654321555551234567', 'JJSE65432155555123456']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('posti');
    }
  });

  it('reads SmartPosti tracking links as Posti, whose tracker they use', () => {
    for (const link of [
      'https://www.smartposti.ee/en/tracking/JJFI65432155555123456',
      'https://www.smartposti.ee/saadetise-jalgimine/JJFI65432155555123456',
      'https://www.smartposti.lt/siuntos-sekimas/JJFI65432155555123456',
      'https://www.smartposti.lv/pakas-meklesana/JJFI65432155555123456',
      'https://www.smartposti.lv/en/tracking/JJFI65432155555123456',
      'https://www.smartposti.lt/en/receiving/parcel-tracking?trackingCode=JJFI65432155555123456',
      'https://www.itella.lt/en/private-customer/track-shipment/?trackingCode=JJFI65432155555123456',
      'https://itella.lv/business-customer/track-shipment/?trackingCode=JJFI65432155555123456',
    ]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'JJFI65432155555123456', carrier: 'posti', source: 'link' });
    }
    expect(parseTrackingInput('https://www.smartposti.ee/en/pakiautomaadid')?.source).not.toBe('link');
    expect(parseTrackingInput('https://www.smartposti.lv/pakas-meklesana')?.source).not.toBe('link');
  });

  it('suggests Sendle first for QSS and nine digits, which Purolator leaves to it', () => {
    const match = detectCarrierMatch('QSS000000001');
    expect(match).toMatchObject({ confidence: 'low', preferred: ['sendle'] });
    expect(match.candidates).not.toContain('purolator');
    for (const number of ['QSS00000001', 'QSS0000000001', 'QS000000001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('sendle');
    }
    expect(detectCarrierMatch('QSA000000001').candidates).toContain('purolator');
  });

  it('suggests Paquetería Flecha Amarilla for its P, C and CB guías, typed with or without the space', () => {
    // Synthetic guías in the layouts archived lookups on its former tracker show.
    for (const number of ['P000001', 'C 0000001', 'CB000001', 'p-000001']) {
      expect(detectCarrierMatch(number).candidates, number).toContain('flecha-amarilla');
    }
    for (const number of ['P00001', 'C00000001', 'CB0000001', 'TP000001', 'I000001', 'Q000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('flecha-amarilla');
    }
  });

  it("suggests Express.Ru for its Web- orders and WEBN waybills", () => {
    // Synthetic numbers in the layouts its tracker hint and API guide give.
    for (const number of ['Web-0000000001', 'WEB0000000001', 'WEBN0000001', 'WEBN0000000001']) {
      expect(detectCarrierMatch(number).candidates, number).toContain('express-ru');
    }
    for (const number of ['Web-000000001', 'WEB00000000001', 'WEBN000001', 'WEBN00000000001', 'WEX0000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('express-ru');
    }
  });

  it('suggests FERCAM for the letter O, the year and eight digits', () => {
    expect(detectCarrierMatch('O2500000001').candidates).toContain('fercam');
    for (const number of ['02500000001', 'O250000001', 'O25000000001', 'Q2500000001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('fercam');
    }
  });

  it('reads Trunkrs, GIG Logistics and Sendle tracking links', () => {
    expect(parseTrackingInput('https://parcel.trunkrs.nl/400000001/0000AA'))
      .toMatchObject({ trackingNumber: '400000001', carrier: 'trunkrs', source: 'link' });
    expect(parseTrackingInput('https://parcel.trunkrs.nl/barcode/400000001')?.carrier).not.toBe('trunkrs');
    expect(parseTrackingInput('https://giglogistics.com/track-shipment/?waybill=1000000001'))
      .toMatchObject({ trackingNumber: '1000000001', carrier: 'gig-logistics', source: 'link' });
    expect(parseTrackingInput('https://www.sendle.com/tracking?ref=QSS000000001'))
      .toMatchObject({ trackingNumber: 'QSS000000001', carrier: 'sendle', source: 'link' });
  });

  it('suggests Ukrposhta for a thirteen-digit domestic barcode among the carriers sharing that length', () => {
    const match = detectCarrierMatch('0500000000003');
    expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(match.candidates).toEqual(expect.arrayContaining(['ukrposhta', 'la-poste']));
    expect(detectCarrierMatch('050000000001').candidates).not.toContain('ukrposhta');
  });

  it('suggests Colisweb for eight digits and nothing longer', () => {
    expect(detectCarrierMatch('12345678')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['mondial-relay', 'colisweb', 'heppner'] });
    expect(detectCarrierMatch('123456789').candidates).not.toContain('colisweb');
  });

  it('files the Canadian and Mexican Amazon prefixes with Amazon Logistics', () => {
    for (const number of ['TBA123456789012', 'TBC 123456789012', 'tbm123456789012']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'amazon-logistics', confidence: 'high' });
    }
    expect(detectCarrierMatch('TBB123456789012').carrier).toBe('unknown');
  });

  it('suggests J&T Cargo for a twelve-digit waybill starting with 20 and reads its link', () => {
    expect(detectCarrierMatch('200123456789').candidates).toContain('j-and-t-cargo');
    expect(detectCarrierMatch('210123456789').candidates).not.toContain('j-and-t-cargo');
    expect(detectCarrierMatch('20012345678').candidates).not.toContain('j-and-t-cargo');
    expect(parseTrackingInput('https://www.jtcargo.id/networkQuery?waybillNo=200123456789&type=0'))
      .toMatchObject({ trackingNumber: '200123456789', carrier: 'j-and-t-cargo', source: 'link' });
  });

  it('keeps a J&T Cargo piece identifier whole through detection and pasted links', () => {
    const piece = '200000000001034';
    expect(detectCarrierMatch(piece)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(piece).candidates).toContain('j-and-t-cargo');
    expect(parseTrackingInput(`https://www.jtcargo.id/networkQuery?waybillNo=${piece}&type=0`))
      .toMatchObject({ trackingNumber: piece, carrier: 'j-and-t-cargo', source: 'link' });
    for (const number of ['210000000001034', '20000000000134', '2000000000010345']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('j-and-t-cargo');
    }
  });

  it('suggests Emile for its sixteen-character EM…CA numbers and reads its link', () => {
    expect(detectCarrierMatch('EM000000000001CA')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['emile'] });
    expect(parseTrackingInput('Tracking: EM000000000001CA')).toMatchObject({ trackingNumber: 'EM000000000001CA', confidence: 'low' });
    for (const number of ['EM00000000001CA', 'EM0000000000001CA', 'EE000000000001CA', 'EM000000000001US']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('emile');
    }
    // Canada Post's EMS items share the prefix and suffix but carry nine digits.
    expect(detectCarrierMatch('EM123456785CA')).toMatchObject({ carrier: 'canada-post', confidence: 'high' });
    expect(parseTrackingInput('https://www.emileps.com/tracking?tracking=EM000000000001CA'))
      .toMatchObject({ trackingNumber: 'EM000000000001CA', carrier: 'emile', source: 'link' });
  });

  it('takes a number without a digit only as unbroken letters a carrier claims, entered whole', () => {
    for (const input of ['AALZJR', 'aalzjr', ' ABCDEF ']) expect(validTrackingNumber(input)).toBe(true);
    // No carrier issues seven letters, and twelve are outside what a rule may claim.
    for (const input of ['ABCDE', 'ABCDEFG', 'ABCDEFGHIJ', 'CONFIRMATION', 'AAL ZJR', 'AAL-ZJR', 'thank you', 'ÀBCDEF']) expect(validTrackingNumber(input)).toBe(false);
    expect(detectCarrierMatch('CONFIRMATION').confidence).toBe('low');
    expect(parseTrackingInput('bonjour').source).toBe('none');
    expect(parseTrackingInput('aalzjr')).toMatchObject({ trackingNumber: 'aalzjr', carrier: 'unknown', confidence: 'low', candidates: ['gls-ch', 'gls-de'], source: 'number' });
    // A word after a tracking label, or anywhere in a message, is not a number.
    expect(parseTrackingInput('Tracking number: PENDING').source).toBe('none');
    expect(parseTrackingInput('Your parcel AALZJR is on its way').source).toBe('none');
    expect(parseTrackingInput('thank you').source).toBe('none');
    // A carrier's own link can carry one. GLS's group-wide links go to GLS Germany, its Swiss ones to GLS Switzerland.
    expect(parseTrackingInput('https://gls-group.eu/EU/en/parcel-tracking?match=AALZJR'))
      .toMatchObject({ trackingNumber: 'AALZJR', carrier: 'gls-de', source: 'link' });
    expect(parseTrackingInput('https://gls-group.eu/GROUP/en/parcel-tracking?match=AALZJR'))
      .toMatchObject({ trackingNumber: 'AALZJR', carrier: 'gls-de', confidence: 'high', source: 'link' });
    expect(parseTrackingInput('https://gls-group.eu/GROUP/en/parcel-tracking?match=12345678901'))
      .toMatchObject({ trackingNumber: '12345678901', carrier: 'gls-de', confidence: 'high', source: 'link' });
    // GLS France's tracker forwards to GROUP links; a number only GLS France issues still names it there.
    expect(parseTrackingInput('https://gls-group.eu/GROUP/fr/parcel-tracking?match=00AB12CD'))
      .toMatchObject({ trackingNumber: '00AB12CD', carrier: 'gls-fr', confidence: 'high', source: 'link' });
    // A GLS track ID that LSO's pattern also matches stays with GLS on a GLS Germany link.
    expect(parseTrackingInput('https://gls-group.eu/EU/en/parcel-tracking?match=ZY0AB12C'))
      .toMatchObject({ trackingNumber: 'ZY0AB12C', carrier: 'gls-de', source: 'link' });
    expect(parseTrackingInput('https://gls-group.eu/CH/de/paketverfolgung?match=AALZJR'))
      .toMatchObject({ trackingNumber: 'AALZJR', carrier: 'gls-ch', source: 'link' });
    // The group tracker's pages for countries without a GLS network of their own in the catalog ask the same service.
    expect(parseTrackingInput('https://gls-group.com/RO/en/parcel-tracking?match=12345678901'))
      .toMatchObject({ trackingNumber: '12345678901', carrier: 'gls-de', confidence: 'high', source: 'link' });
    expect(parseTrackingInput('https://gls-group.com/SK/sk/sledovanie-zasielok?match=AALZJR'))
      .toMatchObject({ trackingNumber: 'AALZJR', carrier: 'gls-de', source: 'link' });
  });

  it('does not offer UPS for a letter and ten digits, which its adapter does not take', () => {
    // UPS lists no letter but T before ten digits; the H, J, K and V waybills of an open-source list stay with others.
    expect(detectCarrierMatch('H1234567890')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dtdc', 'gls-it'] });
    for (const number of ['A1234567890', 'J1234567890', 'K1234567890', 'V1234567890']) expect(detectCarrierMatch(number).candidates, number).not.toContain('ups');
  });

  it('does not infer a GLS country or Aramex service from a short reference', () => {
    // Six letters are a GLS Track ID: both networks are suggested and neither is selected.
    expect(detectCarrierMatch('ABCDEF')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['gls-ch', 'gls-de'] });
    expect(detectCarrierMatch('ABCDE')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(detectCarrierMatch('ABCDEFG')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(detectCarrierMatch('9680123456').candidates).not.toContain('aramex');
  });
});

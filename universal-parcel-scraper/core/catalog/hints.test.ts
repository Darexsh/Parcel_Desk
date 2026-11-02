import { describe, expect, it } from 'vitest';
import {
  brandCarrierIds, brandTimeZones, carrierIdFromName, carrierIdFromPartner, carrierIdFromPartnerLinks, carrierNameCountryZone, isCarrierFeedName,
  isKnownCarrierName, nationalPostCandidate,
} from './hints.js';

describe('brand networks', () => {
  it('lists the catalog networks of a bare or group brand name', () => {
    expect(new Set(brandCarrierIds('DPD Group'))).toEqual(new Set(['dpd', 'dpd-fr', 'dpd-de', 'dpd-uk', 'dpd-pl', 'dpd-ie', 'dpd-za', 'dpd-be', 'dpd-nl', 'dpd-pt', 'dpd-at', 'dpd-ro', 'dpd-hu']));
    expect(brandCarrierIds('gls')).toEqual(expect.arrayContaining(['gls-ch', 'gls-de', 'gls-fr']));
    expect(brandCarrierIds('GOFO')).toEqual(expect.arrayContaining(['gofo', 'gofo-fr', 'gofo-it', 'gofo-nl', 'gofo-es']));
    expect(carrierIdFromName('GOFO')).toBeUndefined();
    expect(carrierIdFromName('GOFO France')).toBe('gofo-fr');
    expect(carrierIdFromName('GOFO Italy')).toBe('gofo-it');
    expect(carrierIdFromName('GOFO Netherlands')).toBe('gofo-nl');
    expect(carrierIdFromName('CIRRO Parcel Netherlands')).toBe('gofo-nl');
    expect(carrierIdFromName('GOFO Spain')).toBe('gofo-es');
    // Early Bird's former name, and the 3PL brand that tracks through Shree Maruti's tracker.
    expect(carrierIdFromName('Morgontidig Distribution')).toBe('early-bird');
    expect(carrierIdFromName('MTD')).toBeUndefined();
    expect(carrierIdFromName('Innofulfill')).toBe('shree-maruti');
    expect(carrierIdFromName('Nova Poshta Global')).toBe('nova-global');
    expect(carrierIdFromName('Nova Poshta')).toBe('nova-poshta');
    // Providers name the line provider whose numbers DHLink tracks.
    expect(carrierIdFromName('XZG')).toBe('dhlink');
    // Providers also name Correios by the English name of the country's post.
    expect(carrierIdFromName('Brazil Post')).toBe('correios-br');
    // ParcelsApp names South Africa's post after the country.
    expect(carrierIdFromName('South Africa Post Office')).toBe('south-african-post-office');
    // Universal providers name Z-Leading after its Chinese name.
    expect(carrierIdFromName('Zhongling')).toBe('z-leading');
    expect(carrierIdFromName('Pengyou')).toBe('pengyou');
    expect(carrierIdFromName('Jifan')).toBe('jifan');
    expect(carrierIdFromName('YBWL')).toBe('youbang-express');
    expect(carrierIdFromName('FASTBOX')).toBe('fastbox');
    // ParcelsApp and Ship24 name North Macedonia's post as Macedonia Post.
    expect(carrierIdFromName('Macedonia Post')).toBe('posta-north-macedonia');
    // ParcelsApp names MHI by its tracker, Mondial Relay's Spanish network by its shop
    // brand, and JD Logistics and Sky Express International by their other names.
    expect(carrierIdFromName('Trackmail')).toBe('mhi');
    expect(carrierIdFromName('Punto Pack')).toBe('mondial-relay');
    expect(carrierIdFromName('Jingdong Logistics')).toBe('jd-logistics');
    expect(carrierIdFromName('京东物流')).toBe('jd-logistics');
    expect(carrierIdFromName('SkyEx')).toBe('skyex-ae');
    expect(carrierIdFromName('Sky Express')).toBeUndefined();
    expect(carrierIdFromName('Shouwu Express')).toBe('shouwu');
    expect(carrierIdFromName('TopYou')).toBe('topyou');
    // Universal providers name YFHEX by its short name.
    expect(carrierIdFromName('YFH')).toBe('yfhex');
    // DHL names SmartPosti, Posti's Baltic parcel network, by its former name.
    expect(carrierIdFromName('Itella')).toBe('posti');
    // GLS Portugal's shipments are GLS Spain's service's.
    expect(carrierIdFromName('GLS Portugal')).toBe('gls-es');
    // China Post's express service trades as China EMS; the cooperative's EMS stays its own.
    expect(carrierIdFromName('China EMS')).toBe('china-post');
    expect(carrierIdFromName('EMS')).toBe('ems');
    expect(brandCarrierIds('DPD UK')).toEqual([]);
    expect(brandCarrierIds('Swiss Post')).toEqual([]);
  });
});

describe('national postal lookup candidates', () => {
  it.each([
    ['CH', 'swiss-post'], [' Switzerland ', 'swiss-post'], ['FI', 'posti'], ['finland', 'posti'],
    ['NL', 'spring-gds'], ['FR', 'la-poste'], ['GB', 'royal-mail'], ['US', 'usps'],
    ['CA', 'canada-post'], ['DE', 'dhl'], ['ES', 'correos-spain'], ['JP', 'japan-post'], ['Japan', 'japan-post'],
    ['AU', 'australia-post'], ['Australia', 'australia-post'], ['PL', 'poczta-polska'], ['Poland', 'poczta-polska'],
    ['UA', 'ukrposhta'], ['Ukraine', 'ukrposhta'], ['SA', 'saudi-post'], ['Saudi Arabia', 'saudi-post'],
    ['AR', 'correo-argentino'], ['Argentina', 'correo-argentino'], ['PT', 'ctt'], ['Portugal', 'ctt'],
    ['RO', 'posta-romana'], ['Romania', 'posta-romana'], ['EG', 'egypt-post'], ['Egypt', 'egypt-post'],
    ['ZA', 'south-african-post-office'], ['South Africa', 'south-african-post-office'],
    ['BY', 'belpost'], ['Belarus', 'belpost'],
    ['BG', 'bulgarian-posts'], ['Bulgaria', 'bulgarian-posts'],
    ['UZ', 'uzbekistan-post'], ['Uzbekistan', 'uzbekistan-post'],
    ['BD', 'bangladesh-post'], ['Bangladesh', 'bangladesh-post'],
    ['MA', 'barid-al-maghrib'], ['Morocco', 'barid-al-maghrib'],
    ['DZ', 'algerie-poste'], ['Algeria', 'algerie-poste'],
    ['CU', 'correos-cuba'], ['Cuba', 'correos-cuba'],
    ['MK', 'posta-north-macedonia'], ['North Macedonia', 'posta-north-macedonia'],
    ['PH', 'phlpost'], ['Philippines', 'phlpost'],
    ['AM', 'haypost'], ['Armenia', 'haypost'],
    ['JO', 'jordan-post'], ['Jordan', 'jordan-post'],
    ['IS', 'posturinn'], ['Iceland', 'posturinn'],
    ['KE', 'posta-kenya'], ['Kenya', 'posta-kenya'],
    ['UY', 'correo-uruguayo'], ['Uruguay', 'correo-uruguayo'],
    ['FO', 'posta-faroe'], ['Faroe Islands', 'posta-faroe'],
    ['SV', 'correos-el-salvador'], ['El Salvador', 'correos-el-salvador'],
    ['IE', 'an-post'], ['Ireland', 'an-post'], ['BE', 'bpost'], ['Belgium', 'bpost'],
    ['AT', 'austrian-post'], ['Austria', 'austrian-post'],
    ['HR', 'hrvatska-posta'], ['Croatia', 'hrvatska-posta'], ['CZ', 'ceska-posta'], ['Czechia', 'ceska-posta'],
    ['GR', 'elta'], ['Greece', 'elta'], ['EE', 'omniva'], ['Estonia', 'omniva'], ['LV', 'latvijas-pasts'], ['Latvia', 'latvijas-pasts'],
    ['LT', 'lietuvos-pastas'], ['Lithuania', 'lietuvos-pastas'], ['SK', 'slovenska-posta'], ['Slovakia', 'slovenska-posta'],
    ['DK', 'postnord'], ['Denmark', 'postnord'], ['NO', 'bring-posten'], ['Norway', 'bring-posten'],
    ['BR', 'correios-br'], ['Brazil', 'correios-br'],
    ['IT', 'poste-italiane'], ['Italy', 'poste-italiane'],
    ['RS', 'posta-srbije'], ['Serbia', 'posta-srbije'], ['SI', 'posta-slovenije'], ['Slovenia', 'posta-slovenije'],
    ['CY', 'cyprus-post'], ['Cyprus', 'cyprus-post'], ['MT', 'maltapost'], ['Malta', 'maltapost'],
    ['LU', 'post-luxembourg'], ['Luxembourg', 'post-luxembourg'], ['HU', 'magyar-posta'], ['Hungary', 'magyar-posta'],
    ['KG', 'kyrgyz-post'], ['Kyrgyzstan', 'kyrgyz-post'], ['PK', 'pakistan-post'], ['Pakistan', 'pakistan-post'],
    ['PE', 'serpost'], ['Peru', 'serpost'], ['ID', 'pos-indonesia'], ['Indonesia', 'pos-indonesia'],
    ['NZ', 'nz-post'], ['New Zealand', 'nz-post'], ['IL', 'israel-post'], ['Israel', 'israel-post'],
  ])('suggests one operator for destination %s', (country, expected) => {
    expect(nationalPostCandidate(country)).toBe(expected);
  });
  // India Post looks up only numbers of its own, and Pos Malaysia's tracker answers any S10
  // number but leaves the scans of mail from abroad undated, so these destinations have no
  // candidate.
  it.each(['XX', 'LI', 'IN', 'MY', 'unknown', 'Arrived in Switzerland', 'constructor', '', null, 123])(
    'leaves unavailable or ambiguous destinations alone: %s', (country) => {
      expect(nationalPostCandidate(country)).toBeUndefined();
    },
  );
});

describe('delivery partner evidence', () => {
  it.each([
    ['Posti', '', 'posti'],
    ['Unknown partner label', 'https://www.posti.fi/en/tracking#/lahetys/TEST1234?lang=en', 'posti'],
    ['Swiss Post', 'https://www.post.ch/', 'swiss-post'],
    ['USPS', 'https://tools.usps.com/go/TrackConfirmAction', 'usps'],
    ['Asendia USA', '', 'asendia'],
    ['Asendia', 'https://a1.asendiausa.com/tracking/?trackingnumber=TEST1234', 'asendia'],
    ['GLS', '', undefined],
    ['constructor', '', undefined],
    ['Unknown carrier', '', undefined],
    ['Posti', 'https://www.post.ch/', undefined],
    ['', 'https://www.posti.fi.evil.test/', undefined],
    ['', 'https://www.posti.fi@evil.test/', undefined],
    ['', 'https://evil.test/?url=https://www.posti.fi/', undefined],
    ['', 'javascript://www.posti.fi/', undefined],
    ['', 'not a URL', undefined],
    // A named partner stands unless its link is on another carrier's host.
    ['DHL eCommerce', 'https://www.dhl.com/', 'dhl-ecommerce'],
    ['DHL eCommerce', 'https://www.dhl.com/us-en/home.html', 'dhl-ecommerce'],
    ['DHL eCommerce', 'https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html', 'dhl-ecommerce'],
    ['GLS Germany', 'https://gls-group.eu/EU/en/parcel-tracking', 'gls-de'],
    ['GLS France', 'https://gls-group.eu/EU/en/parcel-tracking', 'gls-fr'],
    ['GLS Switzerland', 'https://gls-group.eu/EU/en/parcel-tracking', 'gls-ch'],
    ['GLS Germany', 'https://www.dhl.com/', undefined],
    // Without a name, a rule limited to some paths of a shared host covers only those paths.
    ['', 'https://www.gofo.com/', 'gofo'],
    ['', 'https://www.gofo.com/us/track?searchID=GFUS01000000000001', 'gofo'],
    ['', 'https://www.gofo.com/fr/', 'gofo-fr'],
    ['', 'https://www.gofo.com/it/', 'gofo-it'],
    ['', 'https://www.gofo.com/es/', 'gofo-es'],
    ['', 'https://www.gofo.com/usa/', undefined],
    ['', 'https://gls-group.eu/FR/fr/suivi-colis', 'gls-fr'],
    ['', 'https://gls-group.eu/EU/en/parcel-tracking', 'gls-de'],
    ['', 'https://gls-group.eu/GROUP/en/parcel-tracking', 'gls-de'],
    ['', 'https://gls-group.eu/CH/de/paketverfolgung', 'gls-ch'],
    ['', 'https://gls-group.com/BG/en/parcel-tracking?match=12345678901', 'gls-de'],
    ['', 'https://gls-group.com/HR/hr/pracenje-paketa?match=12345678901', 'gls-de'],
    ['', 'https://www.speedy.bg/bg/track-shipment?shipmentNumber=61234567890', 'speedy'],
    ['', 'https://www.speedy.bg/begin.php?shipmentNumber=61234567890', 'speedy'],
    ['', 'https://myspeedy.speedy.bg/pub/tracking/61234567890', 'speedy'],
    ['', 'https://boxnow.bg/track?track=9000000001', 'box-now'],
    ['', 'https://boxnow.gr/en/track?track=9000000001', 'box-now'],
    ['', 'https://gls-group.eu/', undefined],
    // A carrier's own host: its tracking pages and home page name it, its other pages none.
    ['', 'https://vas.brt.it/vas/sped_det_show.hsm', 'brt'],
    ['', 'https://vas.brt.it/vas/faq.htm', undefined],
    ['', 'https://www.seur.com/', 'seur'],
    // A brand with several networks is read from its link: La Poste names BRT's parcels DPD with myBRT's link.
    ['DPD', 'https://www.mybrt.it/', 'brt'],
    ['DPD', '', undefined],
    ['', 'https://www.seur.com/en/miseur/mis-envios/detalle', 'seur'],
    ['', 'https://www.seur.com/livetracking/', 'seur'],
    ['', 'https://www.seur.com/envio-online/', undefined],
    ['', 'https://www.tip-sa.com/', 'tipsa'],
    ['', 'https://aplicaciones.tip-sa.com/cliente/datos_env.php', 'tipsa'],
    ['', 'https://www.tip-sa.com/contacto.php', undefined],
    ['', 'https://www.nacex.es/', 'nacex'],
    ['', 'https://www.nacex.es/seguimientoDetalle.do', 'nacex'],
    ['', 'https://www.nacex.es/irCerca.do', undefined],
    ['NACEX', 'https://www.nacex.es/irCerca.do', 'nacex'],
    ['', 'https://cs.estafeta.com/', 'estafeta'],
    ['', 'https://cs.estafeta.com/es/Tracking/GetTrackingItemHistory', undefined],
    ['', 'https://track.thecourierguy.co.za/', 'the-courier-guy'],
    ['', 'https://portal.thecourierguy.co.za/track', 'the-courier-guy'],
    ['', 'https://portal.thecourierguy.co.za/shipments/new', undefined],
    // DHL's eCommerce tracking page is shared, like its global one; its other pages are DHL's,
    // except its division pages and DHL eCommerce's regional pages, whose network depends on the country.
    ['', 'https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html', undefined],
    ['', 'https://www.dhl.com/us-en/home/tracking/tracking-express.html', 'dhl'],
    ['', 'https://www.dhl.com/gb-en/home.html', 'dhl'],
    ['', 'https://www.dhl.com/gb-en/home/our-divisions/parcel/business-users/help.html', undefined],
    ['', 'https://www.dhl.com/gb-en/home/our-divisions.html', undefined],
    ['', 'https://www.dhl.com/gb-en/ecommerce/uk/about/privacy-notice.html', undefined],
    ['DHL eCommerce', 'https://www.dhl.com/gb-en/home/our-divisions/parcel.html', 'dhl-ecommerce'],
    // FedEx's worldwide tracking link is FedEx's, unless it holds FedEx Poland's thirteen digits.
    ['', 'https://www.fedex.com/fedextrack/?trknbr=999999999999', 'fedex'],
    ['', 'https://www.fedex.com/fedextrack/', 'fedex'],
    ['', 'https://www.fedex.com/fedextrack/?trknbr=6230000000005', 'fedex-pl'],
  ])('resolves name %s and URL %s without guessing', (name, url, expected) => {
    expect(carrierIdFromPartner(name, url)).toBe(expected);
  });

  it.each([
    ['Poste italienne', 'poste-italiane'], ['POSTE IRLANDAISE', 'an-post'], ['Poste GB', 'royal-mail'],
    ['Direction des Postes, Algerie', 'algerie-poste'], ['Organisme national des postes Egypt', 'egypt-post'],
    ['BARID AL-MAGHRIB, Maroc', 'barid-al-maghrib'], ['Societe nationale La Poste, Senegal', 'la-poste-senegal'],
    ['Office national des postes La Poste Tunisienne', 'la-poste-tunisienne'],
    ["Entreprise federale unitaire d'Etat Poste de Russie", 'russian-post'],
    ['Entreprise d\'Etat "Posta Moldovei"', 'posta-moldovei'], ['EUR BELPOCHTA, Belarus', 'belpost'],
    ['Haypost CJSC', 'haypost'], ['Correo Oficial de la Republica Argentina SA', 'correo-argentino'],
    ['Empresa Brasileira de Correios e Telegrafos', 'correios-br'], ['Empresa Correos de Chile', 'correos-chile'],
    ['JORDAN POST COMPANY', 'jordan-post'], ['SERPOST S.A., Peru', 'serpost'],
    ['Public Enterprise Post of Serbia', 'posta-srbije'], ['PUBLIC JOINT STOCK COMPANY "UKRPOSHTA"', 'ukrposhta'],
    ['SOUTH AFRICA POST OFFICE LIMITED', 'south-african-post-office'], ['Postur', 'posturinn'],
    ['SINGAPORE POST LIMITED', 'singapore-post'], ['Malaysia Post', 'pos-malaysia'],
    ['Department of Posts (India)', 'india-post'], ['Israel Postal Company Ltd', 'israel-post'],
    ['Turkish PTT Corporation', 'ptt'], ['Cameron Postal Services CAMPOST', 'campost'],
    ['Servico Postal Mexicano', 'correos-de-mexico'],
  ])('reads La Poste\'s partner name %s', (name, expected) => {
    expect(carrierIdFromPartner(name)).toBe(expected);
  });

  it('does not pick one of multiple partner links, but ignores the origin’s own links', () => {
    const origin = 'See https://www.dhl.de/ for tracking.';
    expect(carrierIdFromPartnerLinks([origin, 'Partner: https://www.posti.fi/en/tracking'], 'dhl')).toBe('posti');
    expect(carrierIdFromPartnerLinks(['https://www.posti.fi/ https://www.post.ch/'], 'dhl')).toBeUndefined();
  });
});

describe('carrier names reported by universal providers', () => {
  it.each([
    ['UPS', 'ups'], ['La Poste (Colissimo)', 'la-poste'], ['Chronopost France', 'chronopost'],
    ['Chronopost (France)', 'chronopost'], ['Posti Finland', 'posti'], ['Swiss Post CH', 'swiss-post'],
    ['Finland Post', 'posti'], ['Spain Post', 'correos-spain'], ['Portugal CTT', 'ctt'],
    ['Portugal Post - Portugal CTT', 'ctt'], ['Posten Norge - Norway Post', 'bring-posten'], ['Italy Post', 'poste-italiane'],
    ['Italy SDA', 'poste-italiane'],
    ['SDA Express Courier', 'poste-italiane'], ['4PX Express', 'four-px'], ['Asendia United States', 'asendia'],
    ['Deutsche Post - DHL Paket', 'dhl'], ['DHL eCommerce Global Mail', 'dhl-ecommerce'],
    ['Correos de España', 'correos-spain'], ['Correos Spain', 'correos-spain'], ['Austria Post', 'austrian-post'],
    ['Intelcom', 'intelcom'], ['Dragonfly', 'intelcom'], ['Orange Connex', 'speedpak'],
    ['Evri International', 'evri'], ['Evri', 'evri-uk'], ['Hermes UK', 'evri-uk'], ['DPD Germany', 'dpd-de'], ['DPD UK', 'dpd-uk'],
    // Carriers whose scans are instants, followed by their home country.
    ['BRT (IT)', 'brt'], ['Bpost Belgium', 'bpost'], ['Royal Mail (UK)', 'royal-mail'],
    // Names providers give these carriers' own parcels.
    ['Poland Post', 'poczta-polska'], ['Pocztex', 'poczta-polska'], ['Allegro Pocztex', 'poczta-polska'],
    ['Pocztex Kurier', 'poczta-polska'], ['DHL Poland', 'dhl-ecommerce-pl'], ['New Zealand Post', 'nz-post'],
    ['Slovenia Post', 'posta-slovenije'],
    ['Norway Post', 'bring-posten'], ['Amazon Swiship', 'amazon-shipping'], ['PostNord Denmark', 'postnord'],
    ['DHL Freight Active Tracing', 'dhl-freight'], ['Spring Global Mail', 'spring-gds'],
    ['CTT Express Tracking', 'ctt-express'], ['Sameday Bulgaria', 'sameday'],
    // Brands their network's tracker answers for.
    ['StarTrack', 'australia-post'], ['Star Track Express', 'australia-post'], ['Homerr', 'vinted-go'],
    ['InPost Spain', 'mondial-relay'], ['InPost España', 'mondial-relay'], ['InPost (ES)', 'mondial-relay'],
  ])('maps %s, a carrier followed by its own country included', (name, expected) => {
    expect(carrierIdFromName(name)).toBe(expected);
  });

  it.each([
    ['GLS (FR)', 'gls-fr'], ['GLS IT', 'gls-it'], ['GLS (DE)', 'gls-de'],
  ])('maps %s, a brand followed by the country of one of its networks', (name, expected) => {
    expect(carrierIdFromName(name)).toBe(expected);
  });

  it.each([
    // A country without one zone, a brand with several networks.
    'UPS United States', 'DHL Germany', 'GLS', 'France', 'Evri Group',
    // A carrier whose scans are instants, followed by a country other than its home.
    'Bpost Netherlands', 'Aramex Jordan',
    // No network there, two networks there, a worldwide network, a network on another clock.
    'DPD (NL)', 'Hermes (DE)', 'DHL (PL)', 'GLS (LI)',
    // InPost's own hub and Mondial Relay's network both deliver as InPost in Portugal.
    'InPost (PT)',
    // DPD's networks share one lookup, and a provider's country for its parcel can be another's.
    'DPD (BE)', 'DPD (DE)', 'DPD (CH)',
  ])('does not guess a carrier from %s', (name) => {
    expect(carrierIdFromName(name)).toBeUndefined();
  });

  it.each([
    'La Poste', 'La Poste (Colissimo)', 'Chronopost France', 'FedEx', 'India Post', 'Posti', 'UPS',
    'Chronopost Portugal', 'Correos Chile', 'Royal Mail (UK)', 'DHL', 'DHL Express', 'GLS Italy', 'DPD UK',
    'Finland Post', 'Spain Post', 'Portugal CTT', 'Portugal Post - Portugal CTT', 'Posten Norge - Norway Post', 'Italy Post', 'Deutsche Post - DHL Paket', 'Correos de España', 'Correos Spain',
    'Austria Post', 'Brazil Post', 'South Africa Post Office', 'Zhongling', 'CTT', 'Cirro',
  ])('knows %s from the catalog', (name) => {
    expect(isKnownCarrierName(name)).toBe(true);
  });

  it('knows plain CTT without naming Portugal\'s post or CTT Express', () => {
    expect(carrierIdFromName('CTT')).toBeUndefined();
    expect(carrierIdFromName('Portugal CTT')).toBe('ctt');
    expect(carrierIdFromName('CTT Express')).toBe('ctt-express');
  });

  it('knows plain Cirro without naming one of its networks', () => {
    expect(carrierIdFromName('Cirro')).toBeUndefined();
    expect(carrierIdFromName('CIRRO Parcel France')).toBe('gofo-fr');
    // CIRRO E-Commerce names both the US company GOFO bought and Cirro's cross-border line.
    expect(carrierIdFromName('CIRRO E-Commerce')).toBeUndefined();
  });

  it('reads a name typed without its accents as the accented catalog name', () => {
    expect(carrierIdFromName('DHL eCommerce Turkiye')).toBe('mng-kargo');
    expect(carrierIdFromName('Kuhne + Nagel')).toBe('kuehne-nagel');
    expect(carrierIdFromName('La Poste du Senegal')).toBe('la-poste-senegal');
  });

  it('reads FedEx International Connect by its name and abbreviation, never its Plus service or the old Cross Border name', () => {
    expect(carrierIdFromName('FedEx® International Connect (FIC)')).toBe('fedex-international-connect');
    expect(carrierIdFromName('FedEx International Connect')).toBe('fedex-international-connect');
    for (const name of ['FedEx International Connect Plus', 'FedEx® Cross Border (UK)', 'FIC']) {
      expect(carrierIdFromName(name), name).not.toBe('fedex-international-connect');
    }
  });

  it('reads a name in another script by its own letters, never by its Latin part alone', () => {
    expect(carrierIdFromName('中领国际')).toBe('z-leading');
    expect(carrierIdFromName('捧友')).toBe('pengyou');
    expect(carrierIdFromName('通邮')).toBe('topyou');
    expect(carrierIdFromName('原飞航')).toBe('yfhex');
    expect(carrierIdFromName('中華郵政')).toBe('chunghwa-post');
    expect(carrierIdFromName('CJ대한통운')).toBe('cj-logistics');
    // "ТММ Express" and "ΕΛΤΑ Courier" are aliases; their Latin words name no carrier.
    for (const name of ['Express', 'Courier', 'CJ', '5', '示例国际物流', 'Пример Доставка']) expect(carrierIdFromName(name)).toBeUndefined();
    for (const name of ['示例国际物流', 'Пример Доставка', 'Express']) expect(isKnownCarrierName(name)).toBe(false);
  });

  it.each(['Example Parcel Co', 'Example Express Italy', 'Postexample Courier'])('treats %s as new', (name) => {
    expect(isKnownCarrierName(name)).toBe(false);
  });

  it.each(['UPU', 'upu', 'Universal Postal Union'])('takes %s for the postal union\'s feed, not for a carrier', (name) => {
    expect(isCarrierFeedName(name)).toBe(true);
    expect(carrierIdFromName(name)).toBeUndefined();
    expect(isKnownCarrierName(name)).toBe(false);
    expect(carrierNameCountryZone(name)).toBeNull();
  });

  it.each(['UPS', 'Posti', 'Finland Post', 'Post', 'Example Parcel Co', ''])('takes %s for no feed', (name) => {
    expect(isCarrierFeedName(name)).toBe(false);
  });
});

describe('zones implied by carrier names', () => {
  it.each([
    // A carrier or brand network followed by a single-clock country, even when no carrier is identified.
    ['Chronopost France', 'Europe/Paris'], ['DPD UK', 'Europe/London'], ['GLS Italy', 'Europe/Rome'],
    ['DHL Parcel Netherlands', 'Europe/Amsterdam'], ['DHL Germany', 'Europe/Berlin'], ['Chronopost Portugal', 'Europe/Lisbon'],
    ['Royal Mail (UK)', 'Europe/London'], ['Cainiao (China)', 'Asia/Shanghai'],
  ])('reads %s in %s', (name, zone) => {
    expect(carrierNameCountryZone(name)).toBe(zone);
  });

  it.each(['Swiss Post', 'UPS', 'Asendia USA', 'UPS United States', 'Correos Chile', 'DPD Group', 'DHL', 'Example Express Italy', ''])(
    'implies no zone for %s', (name) => {
      expect(carrierNameCountryZone(name)).toBeNull();
    },
  );

  it('resolves supported national names and keeps uncatalogued networks ambiguous', () => {
    expect(carrierIdFromName('DPD UK')).toBe('dpd-uk');
    expect(carrierIdFromName('DHL Parcel Netherlands')).toBe('dhl-ecommerce-nl');
    expect(carrierIdFromName('DHL Parcel Spain')).toBe('dhl-ecommerce-es');
    expect(carrierIdFromName('DHL Parcel UK')).toBe('dhl-ecommerce-uk');
    expect(carrierIdFromName('DHL Parcel Poland')).toBe('dhl-ecommerce-pl');
    // 17TRACK names DHL's Polish parcel network with the country code in brackets.
    expect(carrierIdFromName('DHL Parcel (PL)')).toBe('dhl-ecommerce-pl');
    expect(carrierIdFromName('GLS Italy')).toBe('gls-it');
    expect(carrierIdFromName('GLS Poland')).toBe('gls-pl');
    expect(carrierIdFromName('Correos Chile')).toBe('correos-chile');
    // DPD Portugal took over Chronopost Portugal's network.
    expect(carrierIdFromName('Chronopost Portugal')).toBe('dpd-pt');
    for (const name of ['GLS Hungary', 'DHL Parcel Italy', 'DPD Group']) expect(carrierIdFromName(name)).toBeUndefined();
  });

  it('lists the zones of a bare brand only when all of its carriers keep a local clock', () => {
    // ParcelsApp reads brand-only scans in these zones. A catalog change here moves
    // stored scan instants, and so event ids: plan a re-key before updating the sets.
    // London never shares the others' clock, so DPD's brand zone stays off whatever networks join.
    expect(new Set(brandTimeZones('DPD Group'))).toEqual(new Set(['Europe/Zurich', 'Europe/Paris', 'Europe/Berlin', 'Europe/Warsaw', 'Europe/London', 'Europe/Dublin', 'Africa/Johannesburg', 'Europe/Brussels', 'Europe/Amsterdam', 'Europe/Lisbon', 'Europe/Vienna', 'Europe/Bucharest', 'Europe/Budapest']));
    expect(new Set(brandTimeZones('dpd'))).toEqual(new Set(['Europe/Zurich', 'Europe/Paris', 'Europe/Berlin', 'Europe/Warsaw', 'Europe/London', 'Europe/Dublin', 'Africa/Johannesburg', 'Europe/Brussels', 'Europe/Amsterdam', 'Europe/Lisbon', 'Europe/Vienna', 'Europe/Bucharest', 'Europe/Budapest']));
    // GLS Italy, Spain, Poland and Austria keep the same clock as the other networks, so GLS scans keep their
    // instants. Hermes Austria keeps Hermes Germany's clock too.
    expect(new Set(brandTimeZones('GLS'))).toEqual(new Set(['Europe/Zurich', 'Europe/Berlin', 'Europe/Paris', 'Europe/Rome', 'Europe/Madrid', 'Europe/Warsaw', 'Europe/Vienna']));
    expect(brandTimeZones('Hermes')).toEqual(['Europe/Berlin', 'Europe/Vienna']);
    // DHL eCommerce is UTC, so the brand's clock is unknown.
    for (const name of ['DHL', 'DHL Group', 'DPD Local', 'DPD UK', 'Post', 'Example Parcel Co']) expect(brandTimeZones(name)).toEqual([]);
  });
});

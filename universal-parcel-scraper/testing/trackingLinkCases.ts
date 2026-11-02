import type { CarrierId } from '../generated/catalog.js';

export interface TrackingLinkCase {
  carrier: CarrierId;
  provider?: string;
  /** Synthetic and validly shaped; never a real parcel. */
  number: string;
  /** Final address after redirects. */
  route: RegExp;
  /** Wording only the carrier's tracker shows. */
  marker: RegExp;
  /** An observed shipment-absence response on the working tracker route. */
  shipmentNotFound?: { status: 404 | 410; marker: RegExp };
  /** A visible tracker rendered inside an open shadow root. */
  shadowHost?: string;
  /** Extra hydration time for a tracker whose form loads in a separate client chunk. */
  renderTimeoutMs?: number;
  /**
   * How the page proves it received the number. By default the number must be
   * looked up, displayed or prefilled. `notFound` is the carrier's specific
   * answer to an unknown number when that answer clears the number from the
   * page; `none` marks a link that carries no number or one the site ignores.
   */
  forwarding?: { notFound: RegExp } | 'none';
}

// Rendered pages behind the links the UI shows, checked daily by
// trackingLinks.live.test.ts. Routes and markers were read from the live pages,
// independently of the generated link templates, so a template that drifts
// fails here instead of passing against itself.
export const trackingLinkCases: TrackingLinkCase[] = [
  { carrier: 'rex-indonesia', number: '22201740631928',
    route: /^https:\/\/www\.rex\.co\.id\/id\/tracking\/\?airwaybill=22201740631928$/,
    marker: /Data Not Found for Konosemen Number|No Konosemen/ },
  { carrier: 'linear-logistics', number: '7096137284',
    route: /^https:\/\/linearlogistics\.co\.uk\/tracking\?q=7096137284$/,
    marker: /Enter your tracking number:/ },
  { carrier: 'shipglobal-in', number: 'SG32606018374621',
    route: /^https:\/\/shipglobal\.in\/tracking\/\?awb=SG32606018374621$/,
    marker: /OrderId not found/ },
  { carrier: 'pflogistics', number: 'NEXAU1000000025YQ',
    route: /^https:\/\/pflogistics\.com\.au\/tracking-result\?tracking=NEXAU1000000025YQ$/,
    marker: /We couldn't find your tracking number|Tracking Number/ },
  { carrier: 'taqbin-hk', number: '179100000003',
    route: /^https:\/\/delivery\.message\.sg\/YTHKtracking\/\?a=179100000003$/,
    marker: /Track Items|Tracking number/i },
  { carrier: 'europochta', number: 'BY080731593842',
    route: /^https:\/\/evropochta\.by\/\?number=BY080731593842$/,
    marker: /Отслеживание|Отследить/ },
  { carrier: 'ozon-logistics', number: '48271635-2048-9',
    route: /^https:\/\/tracking\.ozon\.ru\/(?:\?|$)/,
    marker: /Проверка статуса вашей доставки/, renderTimeoutMs: 20_000 },
  { carrier: 'trendyol-express', number: '7330123456789000',
    route: /^https:\/\/kargotakip\.trendyol\.com\//,
    marker: /Sonuç Bulunamadı/, renderTimeoutMs: 20_000 },
  { carrier: 'anteraja', number: '10000000000001',
    route: /^https:\/\/anteraja\.id\/id\/tracking\/10000000000001$/,
    marker: /Cek Resi Paketmu|Lacak Pengirimanmu/i },
  { carrier: 'dhl-express', number: '9876000046',
    route: /^https:\/\/mydhl\.express\.dhl\/gb\/en\/tracking\.html/,
    marker: /Tracking Results|No result found for your DHL query|Not found/i, renderTimeoutMs: 20_000 },
  { carrier: 'coordinadora', number: '12300000033',
    route: /^https:\/\/rastreo\.coordinadora\.com\/\?guia=12300000033$/,
    marker: /Rastrea tu env[ií]o|No se encontr[óo]\s+la gu[ií]a consultada/i },
  { carrier: 'mrw', number: '99000Z000001',
    route: /^https:\/\/www\.mrw\.es\/seguimiento(?:\/|$)/,
    marker: /Seguimiento de envíos|Seguimiento de envios|Número de envío|Nº de envío/i,
    forwarding: 'none' },
  { carrier: 'parcelforce', number: 'CP000000005GB',
    route: /^https:\/\/www\.royalmail\.com\/track-your-item(?:#|$)/,
    marker: /Track your item|Tracking number|Enter your.*number/i, renderTimeoutMs: 20_000 },
  { carrier: 'the-courier-guy', number: 'TESTA1',
    route: /^https:\/\/portal\.thecourierguy\.co\.za\/track/,
    marker: /Track your parcel|Waybill not found|Enter tracking reference/i },
  { carrier: 'the-courier-guy', number: 'LD-000001',
    route: /^https:\/\/portal\.thecourierguy\.co\.za\/track/,
    marker: /Track your parcel|Waybill not found|Enter tracking reference/i },
  { carrier: 'internet-express', number: 'ZZ0000000001',
    route: /^https:\/\/portal\.internetexpress\.co\.za\/track/,
    marker: /Track your parcel|Could not find shipment or parcel|Enter your tracking reference/i },
  { carrier: 'bring-posten', number: 'RR000000005NO',
    route: /^https:\/\/sporing\.bring\.no\/sporing\//,
    marker: /Track.*item|Tracking number|didn.t find a shipment|Sporingsnummer|Spor pakken|vi fant ingen sending/i,
    shipmentNotFound: { status: 404, marker: /Sorry, we didn.t find a shipment associated with RR000000005NO/ } },
  { carrier: 'estafeta', number: '9000000001',
    route: /^https:\/\/cs\.estafeta\.com\/es\/Tracking\/searchByGet/,
    marker: /Código de rastreo|Número de guía|no se encontró información|Rastrear Envío/i,
    forwarding: { notFound: /Lo sentimos, no se encontró información/i } },
  { carrier: 'estafeta', number: '900000000001A000000002',
    route: /^https:\/\/cs\.estafeta\.com\/es\/Tracking\/searchByGet/,
    marker: /Código de rastreo|Número de guía|no se encontró información|Rastrear Envío/i,
    forwarding: { notFound: /Lo sentimos, no se encontró información/i } },
  // The page looks the number up on load and clears it when Paquetexpress does not know it.
  { carrier: 'paquetexpress', number: '999999999999',
    route: /^https:\/\/www\.paquetexpress\.com\.mx\/rastreo\/999999999999$/,
    marker: /Oops! Wrong tracking number, please check your info and try again\./,
    forwarding: { notFound: /Oops! Wrong tracking number, please check your info and try again\./ } },
  { carrier: 'nacex', number: '9900/99000002',
    route: /^https:\/\/www\.nacex\.es\/seguimientoFormularioExterno\.do(?:\?|$)/,
    marker: /Formulario de Seguimiento|Formulaire de Suivi|Track and trace form/,
    forwarding: { notFound: /No existe ningún albarán introducido en el sistema cumpliendo los criterios especificados|Il n.y a aucun bordereau introduit dans le système correspondant aux critères indiqués|There are no delivery notes entered into the system that comply with the specified criteria/ } },
  // The server renders the lookup; its answer to an unknown number repeats the number.
  { carrier: 'redur', number: '10000000000000',
    route: /^https:\/\/redur\.es\/track-trace\/\?idioma=es&buscarpor=NTRACKING&valor=10000000000000$/,
    marker: /Seguimiento de envío|Nº de envío/ },
  // The page prefills its search field from the address and looks the number up.
  { carrier: 'vasp-expresso', number: '9990000000000',
    route: /^https:\/\/www\.vaspexpresso\.pt\/pt\/geral\/track-and-trace\/\?search=9990000000000$/,
    marker: /Encontre a sua encomenda|Localizar Encomenda/ },
  { carrier: 'seur', number: '9900002',
    route: /^https:\/\/www\.seur\.com\/miseur\/mis-envios(?:\?|$)/,
    marker: /Seguimiento de envíos|Mis envíos|localizador|shipment|IDENTIFIER|Tracking|NÚMERO DE ENVÍO/i, renderTimeoutMs: 20_000 },
  { carrier: 'brt', number: '99000000000002',
    route: /^https:\/\/vas\.brt\.it\/vas\/sped_det_new\.htm(?:\?|$)/,
    marker: /Errori riscontrati|BRTcode|Parcel Label number .* not found/i },
  { carrier: 'ukrposhta', number: 'EE000000005UA',
    route: /^https:\/\/track\.ukrposhta\.ua\/en\//,
    marker: /Track.*parcel|Tracking|Shipment not found|barcode/i, renderTimeoutMs: 20_000 },
  { carrier: 'landmark-global', number: 'LTN000000009',
    route: /^https:\/\/track\.landmarkglobal\.com\//,
    marker: /Track your shipment|couldn't find a match/i },
  { carrier: 'gofo', number: 'GFUS00000000000000',
    route: /^https:\/\/www\.gofo\.com\/us\/track/,
    marker: /Track Your Package|Enter your Tracking Number/i },
  { carrier: 'gofo-ca', number: 'GFCA00000000000001',
    route: /^https:\/\/www\.gofo\.com\/ca\/track/,
    marker: /Track Your Package|Enter your Tracking Number/i },
  { carrier: 'gofo-fr', number: 'GFFR00000000000001',
    route: /^https:\/\/www\.gofo\.com\/fr\/tracking-results\//,
    marker: /Entrez votre numéro de suivi/i },
  { carrier: 'gofo-it', number: 'GFIT00000000000001',
    route: /^https:\/\/www\.gofo\.com\/it\/tracking-results\//,
    marker: /Inserisci il Numero di Tracciamento/i },
  { carrier: 'gofo-nl', number: 'GFNL00000000000001',
    route: /^https:\/\/www\.gofo\.com\/nl\/tracking-results\//,
    marker: /Voer Uw Trackingnummer In/i },
  { carrier: 'gofo-es', number: 'GFES00000000000001',
    route: /^https:\/\/www\.gofo\.com\/es\/tracking-results\//,
    marker: /Introduce tu N[uú]mero de Seguimiento/i },
  { carrier: 'omgo', number: 'OMGO0000000000001',
    route: /^https:\/\/omgoexpress\.cn\/track-package\//,
    marker: /Track Your Package|Enter tracking number\(s\)/i, forwarding: 'none' },
  // The tracker reads numbers from its form only.
  { carrier: 'topyou', number: 'TYZRZ0000000009YQ',
    route: /^https:\/\/track\.szty56\.com\//,
    marker: /通邮集团|查\s*询/, forwarding: 'none' },
  { carrier: 'ecoscooting', number: '000000000000000000',
    route: /^https:\/\/ecoscooting\.com\/tracking\//,
    marker: /Enter tracking number|No data found/i },
  { carrier: 'ecoscooting', number: 'CNPRT00000000000000000001',
    route: /^https:\/\/ecoscooting\.com\/tracking\//,
    marker: /Enter tracking number|No data found/i },
  { carrier: 'canpar', number: 'C000000000000000000001',
    route: /^https:\/\/www\.canpar\.com\/en\/tracking\/track\.htm/,
    marker: /Track.*package|Package tracking|Track.*shipment|Enter.*barcode/i },
  { carrier: 'ninja-van', number: 'NLMYA00000000',
    route: /^https:\/\/www\.ninjavan\.co\/en-my\/tracking(?:\?|$)/,
    marker: /Track and trace your parcel|Enter parcel tracking ID|Track parcel/i },
  { carrier: 'ninja-van', number: 'NLIDA00000000',
    route: /^https:\/\/www\.ninjaxpress\.co\/en-id\/tracking(?:\?|$)/,
    marker: /Track and trace your parcel|Enter parcel tracking ID|Track parcel/i },
  { carrier: 'correos-chile', number: 'SX000000005CL',
    route: /^https:\/\/www\.correos\.cl\/seguimiento-en-linea(?:\?|$)/,
    marker: /Seguimiento en línea|Envíos y Seguimiento de Paquetes/i,
    forwarding: 'none' },
  // The help centre signs the visitor in and looks the number up; it opens the order on /seguimiento,
  // or returns to its home and tracking form for an order it does not know.
  { carrier: 'chilexpress', number: '9900000000',
    route: /^https:\/\/centrodeayuda\.chilexpress\.cl\/(?:pre-seguimiento\/9900000000|seguimiento|home)$/,
    marker: /Rastrea tu envío/i },
  { carrier: 'correos-express', number: '9900000000000002',
    route: /^https:\/\/s\.correosexpress\.com\//,
    marker: /Localiza tu envío|Sigue tu envío/i, forwarding: 'none' },
  { carrier: 'nz-post', number: '00000000000000000001',
    route: /^https:\/\/www\.nzpost\.co\.nz\/tools\/tracking/,
    marker: /Tracking number|Track.*parcel|Tracking reference/i },
  { carrier: 'nz-couriers', number: '00000000000000000000',
    route: /^https:\/\/nzcouriers\.co\.nz\/(?:track\/\?query=00000000000000000000|tools\/track-a-parcel\/\?redirect=true)$/,
    marker: /Track your item using its label number|Please use our Advanced Tracking below/i,
    forwarding: { notFound: /Please use our Advanced Tracking below/i } },
  // An unknown number leaves the tracking page for the site search, which prefills it.
  { carrier: 'post-haste', number: '00000000000000000000',
    route: /^https:\/\/posthaste\.co\.nz\/(?:track\/\?query=00000000000000000000|\?s=00000000000000000000&track=true)$/,
    marker: /Parcel Tracking History|Use Advanced Tracking for detailed tracking options/i },
  // The receiver page looks the number in its address up and says when it finds no match.
  { carrier: 'castle-parcels', number: '00000000000000000000',
    route: /^https:\/\/receiver\.castleparcels\.co\.nz\/\?track=00000000000000000000$/,
    marker: /We cannot find a match for the tracking ID entered|Tracking ID can contain both letters/i },
  { carrier: 'now-couriers', number: '00000000000000000000',
    route: /^https:\/\/receiver\.nowcouriers\.co\.nz\/\?track=00000000000000000000$/,
    marker: /We cannot find a match for the tracking ID entered|Tracking ID can contain both letters/i },
  { carrier: 'poczta-polska', number: '00000000000000000001',
    route: /^https:\/\/emonitoring\.poczta-polska\.pl\//,
    marker: /Tracking|Enter.*number|Search/i },
  { carrier: 'ctt-express', number: '0000000000000000000001',
    route: /^https:\/\/shipping-tracking\.production\.cloud2\.cttexpress\.com\//,
    marker: /Número de seguimiento|No hemos localizado el número de envío/i },
  // An unknown reference refreshes to the not-located page after 10 s.
  { carrier: 'tipsa', number: '0990010990010000000017',
    route: /^https:\/\/aplicaciones\.tip-sa\.com\/cliente\/(?:datos_env\.php\?|error_env\.html$)/,
    marker: /ENVIO NO LOCALIZADO/i, renderTimeoutMs: 20_000,
    forwarding: { notFound: /ENVIO NO LOCALIZADO/i } },
  { carrier: 'uniuni', number: 'UUS0000000000000000',
    route: /^https:\/\/www\.uniuni\.com\/tracking\//,
    marker: /Track your UniUni Package/i },
  { carrier: 'uniuni', number: 'UUSC000000000001',
    route: /^https:\/\/www\.uniuni\.com\/tracking\//,
    marker: /Track your UniUni Package/i },
  // The tracker sends an unknown number back to its search page, which says so in a passing notice.
  { carrier: 'sp-express', number: '000000000000000',
    route: /^https:\/\/en\.sp\.express\/tt$/,
    marker: /Track&trace|ID shipment/,
    forwarding: { notFound: /Shipping not find the specified ID/ } },
  { carrier: 'speedx', number: 'SPXLAX000000000000000001',
    route: /^https:\/\/tracking\.speedx\.io\/SPXLAX000000000000000001$/,
    marker: /No tracking information for/i },
  { carrier: 'bpost', number: '000000000000000000000001',
    route: /^https:\/\/track\.bpost\.cloud\//,
    marker: /Track|barcode|postcode|postal code|Suivi|Code-barres/i, forwarding: 'none' },
  { carrier: 'purolator', number: '100000000001',
    route: /^https:\/\/www\.purolator\.com\/en\/shipping\/tracker/,
    marker: /Track.*shipment|Tracking|Tracking number/i },
  { carrier: 'yto', number: 'YT0000000000001',
    route: /^https:\/\/www\.yto\.net\.cn\/ytoExpress\/waybill\/search/,
    marker: /运单|快递|Waybill|Tracking/i, forwarding: 'none' },
  { carrier: 'sto', number: '777000000000001',
    route: /^https:\/\/www\.sto\.cn\//,
    marker: /运单|单号|查询/i, forwarding: 'none' },
  { carrier: 'correios-br', number: 'AA000000005BR',
    route: /^https:\/\/rastreamento\.correios\.com\.br\/app\/index\.php/,
    marker: /Rastreamento|Objeto|Código|Captcha/i },
  // The page stays blank until its script bundles arrive from China: often 20 s, sometimes over 40 s.
  { carrier: 'yunda', number: '0000000000001',
    route: /^https:\/\/web\.yundaex\.com\/infoInquiry/,
    marker: /快件查询|请输入运单号/i, renderTimeoutMs: 60_000 },
  { carrier: 'postnord', number: 'RR000000005SE',
    route: /^https:\/\/tracking\.postnord\.com\/en\//,
    marker: /Track.*shipment|Tracking|shipment.*found/i, shadowHost: 'pn-widget' },
  { carrier: 'yunexpress', number: 'YT0000000000000001',
    route: /^https:\/\/www\.yuntrack\.com\/parcelTracking\?id=/,
    marker: /Tracking|Track.*parcel|Tracking Number/i },
  { carrier: 'austrian-post', number: '1000000000000000000001',
    route: /^https:\/\/www\.post\.at\/en\/s\/track-and-trace-search/,
    marker: /Track.*Trace|Track a shipment|Shipment tracking|tracking number/i, forwarding: 'none' },
  { carrier: 'tnt', number: '123456784',
    route: /^https:\/\/www\.tnt\.com\/express\/en_gb\/site\/shipping-tools\/tracking\.html\?/,
    marker: /Track your shipment|Consignment note/i },
  { carrier: 'tnt-it', number: 'ZZ00000000',
    route: /^https:\/\/www\.tnt\.it\/tracking\/index\.html\?pp=/,
    marker: /Spedizione non trovata|Lettera di vettura/i },
  { carrier: 'ontrac', number: '1LS0000000000001',
    route: /^https:\/\/www\.ontrac\.com\/tracking\//,
    marker: /Track.*package|Tracking|tracking number/i },
  { carrier: 'blue-dart', number: '00000000001',
    route: /^https:\/\/www\.bluedart\.com\/trackdartresultthirdparty/,
    marker: /TrackDart|Tracking Details/i,
    forwarding: { notFound: /There is no information on the Waybill\/Reference Number\/Order Number currently/i } },
  { carrier: 'delhivery', number: '0000000000001',
    route: /^https:\/\/www\.delhivery\.com\/tracking/,
    marker: /Track Order|AWB|Track your shipment/i, forwarding: 'none' },
  { carrier: 'aramex', number: '999999999999',
    route: /^https:\/\/www\.aramex\.com\/us\/en\/track\/shipments/,
    marker: /Track|tracking number/i,
    forwarding: { notFound: /No results found with current selection/i } },
  { carrier: 'four-px', number: '4PX0000000000001CN',
    route: /^https:\/\/track\.4px\.com\//,
    marker: /Track|Tracking|tracking number/i },
  { carrier: 'singapore-post', number: 'RR000000005SG',
    route: /^https:\/\/www\.singpost\.com\/track-items/,
    marker: /Track.*items|Track.*shipment|Tracking Number/i },
  { carrier: 'hongkong-post', number: 'RR000000005HK',
    route: /^https:\/\/webapp\.hongkongpost\.hk\/en\/mail_tracking2\/index\.html/,
    marker: /Track and Trace|Enter The Tracking Number|Recently tracked items/i,
    forwarding: 'none' },
  // The page renders the lookup's reply for the number in its address, with the number over it.
  { carrier: 'jersey-post', number: 'LX000000005JE',
    route: /^https:\/\/www\.jerseypost\.com\/tools\/track-trace\/\?tq=LX000000005JE$/,
    marker: /No tracking information available/ },
  // The server renders the lookup; its answer to an unknown number keeps the number in the search field.
  { carrier: 'chunil', number: '99999999999',
    route: /^https:\/\/www\.chunil\.co\.kr\/HTrace\/HTrace\.jsp\?transNo=99999999999$/,
    marker: /운송장 조회/ },
  // The page puts the number from its address in its search field and looks it up on load; an unknown one gets a notice.
  { carrier: 'kunyoung', number: '0000000000',
    route: /^https:\/\/mj\.kunyoung\.com\/\?invoiceNumber=0000000000$/,
    marker: /택배조회|운송장이 등록되지 않았거나/ },
  { carrier: 'korea-post', number: 'EE000000005KR',
    route: /^https:\/\/trace\.epost\.go\.kr\/xtts\//,
    marker: /Track.*Trace|Tracking|Item Number|Delivery Status/i },
  // The server renders the lookup; its answer to an unknown number does not show the number.
  { carrier: 'logen', number: '40000000003',
    route: /^https:\/\/www\.ilogen\.com\/web\/personal\/trace\/40000000003$/,
    marker: /운송장 번호로 조회|배송조회/,
    forwarding: { notFound: /배송자료를 조회할 수 없습니다/ } },
  // The server renders the lookup; its answer to an unknown number repeats the number.
  { carrier: 'seino', number: '0000000000',
    route: /^https:\/\/track\.seino\.co\.jp\/cgi-bin\/gnpquery\.pgm\?GNPNO1=0000000000$/,
    marker: /入力されたお問合せ番号が見当りません/ },
  { carrier: 'yamato', number: '123456789012',
    route: /^https:\/\/toi\.kuronekoyamato\.co\.jp\/cgi-bin\/tneko/,
    marker: /荷物お問い合わせ|送り状番号|Tracking/i, forwarding: 'none' },
  // The list names the number it was asked, also when it holds no shipment under it.
  { carrier: 'nippon-express', number: '100000000004',
    route: /^https:\/\/lp-trace\.nittsu\.co\.jp\/web\/webarpaa702\.srv\?LANG=JP&denpyoNo1=100000000004$/,
    marker: /航空便の配達状況確認|お問い合せ伝票番号/ },
  { carrier: 'yanwen', number: 'UK000000005YP',
    route: /^https:\/\/track\.yw56\.com\.cn\/en\/index/,
    marker: /Tracking|Tracking number|Track/i, forwarding: 'none' },
  { carrier: 'far-international', number: 'FARAA0000000001YQ',
    route: /^https:\/\/www\.far800\.com\/logistics\/result\?key=FARAA0000000001YQ$/,
    marker: /泛远国际/, forwarding: { notFound: /暂无内容/ } },
  { carrier: 'ywe', number: 'YWE00000000000001',
    route: /^https:\/\/www\.yanwenexpress\.com\/tracking\.html\?label=YWE00000000000001$/,
    marker: /YanwenExpress|parcel tracking number/i },
  { carrier: 'sf-express', number: 'SF0000000000001',
    route: /^https:\/\/htm\.sf-express\.com\/tw\/en\/dynamic_function\/waybill\/#search\/bill-number\//,
    marker: /Track.*Trace|Shipment|Waybill/i },
  { carrier: 'swiss-post', number: '989999999999999999',
    route: /^https:\/\/service\.post\.ch\/ekp-web\/ui\//,
    marker: /Meine Sendungen|My consignments|Mes envois|Sendungsnummer/ },
  { carrier: 'postlogistics', number: '000000000000000000',
    route: /^https:\/\/apv\.swisspost-cargo\.com\/public\/trackandtrace\//,
    marker: /Sendungsnummer\/Referenz|Keine Daten gefunden|TRACK&TRACE/i },
  { carrier: 'swiss-post-cargo', number: 'CODEXINVALID20260831',
    route: /^https:\/\/apv\.swisspost-cargo\.com\/public\/trackandtrace\//,
    marker: /Sendungsnummer\/Referenz|Keine Daten gefunden|TRACK&TRACE/i },
  { carrier: 'quickpac', number: '440000000000000001',
    route: /^https:\/\/tracking\.app\.planzer\.ch\/delivery\/info\?/,
    marker: /Mes envois|Meine Sendungen|My shipments|aucune information|keine Informationen/i },
  { carrier: 'la-poste', number: 'AB12345678901',
    route: /^https:\/\/www\.laposte\.fr\/outils\/suivre-vos-envois(?:\?|$)/,
    marker: /suivre une lettre ou un colis|suivre un envoi|suivi de votre|numéro de suivi/i },
  { carrier: 'chronopost', number: 'XY000000005FR',
    route: /^https:\/\/www\.chronopost\.fr\/tracking-no-cms\/suivi-page\?/,
    marker: /Suivez votre colis|Informations concernant votre envoi/i },
  // The UK site's tracker opens in every country; happy-post.com sends visitors abroad to UK addresses that lose the parcel.
  { carrier: 'happy-post', number: '99999990',
    route: /^https:\/\/uk\.happy-post\.com\/track\/\?id=99999990$/,
    marker: /Real-time parcel tracking|This number does not match any parcel/ },
  { carrier: 'dpd', number: '09999999999999',
    route: /^https:\/\/www\.dpdgroup\.com\/ch\/mydpd\/my-parcels\/incoming\?/,
    marker: /parcel number|Paketnummer|numéro de colis|my parcels/i,
    // The server-rendered unknown-number view deliberately clears the input.
    forwarding: { notFound: /The parcel you have chosen has not been assigned to your account/ } },
  // Cloudflare challenges automated browsers; kept so the gap stays visible.
  { carrier: 'dpd-fr', number: '000000000000',
    route: /^https:\/\/trace\.dpd\.fr\/fr\/trace\//,
    marker: /suivi|colis|parcel/i },
  { carrier: 'unknown', number: 'ZZ000000000ZZ',
    route: /^https:\/\/t\.17track\.net\/en(?:[?#]|$)/,
    marker: /TRACK|SUIVRE|Tracking Information/ },
  { carrier: 'dhl', number: '00340439999999999999',
    route: /^https:\/\/www\.dhl\.de\/en\/privatkunden\/dhl-sendungsverfolgung\.html\?/,
    marker: /shipment number|track shipment/i },
  { carrier: 'dhl-ecommerce-nl', number: 'JVGL09999999000000000000',
    route: /^https:\/\/my\.dhlecommerce\.nl\/home\/tracktrace\/JVGL09999999000000000000/,
    marker: /Track & Trace|track your parcel|parcel/i },
  { carrier: 'dhl-ecommerce-uk', number: '99990000000000',
    route: /^https:\/\/track\.dhlecommerce\.co\.uk\/\?con=99990000000000/,
    marker: /track another parcel|shipment number/i },
  { carrier: 'dhl-ecommerce-es', number: '2800000007',
    route: /^https:\/\/clientesparcel\.dhl\.es\/LiveTracking\//,
    marker: /shipment|tracking|env[ií]o/i },
  { carrier: 'dhl-ecommerce-pl', number: '29999999990',
    // The portal moves an unknown number from /tracking to its search form.
    route: /^https:\/\/mojdhl\.pl\/(?:tracking\?paczki=29999999990|sprawdz)/,
    marker: /parcel|shipment|przesy[łl]k/i },
  { carrier: 'dhl-freight', number: '00000000000',
    route: /^https:\/\/activetracing\.dhl\.com\/DatPublic\/datSelection\.do\?/,
    marker: /DHL ACTIVETRACING|existiert keine Sendung|no consignment matching/i },
  { carrier: 'dhl-ecommerce', number: 'GM0000000000000000',
    route: /^https:\/\/www\.dhl\.com\/ch-en\/home\/tracking\.html\?/,
    marker: /tracking number|track your shipment/i },
  { carrier: 'mondial-relay', number: '00000000',
    route: /^https:\/\/www\.mondialrelay\.fr\/suivi-de-colis\//,
    marker: /suivi de colis|numéro de colis/i },
  { carrier: 'mondial-relay', provider: 'ParcelsApp', number: '00000000',
    route: /^https:\/\/parcelsapp\.com\/en\/tracking\//,
    marker: /tracking number|track package|tracking information/i },
  { carrier: 'relais-colis', number: '0000000000',
    route: /^https:\/\/relaiscolis\.com\/colis\/suivre\?/,
    marker: /Suivre mon colis/i },
  { carrier: 'gls-ch', number: '88888888888',
    route: /^https:\/\/gls-group\.eu\/GROUP\/en\/parcel-tracking\?/,
    marker: /Parcel tracking|Track your parcel/i },
  // moncolis.gls-france.com now forwards to the group tracker.
  { carrier: 'gls-fr', number: '00ZZ00Z0',
    route: /^https:\/\/(?:moncolis\.gls-france\.com\/|gls-group\.eu\/GROUP\/[a-z]{2}\/parcel-tracking\?)/,
    marker: /Parcel tracking|Track your parcel|Suivi/i },
  { carrier: 'gls-de', number: '00000000000',
    route: /^https:\/\/gls-group\.eu\/EU\/en\/parcel-tracking\?/,
    marker: /Parcel tracking|Track your parcel/i },
  // The national search type: without it the page searches with an empty type, which fails.
  { carrier: 'gls-it', number: 'ZZ999999999',
    route: /^https:\/\/gls-group\.com\/IT\/it\/servizi-online\/ricerca-spedizioni\/\?/,
    marker: /Ricerca spedizion|Non sono stati trovati risultati/i },
  // The form asks for the delivery postcode too, so the link carries no number.
  { carrier: 'gls-es', number: '1000000001',
    route: /^https:\/\/gls-group\.com\/ES\/es\/recibir-paquetes\/seguimiento-envio\/(?:\?|$)/,
    marker: /Realiza el seguimiento de tu envío|código postal de destino/i, forwarding: 'none' },
  { carrier: 'ups', number: '1Z0000000000000000',
    route: /^https:\/\/(?:www\.)?ups\.com\/track(?:[/?]|$)/,
    marker: /tracking number|numéro de suivi|track a package/i },
  { carrier: 'fedex', number: '999999999999',
    route: /^https:\/\/www\.fedex\.com\/(?:fedextrack|wtrk\/track)\//,
    marker: /FedEx ® Tracking|Track Another Shipment|can.t find that tracking number/i },
  { carrier: 'amazon-shipping', number: 'FR0000000000',
    route: /^https:\/\/track\.amazon\.fr\/tracking\//,
    marker: /Numéro de suivi|Tracking number|Suivre un colis/i },
  // Amazon Logistics parcels are tracked from the signed-in order history.
  { carrier: 'amazon-logistics', number: 'TBA000000000000',
    route: /^https:\/\/www\.amazon\.com\/(?:ap\/signin|gp\/your-account\/order-history|your-orders)/,
    marker: /Sign in|Your Orders/i, forwarding: 'none' },
  { carrier: 'geodis', number: '1G0000000000',
    route: /^https:\/\/espace-client\.geodis\.com\/services\/destinataires\//,
    marker: /Suivre mon envoi|Numéro de suivi/i },
  { carrier: 'geodis-pl', number: 'PL9999999999999999',
    route: /^https:\/\/strefaklienta\.pekaes\.geodis\.pl\/en\/\?ShNumber=PL9999999999999999$/,
    marker: /Shipment with such number does not exist/ },
  // Colisweb ignores ?value= since its search became an in-page request.
  { carrier: 'colisweb', number: '99999999',
    route: /^https:\/\/www\.colisweb\.com\/suivi-livraison/,
    marker: /Suivi de votre livraison|Suivre ma livraison/i, forwarding: 'none' },
  { carrier: 'c-chez-vous', number: 'ZZZZ00000Z',
    route: /^https:\/\/www\.cchezvous\.fr\/suivi-colis/,
    marker: /Suivre ma livraison/i,
    forwarding: { notFound: /La commande est introuvable/ } },
  { carrier: 'heppner', number: '00000000',
    route: /^https:\/\/www\.heppner-group\.com\/(?:en\/consignee-track-your-order|destinataire-suivez-votre-marchandise)\//,
    marker: /track your order|suivez votre marchandise/i, forwarding: 'none' },
  { carrier: 'ciblex', number: '12345678901234',
    route: /^https:\/\/secure\.extranet\.ciblex\.fr\/extranet\/client\/corps\.php\?/,
    marker: /SUIVI DE VOS COLIS|SUIVI COLIS/i },
  { carrier: 'ciblex', number: '000000000000000000000001',
    route: /^https:\/\/secure\.extranet\.ciblex\.fr\/extranet\/client\/corps\.php\?/,
    marker: /SUIVI DE VOS COLIS|SUIVI COLIS/i },
  // The tracker is moving to paack.co/shipments, and the old host forwards some visits there.
  { carrier: 'paack', number: 'EXCHANGE000001D',
    route: /^https:\/\/(?:mydeliveries\.paack\.app|paack\.co\/shipments)\/tracking\?/,
    marker: /Track your order|Track My Order|Order number/i },
  { carrier: 'asendia', number: 'ASE00000000',
    route: /^https:\/\/track\.asendia\.com\/track\//,
    marker: /Tracking Portal|Track here/i },
  { carrier: 'hermes', number: '12345678',
    route: /^https:\/\/myhes\.de\//,
    marker: /Sendungsverfolgung/i, forwarding: 'none' },
  { carrier: 'hermes-de', number: '00000000000000',
    route: /^https:\/\/www\.myhermes\.de\/empfangen\/sendungsverfolgung\//,
    marker: /Sendungsverfolgung|Sendungsinformation/i },
  { carrier: 'hermes-at', number: '00000000000000',
    route: /^https:\/\/www\.myhermes\.at\/sendungsverfolgung\/trackingnummer\/00000000000000\/$/,
    marker: /Sendungsverfolgung/i },
  { carrier: 'inpost', number: '000000000000000000000000',
    route: /^https:\/\/inpost\.pl\/sledzenie-przesylek\?number=000000000000000000000000$/,
    marker: /Śledzenie paczki|Śledź paczkę|numery paczek/i },
  // InPost UK looks the number up only with a Turnstile token, which headless Chrome does not get.
  { carrier: 'inpost', number: '00ABC0000000A000',
    route: /^https:\/\/inpost\.co\.uk\/tracking\/result\?parcel_code=00ABC0000000A000$/,
    marker: /Track another parcel/i, forwarding: 'none' },
  { carrier: 'posti', number: 'CW000000000FR',
    route: /^https:\/\/www\.posti\.fi\/en\/tracking\//,
    marker: /Track item|Parcel tracking|Search by item ID/i },
  { carrier: 'packeta', number: 'Z0000000000',
    route: /^https:\/\/tracking\.packeta\.com\/en/,
    marker: /Parcel tracking/i,
    forwarding: { notFound: /The parcel with this number was not found/ } },
  { carrier: 'ctt', number: 'RL000000005PT',
    route: /^https:\/\/www\.ctt\.pt\/feapl_2\/app\/open\/objectSearch\/objectSearch\.jspx\?/,
    marker: /Seguir objeto/i },
  { carrier: 'correos-spain', number: 'PR000000000000000C',
    route: /^https:\/\/www\.correos\.es\/es\/es\/herramientas\/localizador\//,
    marker: /Localizador de envíos|No encontramos resultados/i },
  { carrier: 'canada-post', number: '0000000000000001',
    route: /^https:\/\/www\.canadapost-postescanada\.ca\/track-reperage\/en/,
    marker: /Track results|Track/ },
  { carrier: 'india-post', number: 'EE000000000IN',
    route: /^https:\/\/myspeedpost\.com\/track\?/,
    marker: /consignment|speed post tracking/i },
  { carrier: 'pos-malaysia', number: 'MYPM00000000099',
    route: /^https:\/\/tracking\.pos\.com\.my\/tracking\//,
    marker: /TRACK MY PARCEL|Parcel Tracking/i },
  { carrier: 'pos-indonesia', number: 'P2912310000000',
    route: /^https:\/\/www\.posindonesia\.co\.id\/id\/tracking\/P2912310000000$/,
    marker: /Lacak Keberadaan Paket/i },
  { carrier: 'sapx-express', number: 'CGK0000000000001',
    route: /^https:\/\/www\.sapx\.id\/id\/cek-awb\/CGK0000000000001$/,
    marker: /Cek Resi<\/strong> SAPX Express|Nomor Resi Anda Tidak Ditemukan/i,
    forwarding: { notFound: /Nomor Resi Anda Tidak Ditemukan/ } },
  { carrier: 'tiki', number: '000000000001',
    route: /^https:\/\/tiki\.id\/id\/track\/000000000001$/,
    marker: /Masukkan nomor resi|Lacak hingga 20 nomor resi/i },
  { carrier: 'spring-gds', number: 'LT000000000NL',
    route: /^https:\/\/postnl\.post\/track\?/,
    marker: /tracking numbers|track your parcels/i },
  { carrier: 'sunyou', number: 'SY00000000000',
    route: /^https:\/\/sypost\.net\/search\?/,
    marker: /Track Number|Not Found/ },
  { carrier: 'aliexpress', number: 'LP00000000000000',
    route: /^https:\/\/global\.cainiao\.com\/detail\.htm\?/,
    marker: /Track|Suivre/ },
  { carrier: 'ems', number: 'EB000000005CN',
    route: /^https:\/\/items\.ems\.post\/api\/publicTracking\/track\?/,
    marker: /Public Tracking|no results found/i },
  { carrier: 'japan-post', number: 'CN000000005JP',
    route: /^https:\/\/trackings\.post\.japanpost\.jp\/services\/srv\/search\/direct\?/,
    marker: /Track & Trace|Your item was not found/i },
  { carrier: 'australia-post', number: '7T0000000000000000001',
    route: /^https:\/\/auspost\.com\.au\/mypost\/track\/details\//,
    marker: /Australia Post|Track your item/i },
  { carrier: 'ekart', number: 'FMPP0000000001',
    route: /^https:\/\/ekartlogistics\.com\/ekartlogistics-web\/shipmenttrack\//,
    marker: /Track Your Order|No tracking data available for ID:/i },
  { carrier: 'xpressbees', number: '10000000000001',
    route: /^https:\/\/shipmentv2\.xpressbees\.com\/orders\/tracking\//,
    marker: /Enter an AWB number or Order ID to get live shipment updates|Tracking Error: Invalid Awb no/i },
  { carrier: 'nova-poshta', number: '59000000000001',
    route: /^https:\/\/novaposhta\.ua\/en\/tracking\/\d{14}\/?$/,
    marker: /Track your parcel|We have not found a parcel with this number/i },
  { carrier: 'spx-ph', number: 'PH000000000001',
    route: /^https:\/\/spx\.ph\/track\?/,
    marker: /Your search does not match any results/i },
  { carrier: 'spx-br', number: 'BR0000000000001',
    route: /^https:\/\/spx\.com\.br\/track\?/,
    marker: /Sua busca não gerou resultados|Your search does not match any results/i },
  { carrier: 'spx-id', number: 'SPXID000000000001',
    route: /^https:\/\/spx\.co\.id\/track\?/,
    marker: /Hasil pencarian anda tidak cocok dengan hasil apapun|Your search does not match any results/i },
  { carrier: 'spx-my', number: 'SPXMY000000000001',
    route: /^https:\/\/spx\.com\.my\/track\?/,
    marker: /Your search does not match any results/i },
  { carrier: 'spx-sg', number: 'SPXSG000000000001',
    route: /^https:\/\/spx\.sg\/track\?/,
    marker: /Your search does not match any results/i },
  { carrier: 'spx-th', number: 'SPXTH000000000001',
    route: /^https:\/\/spx\.co\.th\/track\?/,
    marker: /ไม่พบผลลัพท์ที่ตรงกับคำค้นหาของคุณ|Your search does not match any results/i },
  { carrier: 'spx-vn', number: 'SPXVN000000000001',
    route: /^https:\/\/spx\.vn\/track\?/,
    marker: /Không có kết quả phù hợp|Your search does not match any results/i },
  { carrier: 'speedpak', number: 'ES0000000000000UN0000000000N',
    route: /^https:\/\/www\.orangeconnex\.com\/tracking\/?$/,
    marker: /Shipment Tracking/i, forwarding: 'none' },
  { carrier: 'intelcom', number: 'INTLCM0000000000',
    route: /^https:\/\/dragonflyshipping\.ca\/en\/track-your-package\/(?:\?|$)/,
    marker: /The number you entered doesn't seem to match any of our current deliveries|Track another package/i,
    forwarding: { notFound: /The number you entered doesn't seem to match any of our current deliveries/i }, renderTimeoutMs: 20_000 },
  { carrier: 'jd-logistics', number: 'JD0000000000001',
    route: /^https:\/\/www\.jingdonglogistics\.com\/Tracking(?:\?|$)/,
    marker: /Track your shipment|Tracking your waybill/i },
  // The tracker looks the code up, then moves an unknown one to its own
  // not-found page, which no longer shows the number.
  { carrier: 'jitsu', number: 'ZZ00ZZ00ZZ00ZZ01',
    route: /^https:\/\/recipient\.gojitsu\.com\/(?:noredirect\/ZZ00ZZ00ZZ00ZZ01|404)$/,
    marker: /Sorry, tracking ID not found!/,
    forwarding: { notFound: /Sorry, tracking ID not found!/ } },
  // The tracking page writes `?nos=` into its query box as it serves the page.
  { carrier: 'jifan', number: 'JFGJ000000017CN',
    route: /^https:\/\/www\.szjf56\.cn\/index\/tracknumber\/track\?nos=JFGJ000000017CN$/,
    marker: /Powered By 吉凡物流|查询结果为2个月内的包裹/ },
  // An unknown invoice gets the bare search form.
  { carrier: 'fastbox', number: 'FB2610010000000017',
    route: /^https:\/\/fastbox\.co\.kr\/DHUB\/tracking\.php\?fb_invoice_no=FB2610010000000017$/,
    marker: /FB Invoice No\./ },
  // The page reads the number from its address into its search tags and looks it up on load.
  // The tracker looks the number up and lists it with its status.
  { carrier: 'jcex', number: 'JCZ9999999999DH',
    route: /^https:\/\/track\.jcex\.com\/\?nums=JCZ9999999999DH$/,
    marker: /查询不到|暂无轨迹详情|全部展开/ },
  // The page looks the number in its address up on load and answers an unknown one without it.
  { carrier: 'zto-international', number: '77100000000000',
    route: /^https:\/\/m\.ztoglobal\.com\/\?path=TrackDetails&inputNo=77100000000000&lang=en$/,
    marker: /No related tracking information|暂无相关运单信息|Waybill Number/ },
  { carrier: 'jumppoint', number: 'JP000000000000',
    route: /^https:\/\/tracking\.jumppoint\.io\/\?q=JP000000000000$/,
    marker: /Shipment Not Found|查無此單|查无此单|Jumppoint標準快遞 及 即日快遞|Jumppoint Standard Express and Same-day Express/ },
  // A hash-routed tracker: it lists an unknown number with its own notice.
  { carrier: 'ubi-smart-parcel', number: 'AU9999999999999',
    route: /^https:\/\/shipper\.ubismartparcel\.com\/#\/ubi\?trackingNos=AU9999999999999$/,
    marker: /UBI SmartParcel PACKAGE TRACKING|No event found/i },
  { carrier: 'dpd-de', number: '01000000000001',
    route: /^https:\/\/my\.dpd\.de\/myparcels\/dataprotection-tracking\.aspx(?:\?|$)/,
    marker: /Paketnummer|Leider können wir.*keine Daten zu Ihrem Paket/i },
  { carrier: 'dpd-uk', number: '00000000000001',
    route: /^https:\/\/track\.dpd\.co\.uk\/(?:\?|$)/,
    marker: /Enter the reference number and delivery postcode|Tracking Number, Calling card number/i },
  { carrier: 'dpd-pl', number: '9999999999999U',
    route: /^https:\/\/tracktrace\.dpd\.com\.pl\/EN\/parcelDetails\?/,
    marker: /There is no trace for this parcel|Parcel history/ },
  // The page frames the tracker app, which looks the waybill up from its address.
  { carrier: 'dpd-za', number: 'ZZ0000000001',
    route: /^https:\/\/www\.dpd\.com\/za\/en\/receiving-parcels\/track-my-parcel\/tracking-details\/\?ZZ0000000001$/,
    marker: /Track your parcel \/ Parcel Tracking/ },
  // The server-rendered page names the reference and its not-found notice repeats it.
  { carrier: 'dpd-pt', number: '09999999999999',
    route: /^https:\/\/tracking\.dpd\.pt\/\?reference=09999999999999$/,
    marker: /No results were found for 09999999999999|Não encontrámos resultados para 09999999999999/ },
  { carrier: 'fan-courier', number: '9999999999990',
    route: /^https:\/\/www\.fancourier\.ro\/awb-tracking\/\?tracking=/,
    marker: /AWB-ul nu a fost gasit|Detalii expediție/i },
  // A number the tracker does not know comes back with an empty field and its notice.
  // The page's styles show its heading in uppercase.
  { carrier: 'foxpost', number: 'CLFOX000000000000001',
    route: /^https:\/\/foxpost\.hu\/csomagkovetes\/\?/,
    marker: /Csomagkövetés/i,
    forwarding: { notFound: /A megadott csomag azonosító nem található a rendszerünkben/ } },
  // A number the legacy tracker does not know stays on the lookup page with its notice alone.
  { carrier: 'aras-kargo', number: '9900000000001',
    route: /^https:\/\/kargotakip\.araskargo\.com\.tr\/mainpage\.aspx\?code=9900000000001$/,
    marker: /Girdiğiniz bilgiler için bir sonuç bulunamamıştır/,
    forwarding: { notFound: /Girdiğiniz bilgiler için bir sonuç bulunamamıştır/ } },
  // The international tracker is a POST-only form, so the link cannot carry the number.
  { carrier: 'evri', number: 'H000000000000001',
    route: /^https:\/\/globaleco\.app\/track\/?$/,
    marker: /Search by tracking number/i, forwarding: 'none' },
  // The page fills its field in; a lookup waits for the visitor's Turnstile check.
  { carrier: 'emile', number: 'EM000000000001CA',
    route: /^https:\/\/www\.emileps\.com\/tracking\?/,
    marker: /Track Your\s+Shipment|Enter tracking number/i },
  // The page fills its field in; the lookup waits for the visitor's search.
  { carrier: 'ems-vietnam', number: 'EB000000076VN',
    route: /^https:\/\/ems\.com\.vn\/tra-cuu\/tra-cuu-buu-gui\?code=EB000000076VN$/,
    marker: /Tra cứu bưu gửi|Mã bưu gửi|Không tìm thấy kết quả/i },
  // The tracker reads the receipt from the fragment and looks it up on load.
  { carrier: 'energia-tk', number: '9999-0000001',
    route: /^https:\/\/nrg-tk\.pro\/client\/tracking\/#9999-0000001$/,
    marker: /Отслеживание \/ оплата груза|Информация об экспедиторской расписке/ },
  // The page reads the numbers from its address and looks them up on load.
  { carrier: 'cj-packet', number: 'CJPZZZ0000000001YQ',
    route: /^https:\/\/www\.cjpacket\.com\/\?trackingNumber=CJPZZZ0000000001YQ$/,
    marker: /Copy All Tracking Numbers|No tracking info found|Global Package Tracking/i },
  // The page fills its field in and looks the number up on load.
  { carrier: 'orlen-paczka', number: '2109999000003',
    route: /^https:\/\/www\.orlenpaczka\.pl\/sledz-paczke\/\?numer=/,
    marker: /Śledzę paczkę|przesyłki o tym numerze nie można śledzić/i },
  // MySpeedy's public tracker reads the number from its path and looks it up on load.
  { carrier: 'speedy', number: '69000000001',
    route: /^https:\/\/myspeedy\.speedy\.bg\/pub\/tracking\/69000000001/,
    marker: /Проследи пратка|Track shipment|Въведете номер на товарителница|Enter Tracking Number/i },
  // The page fills its field in and looks the code up on load.
  { carrier: 'elta', number: 'ZZ000000014GR',
    route: /^https:\/\/www\.elta\.gr\/track\?code=/,
    marker: /Track and Trace|Ιστορικό Μη Διαθέσιμο/ },
  // The page fills its field in and looks the number up once Turnstile lets it.
  { carrier: 'omniva', number: 'CC900000019EE',
    route: /^https:\/\/minu\.omniva\.ee\/track\/CC900000019EE/,
    marker: /Jälgi oma saadetise teekonda|Sisesta oma jälgimisnumber|Track your shipment/i },
  // The server renders the lookup for the number in the address.
  { carrier: 'ceska-posta', number: 'DR9000000002U',
    route: /^https:\/\/www\.postaonline\.cz\/trackandtrace\/-\/zasilka\/DR9000000002U/,
    marker: /Sledování zásilek|není v evidenci/i },
  // The MojaPošta page reads the number from its address and looks it up on load.
  { carrier: 'posta-slovenije', number: 'ZZ000000014SI',
    route: /^https:\/\/moja\.posta\.si\/tracking\?trackingNumber=ZZ000000014SI/,
    marker: /Pošiljke s sprejemno številko nismo našli|Ustvarite račun MojaPošta/ },
  // The page shows the number from its address and looks it up on load; the reply waits for a captcha.
  { carrier: 'posta-romana', number: 'ZZ000000014RO',
    route: /^https:\/\/www\.posta-romana\.ro\/track-trace\.html\?awb=ZZ000000014RO$/,
    marker: /Starea trimiterii|Ghidul Track&Trace/ },
  // The client-rendered tracker fills its field in from the address and looks the number up.
  { carrier: 'latvijas-pasts', number: 'ZZ900000005LV',
    route: /^https:\/\/mans\.pasts\.lv\/track\?(?:[^#]*&)?id=ZZ900000005LV/,
    marker: /Sūtījuma izsekošana|Meklē sūtījumu|Shipment tracking/i, renderTimeoutMs: 20_000 },
  // The Cypriot tracker reads the number from its address and searches it on load.
  { carrier: 'acs-courier', number: '9000000063',
    route: /^https:\/\/cyp\.acscourier\.net\/en\/quick-access\/non-registered-users\/track-and-trace\/\?trackingNumber=/,
    marker: /Track and trace|Shipment not found/i },
  // The home page opens its search form on the number from its address and looks it up on load;
  // for an unknown number it shows only the form.
  { carrier: 'ppl', number: '29000000001',
    route: /^https:\/\/www\.ppl\.cz\/\?form=track-and-trace&shipmentId=29000000001$/,
    marker: /Zásilka nenalezena|Shipment not found|Vyhledat zásilku/i },
  // The page fills its field in and looks the voucher up on load.
  { carrier: 'geniki-taxydromiki', number: '9999999999',
    route: /^https:\/\/taxydromiki\.com\/track\/9999999999\/?$/,
    marker: /Ο αριθμός αποστολής που ζητήσατε δε βρέθηκε|Πορεία Αποστολής/ },
  // The page looks the waybill up as it is served and names an unknown one in its notice.
  // Its site search script then adds a fragment to the address.
  { carrier: 'courier-center', number: '013000000000',
    route: /^https:\/\/www\.courier\.gr\/track\/result\/\?tracknr=013000000000(?:#gsc\.tab=0)?$/,
    marker: /Δεν βρέθηκε φορτωτική με τον αριθμό|Αριθμός Φορτωτικής/ },
  // The locator page reads the number from its address and looks it up on load; an unknown one gets an error dialog.
  { carrier: 'cbl-logistica', number: '00000000000',
    route: /^https:\/\/clientes\.cbl-logistica\.com\/public\/consultaenvio\.aspx\?id=00000000000$/,
    marker: /No hay datos|Datos generales|Eventos e incidencias/ },
  // The page renders the talón in its address on the server and names an unknown one in its notice.
  { carrier: 'castores', number: '00000000000',
    route: /^https:\/\/www\.castores\.com\.mx\/rastrear\.html\?guide_numbers=00000000000$/,
    marker: /no existe en la base de datos|N[úu]mero de gu[íi]a/ },
  // The page looks the guía in its address up as it is served, puts it in its search box and shows an unknown one's notice.
  { carrier: 'tealca', number: '00000000',
    route: /^https:\/\/www\.tealca\.com\/rastrear-envio\/\?tracking=00000000$/,
    marker: /N[úu]mero de shipment no existe|Conoce el estatus de tu env[íi]o/i },
  // The page looks the guide in its address up on load and names it in an unknown one's notice.
  { carrier: 'veloces', number: 'V0000000003',
    route: /^https:\/\/tracking\.veloces\.app\/tracking-client\/V0000000003$/,
    marker: /No encontramos esa gu[íi]a|No existe un env[íi]o con el n[úu]mero/i },
  // The page reads the number from its address and posts it to its lookup on load; an unknown one gets an empty card.
  { carrier: 'urbano', number: 'G00000000',
    route: /^https:\/\/www\.urbano\.com\.pe\/tracking\/G00000000$/,
    marker: /Rastrea tu env[íi]o/i },
  // The page puts the CN number in its address into its form and looks it up on load; an unknown one gets an error notice.
  { carrier: 'sundarban-courier', number: '00000000000000',
    route: /^https:\/\/operation\.sundarbancourierltd\.com\/\?cnnumber=00000000000000$/,
    marker: /Track your CN/i },
  // The page puts the guía in its address into its search box and looks it up on load; an unknown one gets a notice naming it.
  { carrier: '4-72', number: 'QQ000000005QQ',
    route: /^https:\/\/svc2\.sipost\.co\/TrazabilidadWeb\?guia=QQ000000005QQ$/,
    marker: /Trazabilidad Web|No se encontr[óo] la gu[íi]a/i },
  // The page puts the guía in its address into its search box and looks it up on load; an unknown one gets a notice naming it.
  { carrier: 'laar-courier', number: 'GYE0000000000',
    route: /^https:\/\/fenix\.laarcourier\.com\/Tracking\/\?guia=GYE0000000000$/,
    marker: /RASTREA\s+TU ENV[ÍI]O|No se encontr[óo] la gu[íi]a/i },
  // The page looks up the tracking ID in its address on load and shows it beside the tracker's answer.
  { carrier: 'valmo', number: 'VL0000000000000',
    route: /^https:\/\/www\.valmo\.in\/track\/VL0000000000000$/,
    marker: /Invalid AWB\/Tracking ID|Order Details/ },
  // The page asks Shipa's router which service holds the number, lists it with that service's link and opens Shipa Delivery's page in a new window.
  { carrier: 'shipa', number: 'SD000000003',
    route: /^https:\/\/shipa\.com\/track\/\?trackingno=SD000000003$/,
    marker: /Results for Your Shipment Search|TRACK IT ON SHIPA DELIVERY/i },
  // The site adds the slash; the page then posts the number in its address to its lookup and names an unknown one.
  { carrier: 'proships', number: '0000000000000',
    route: /^https:\/\/proships\.com\/tracking\/\?tracking=0000000000000$/,
    marker: /No se encontraron paquetes para el c[óo]digo|Seguimiento de Env[íi]o/i },
  // The page puts the number in its address in its form and asks its lookup on load; an unknown one gets a notice.
  { carrier: 'pts-worldwide-express', number: '1000000000',
    route: /^https:\/\/tracking\.pts\.net\/1000000000$/,
    marker: /Parcel Not Founded!|G[öo]nderi Bulunamad[ıi]!|Track & Trace Parcel/ },
  // The page looks the guía in its address up as it is served and names it over the shipment or an unknown one's notice.
  { carrier: 'ampm', number: 'IDTS00000000000000',
    route: /^https:\/\/grupoampm\.com\/rastreador\/\?tracking-id=IDTS00000000000000$/,
    marker: /N[úu]mero de gu[íi]a inv[áa]lido o sin informaci[óo]n|MOVIMIENTOS/i },
  // The delivery note looks up the number in its address; an unknown one gets the note with every field empty.
  { carrier: 'horoz', number: '00000000000000',
    route: /^https:\/\/app3\.horoz\.com\.tr\/wsKurumsal\/_genel\/frmAtfDetay\.aspx\?Ptn=00000000000000$/,
    marker: /ATF B[İI]LG[İI]LER[İI]/,
    forwarding: { notFound: /ATF No\s*:\s*Atf Tipi\s*:/ } },
  // The page looks up the number in its address; an unknown one gets a notice under an empty form.
  { carrier: 'evdemo-lojistik', number: '000000000000',
    route: /^https:\/\/www\.evdemolojistik\.com\/takip\?kargo_kodu=000000000000$/,
    marker: /Detayl[ıi]\s+G[öo]nderi Durumu|Takip numaras[ıi] hatal[ıi] olabilir/,
    forwarding: { notFound: /Takip numaras[ıi] hatal[ıi] olabilir, l[üu]tfen bilgileri kontrol ediniz/ } },
  // The page reads the number from its address when the fragment its own result links add is there, and asks its lookup; an unknown one gets a notice naming it.
  { carrier: 'ewe', number: 'AMZ0000000000',
    route: /^https:\/\/www\.ewe\.com\.au\/pages\/tracking-order\?cno=AMZ0000000000#track-results$/,
    marker: /couldn't find your consignment\/article number|Consignment Number/i },
  // The page reads the code from its address and posts it to its lookup; an unknown one gets a notice.
  { carrier: 'd-express', number: 'ZZ0000000000',
    route: /^https:\/\/www\.dexpress\.rs\/rs\/pracenje-posiljaka\/ZZ0000000000$/,
    marker: /Pošiljka nije pronađena|Praćenje pošiljaka/i },
  // The page reads the shipment code from its address and looks it up on load; an unknown one gets a notice.
  { carrier: 'euroexpress-ba', number: '123456789',
    route: /^https:\/\/www\.euroexpress\.ba\/pracenje-posiljke\/123456789$/,
    marker: /Uneseni broj po[šs]iljke ne postoji|PRONA[ĐD]ITE PO[ŠS]ILJKU/i },
  // The page puts the number in its address into its form and looks it up on load; an unknown one gets a passing notice.
  { carrier: 'dobropost', number: 'DBRPST0000000000',
    route: /^https:\/\/tracking\.dobropost\.com\/\?trackNumber=DBRPST0000000000$/,
    marker: /Отследить посылку|не найден\(а\)/ },
  // The page puts the number in its address into its form and looks it up in a frame on load.
  { carrier: 'quantium-solutions', number: 'UQ000000000TH',
    route: /^https:\/\/track\.quantiumworldwide\.com\/\?trackno=UQ000000000TH$/,
    marker: /Tracking Summary|Track Your Shipments/ },
  // The page reads the waybill from its address and looks it up on load; an unknown one gets a notice without it.
  { carrier: 'taxydema', number: '400000000000',
    route: /^https:\/\/www\.taxydema\.gr\/entopismos\/400000000000$/,
    marker: /Εντοπισμός Πακέτου|Δεν βρέθηκε αποστολή με τα κριτήρια επιλογής σας/ },
  // The tracker looks the voucher in its address up as it is served; an unknown one gets a notice without it.
  { carrier: 'easy-mail', number: '19999999990',
    route: /^https:\/\/trackntrace\.easymail\.gr\/19999999990$/,
    marker: /Δεν βρέθηκε η Αποστολή|Αναλυτικά Στοιχεία Αποστολής/,
    forwarding: { notFound: /Δεν βρέθηκε η Αποστολή/ } },
  // The search page looks the voucher up as it is served and keeps it in its form beside the notice for an unknown one.
  { carrier: 'pack-man', number: 'Z-99999999',
    route: /^https:\/\/pack-man\.gr\/anazitisi-apostolis\.html\?code=Z-99999999$/,
    marker: /Δεν βρέθηκε αποστολή με αυτόν τον κωδικό|Σύνδεσμος για τον πελάτη/ },
  // The page looks the AWB up as it is served; an unknown one gets a notice without the number.
  { carrier: 'cargus', number: '9999999999',
    route: /^https:\/\/www\.cargus\.ro\/personal\/urmareste-coletul\/\?tracking_number=/,
    marker: /Te rugăm să introduci numărul de tracking/i,
    forwarding: { notFound: /Nu am gasit nici un colet/ } },
  // The page posts the PRO to its tracking service on load, verified or not.
  { carrier: 'saia', number: '99999999990',
    route: /^https:\/\/www\.saia\.com\/track\/details;pro=99999999990$/,
    marker: /The Shipment was not found for PRO Number: 99999999990/ },
  // The page fills its search with the PROs in its address and posts it once loaded, several seconds in; an unknown one gets a card naming it.
  { carrier: 'tforce-freight', number: '999999991',
    route: /^https:\/\/www\.tforcefreight\.com\/ltl\/apps\/Tracking(?:\?|$)/,
    marker: /Please check ProNumber 999999991|PRO\(S\) RELATED TO/, renderTimeoutMs: 20_000 },
  { carrier: 'old-dominion', number: '7200000001',
    route: /^https:\/\/www\.odfl\.com\/us\/en\/tools\/trace-track-ltl-freight\.html\?proNumbers=/,
    marker: /Track & Trace Shipments|Enter up to 25 Tracking Numbers/i },
  // The page header names the tracker; its frame posts the number to the trace service on load.
  { carrier: 'econt', number: '9000000000001',
    route: /^https:\/\/www\.econt\.com\/services\/track-shipment\/9000000000001$/,
    marker: /Проследи пратка/ },
  // The tracker reads the number from its address and asks the self-service API on load.
  { carrier: 'lietuvos-pastas', number: 'ZZ999999995LT',
    route: /^https:\/\/lpexpress\.lt\/track\?parcel=ZZ999999995LT/,
    marker: /Sekti siuntą|Jūsų siuntos nepavyko rasti|Track (?:a )?parcel/i },
  // The tracking page asks the shipment service on load and words its notices in Lithuanian.
  { carrier: 'venipak', number: 'V00000E0000009',
    route: /^https:\/\/venipak\.com\/lt\/en\/tracking\/track\/V00000E0000009\/?$/,
    marker: /PAIEŠKOS RAKTAŽODIS|nebuvo rasta|Parcel tracking/i },
  // The page fills its field in from its address and looks the code up on load.
  { carrier: 'yurtici-kargo', number: '999999999999',
    route: /^https:\/\/www\.yurticikargo\.com\/tr\/online-servisler\/gonderi-sorgula\?code=999999999999$/,
    marker: /Gönderi Sorgula|bir kargo bulunamadı/ },
  // The Finnish page fills its field in and asks the tracking service on load.
  { carrier: 'matkahuolto', number: 'MH000000014FI',
    route: /^https:\/\/www\.matkahuolto\.fi\/seuranta\?parcelNumber=MH000000014FI$/,
    marker: /Syötä lähetystunnus|Antamallasi lähetystunnuksella ei löydy vielä tietoja/ },
  // The page asks its GraphQL service for the number in its address on load.
  { carrier: 'helthjem', number: '370724769990000014',
    route: /^https:\/\/(?:www\.)?helthjem\.no\/sporing\/370724769990000014/,
    marker: /Vi finner ingen pakke med dette sporingsnummeret|Spor pakke/ },
  // The tracker reads the number from its address and shows it above the result.
  { carrier: 'hrvatska-posta', number: 'RR000000005HR',
    route: /^https:\/\/posiljka\.posta\.hr\/hr\/tracking\/trackingdata\?barcode=RR000000005HR$/,
    marker: /Broj pošiljke|Nema podataka za uneseni prijamni broj pošiljke/ },
  // The WebForms page looks up the number in its address for the current year and shows it in its field.
  { carrier: 'correos-de-mexico', number: 'RR000000005MX',
    route: /^https:\/\/www\.correosdemexico\.gob\.mx\/SSLServicios\/SeguimientoEnvio\/Seguimiento\.aspx\?guia=RR000000005MX$/,
    marker: /No se encontró información relacionada con\s?la guía|Total de eventos/ },
  // The single-page tracker fills its field from the address fragment and asks its service.
  { carrier: 'maltapost', number: 'RR000000005MT',
    route: /^https:\/\/www\.maltapost\.com\/tracking#\/tracking\?barcode=RR000000005MT$/,
    marker: /Tracking number not recognised|Local Barcode|Foreign Barcode/ },
  // The tracker reads the number from the address fragment and asks its service.
  { carrier: 'dao', number: '00057999999999999992',
    route: /^https:\/\/dao\.as\/find-din-pakke\/#q=00057999999999999992$/,
    marker: /Vi fandt desværre ikke pakkenummer|Find din pakke/ },
  // The page reads the number from its address and asks its tracking service on load.
  { carrier: 'early-bird', number: '00373402216999999990',
    route: /^https:\/\/earlybird\.se\/spara-och-hjalp\?id=00373402216999999990$/,
    marker: /Vi kunde inte hitta någon försändelse med det spårningsnumret|Var är mitt paket\?/ },
  // The link names the European region, which has the tracker; the page adds a
  // country to its address. The number's label clock is years ahead, so it
  // never reads as an expired history.
  { carrier: 'vinted-go', number: '1890000000000001',
    route: /^https:\/\/vintedgo\.com\/en\/tracking\/1890000000000001\?(?:[^#]*&)?region=europe(?:&|$)/,
    marker: /We can.t find a parcel with this information|Shipping timeline/i },
  // The tracker is a form that posts the number; the link opens it empty.
  { carrier: 'mng-kargo', number: '900000000001',
    route: /^https:\/\/www\.dhlecommerce\.com\.tr\/gonderitakip(?:[?#]|$)/,
    marker: /Gönderim Nerede\?|Gönderi Takip Numarası ile Sorgulama/, forwarding: 'none' },
  // The server renders the page; an unknown parcel ID comes back in the form under a notice.
  // The page prefills the barcode form from its address and answers an unknown barcode with its notice.
  { carrier: 'eurodis', number: '999999999999000000000000',
    route: /^https:\/\/eurodis\.com\/track-trace\?track_and_trace_hidden_field=trackCollo&trackCollo-input-of=999999999999000000000000$/,
    marker: /No shipment matching with the entered tracking criteria|Tracking by collo barcode/ },
  { carrier: 'express-one', number: '999999999999000000000000',
    route: /^https:\/\/tracking\.expressone\.hu\/\?plc_number=999999999999000000000000$/,
    marker: /Company ID \(5 digits\)|Cégkód \(5 jegyű\)/,
    shipmentNotFound: { status: 404, marker: /The requested package is currently unavailable in our system|A keresett csomag jelenleg nem elérhető/ } },
  // The page fills its field in from the address; the visitor still presses Track, which posts the form.
  { carrier: 'express-one-bg', number: '10000017',
    route: /^https:\/\/expressone\.bg\/en\/tracking\/10000017$/,
    marker: /Enter a bill of lading number or multiple numbers, separated by a comma/ },
  // The page prefills the number from its address and asks for the delivery or collection postcode.
  { carrier: 'xdp', number: 'ZDBZZZ000000',
    route: /^https:\/\/xdp\.co\.uk\/track\/ZDBZZZ000000\/?$/,
    marker: /Track your XDP parcel|Please confirm delivery or collection postcode/ },
  // The page prefills the number from its address and asks a freight number's postcode.
  { carrier: 'dx', number: 'L0000001',
    route: /^https:\/\/my\.dxdelivery\.com\/t\/L0000001$/,
    marker: /Track my DX|Enter your postcode/ },
  // The page fills its barcode field in from the address and looks the number up on load.
  { carrier: 'fg-delivery', number: 'FGD0000000000000000000101',
    route: /^https:\/\/fgdelivery\.it\/tracciabilita\/\?barcode=FGD0000000000000000000101$/,
    marker: /Inserisci il codice di spedizione|TRACCIA IL TUO PACCO/i },
  // The page looks the number in its address up on load; an unknown one gets a not-found notice.
  { carrier: 'houng-ah-loun', number: 'VTE00000000000',
    route: /^https:\/\/halexpress\.la\/parcel\/VTE00000000000$/,
    marker: /ວັນທີສົ່ງບິນ|ບໍ່ພົບເລກພັດສະດຸນີ້ໃນລະບົບ/ },
  // The search page looks the number in its address up on load and heads its results.
  { carrier: 'anousith', number: '0000000000001',
    route: /^https:\/\/app\.anousith\.express\/landing\/search_tracking\/search_item\?_bill_detail=0000000000001&n_home=2$/,
    marker: /ກວດສອບສະຖານະບິນ|ຜົນການຄົ້ນຫາ/ },
  // The page fills its barcode field in from the address and looks the number up on load.
  { carrier: 'hr-parcel', number: '10000000000001',
    route: /^https:\/\/www\.hrparcel\.com\/traccia-spedizioni\/\?barcode=10000000000001$/,
    marker: /Inserisci qui il tuo codice spedizione|La spedizione non è stata trovata/ },
  // The page fills its code field in from the address and looks the code up on load.
  { carrier: 'sailpost', number: '9000000000000041',
    route: /^https:\/\/www\.sailpost\.it\/traccia-il-pacco\/\?codice=9000000000000041$/,
    marker: /Cerca la tua spedizione|non abbiamo trovato nei nostri sistemi il codice di spedizione/ },
  // The page asks the shipment service for the number in its address on load; an unknown one gets an alert.
  { carrier: 'slovak-parcel-service', number: '70399999999999',
    route: /^https:\/\/www\.sps-sro\.sk\/moja-zasielka\/\?shipment_id=70399999999999$/,
    marker: /Hľadanie podľa čísla balíka|Sledovanie zásielky/ },
  // The page reads the number from its address fragment, fills its field in and looks it up on load.
  { carrier: 'slovenska-posta', number: 'ZZ000000014SK',
    route: /^https:\/\/www\.posta\.sk\/sledovanie-zasielok/,
    marker: /Sledovanie zásielok|Zásielka s uvedeným podacím číslom neexistuje/ },
  // The tracker reads the number from its address fragment, asks its service and moves to its
  // result view, which leaves the number out for an unknown item.
  { carrier: 'post-luxembourg', number: 'ZZ999999995LU',
    route: /^https:\/\/www\.post\.lu\/en\/particuliers\/colis-courrier\/track-and-trace(?:[?#]|$)/,
    marker: /Track your shipments, parcels and registered mail/, renderTimeoutMs: 20_000,
    forwarding: { notFound: /No sent items match your search/ } },
  // The server renders the page; an unknown waybill comes back in the search form under a notice.
  { carrier: 'apc-overnight', number: '2026030599999999999991',
    route: /^https:\/\/apcchoice\.apc-overnight\.com\/track-parcel\?id=2026030599999999999991$/,
    marker: /Your consignment could not be found|CONSIGNMENT SUMMARY/ },
  // The page prefills its field with the number in its address and looks it up on load.
  { carrier: 'meest', number: 'ZZ0000000ZZ00000G',
    route: /^https:\/\/t\.meest-group\.com\/n\/ZZ0000000ZZ00000G$/,
    marker: /Відстежити посилку|не знайдено відправлення з таким номером/ },
  // The page looks the waybill up on load and writes it back in groups of three.
  { carrier: 'sat-ukraine', number: '000000000',
    route: /^https:\/\/www\.sat\.ua\/tracking\/\?number=000\+?000\+?000$/,
    marker: /Накладна на вантаж по ідентифікатору не знайдена/, renderTimeoutMs: 20_000 },
  // The server renders the page; an unknown reference comes back under a heading, with the form empty.
  { carrier: 'whistl', number: 'WHI0000GB00000000001',
    route: /^https:\/\/web\.parcelhub\.net\/Tracking\/reference\/WHI0000GB00000000001$/,
    marker: /Unable to find shipment|Postcode \(If applicable\)/,
    forwarding: { notFound: /Unable to find shipment/ } },
  // The mobile page looks up the number in its address on load and says when it has nothing for it.
  { carrier: 'winit', number: 'WO0000000000A',
    route: /^https:\/\/track\.winit\.com\/tracking\/Mobile\/result\?trackingNos=WO0000000000A$/,
    marker: /Temporarily query no tracking information/ },
  { carrier: 'stone3pl', number: 'S900000000000000001',
    route: /^https:\/\/stone3pl\.com\/\?route=services\/track&nums=S900000000000000001$/,
    marker: /Delivered&Signed|Last Mile Tracking/ },
  // The page moves to its new route in the browser, searches the number and repeats it in the notice it shows when nothing matches.
  { carrier: 'dsv', number: 'ZZ99999999',
    route: /^https:\/\/mydsv\.com\/(?:new\/tracking\/)?track-shipment\?query=ZZ99999999$/,
    marker: /Public track and trace|did not match any results/ },
  // The server renders the shipment into the page; an unknown waybill gets a notice that leaves the number out.
  { carrier: 'go-express', number: '999999999999',
    route: /^https:\/\/www\.general-overnight\.com\/deu_de\/versenden\/sendungsverfolgung\.html\?reference=999999999999$/,
    marker: /Finden Sie Ihre Sendung mit der Sendungsverfolgung|Sendungsverfolgung/,
    forwarding: { notFound: /Wir haben die Sendung mit der angegebenen Tracking-ID noch nicht erhalten/ } },
  // The server renders the page; an unknown consignment comes back under a heading that names it.
  { carrier: 'geis', number: '9999999999999',
    route: /^https:\/\/www\.geis-group\.cz\/cs\/detail-zasilky\?packNumber=9999999999999$/,
    marker: /nebyla nalezena|nebo nebyla předána k přepravě|Historie zásilky/i },
  // The site sends an unknown code back to its search page, which fills its field in under a notice.
  { carrier: 'zeleris', number: 'FFFFFFFF999999999Z',
    route: /^https:\/\/www\.zeleris\.com\/seguimiento-de-envios\/\?tracking_number=FFFFFFFF999999999Z&not_found=1$/,
    marker: /Sigue tu envío|El envío no existe/ },
  // The server renders the shipment for `refer`; an unknown reference gets a notice that does not repeat it.
  { carrier: 'celeritas', number: '300000017',
    route: /^https:\/\/celeritastransporte\.com\/seguimiento-paquete-pedidos\/\?refer=300000017&lang=es$/,
    marker: /Seguimiento de tu pedido|Esta referencia no existe/,
    forwarding: { notFound: /Esta referencia no existe/ } },
  // The server sends a found shipment on to its page by id and renders the search page for an unknown number.
  { carrier: 'kuehne-nagel', number: 'RWM999000099',
    route: /^https:\/\/mykn\.kuehne-nagel\.com\/public-tracking\/shipments\?query=RWM999000099$/,
    marker: /We could find no match|Track your Shipment/ },
  // The server renders the results page; an unknown waybill is listed under a notice that names it.
  { carrier: 'loomis-express', number: 'LSHP99999999',
    route: /^https:\/\/loomisexpress\.com\/loomship\/Track\/TrackResults\?t=WAYBILL&s=LSHP99999999$/,
    marker: /Tracking Results|Below waybills are not available at this moment/ },
  // The server renders the result page; a waybill it does not know is echoed with *** for both branches.
  { carrier: 'lotte-global', number: '314159265350',
    route: /^https:\/\/www\.lotteglogis\.com\/(?:home|mobile)\/reservation\/tracking\/linkView\?InvNo=314159265350$/,
    marker: /운송장 번호|택배조회/ },
  // The page fills its field in and looks the number up alone; an unknown one gets the number-and-postcode notice.
  { carrier: 'dynalogic', number: '99999ZZ999999',
    route: /^https:\/\/track\.mydynalogic\.eu\/track\/(?:login\?ordernumber=99999ZZ999999$|order$)/,
    marker: /MyDynalogic|Track & Trace (?:nummer|number)|combinatie van track & trace nummer en postcode/i },
  // The tracker's script sends an unknown number on to its search page, which names the number it could not find.
  { carrier: 'nationex', number: '900000009',
    route: /^https:\/\/nationex\.com\/reperage(?:\/900000009|\?error=true&searchId=900000009)$/,
    marker: /Aucun résultat trouvé pour le numéro de suivi|Numéro d’envoi \(9 chiffres\)/ },
  // An unknown shipment ID is redirected to the search page, whose notice names it.
  { carrier: 'chit-chats', number: 'Z9Z9Z9Z9Z9',
    route: /^https:\/\/chitchats\.com\/tracking$/,
    marker: /Track your shipment|Nothing found for shipment ID/ },
  // The page reads the label from its address and asks the tracking service on load.
  { carrier: 'aramex-au', number: 'QX9999999990',
    route: /^https:\/\/www\.aramex\.com\.au\/tools\/track\/?\?l=QX9999999990$/,
    marker: /Parcel Journey|Tracking results not displayed\?/ },
  // The same page on New Zealand's host, which asks its own tracking service.
  { carrier: 'aramex-nz', number: 'QZ9999999990',
    route: /^https:\/\/www\.aramex\.co\.nz\/tools\/track\/?\?l=QZ9999999990$/,
    marker: /Parcel Journey|Make sure you have entered the tracking number correctly/ },
  // The page reads the number from its address and posts it to the site's tracking action on load.
  { carrier: 'stallion-express', number: 'SE991231ZZZZ',
    route: /^https:\/\/stallion\.ca\/track\/\?tracking=SE991231ZZZZ$/,
    marker: /No shipment found|Shipped an order with us\? Add your tracking number/ },
  // The page looks the number up itself; an unknown one gets its not-found notice.
  { carrier: 'cdl', number: 'CDL99999999999',
    route: /^https:\/\/apps\.cdldelivers\.com\/Tracking-Page\/track\?id=CDL99999999999$/,
    marker: /Enter your CDL Tracking ID|Unable To Find Tracking Details/i },
  // The tracking component looks the number up when the page opens and shows its notice for an unknown one.
  { carrier: 'osm-worldwide', number: 'OSM000000ZZ9999ZZ',
    route: /^https:\/\/www\.osmworldwide\.com\/tracking\/\?trackingIds=OSM000000ZZ9999ZZ$/,
    marker: /Tracking is not available for this item/, shadowHost: 'tracking-component' },
  // The page reads the number from its path and posts it to the site's lookup on load.
  { carrier: 'epost-global', number: 'EPG999999999999999',
    route: /^https:\/\/epgtrack\.com\/EPG999999999999999$/,
    marker: /We haven.t received any tracking updates|Track your shipments here/ },
  // The page for a number the tracker does not know says so and leaves the number out.
  { carrier: 'global-delivery-network', number: '999999999999',
    route: /^https:\/\/pds\.gdnparcel\.com\/pds_tracking\.asp\?track=999999999999$/,
    marker: /GDN Tracking|Unable to locate the selected Package/,
    forwarding: { notFound: /Unable to locate the selected Package\./ } },
  // The server renders the shipment for the number in its address and sends an unknown one to its search page with a notice.
  { carrier: 'globalpost', number: 'GPZZZZ9999999999US',
    route: /^https:\/\/www\.goglobalpost\.com\/tracking\/\?t=GPZZZZ9999999999US&status=not_found$/,
    marker: /We couldn.t locate any details for the tracking number you entered/,
    forwarding: { notFound: /We couldn.t locate any details for the tracking number you entered/ } },
  // The MyEstes page fills its field in from its address.
  { carrier: 'estes', number: '9999999999',
    route: /^https:\/\/www\.estes-express\.com\/myestes\/shipment-tracking\/\?type=PRO&query=9999999999$/,
    marker: /Enter tracking numbers\. One per line|Not found or tracking information unavailable/ },
  // ArcBest's tool moves the number from the address hash to the path and looks it up.
  { carrier: 'abf-freight', number: '999999999',
    route: /^https:\/\/view\.arcb\.com\/nlo\/tools\/tracking\/999999999$/,
    marker: /Sorry, we didn.t find that shipment|did not return any valid results/ },
  // The page looks up the PRO in its address and names an unknown one over its notice.
  { carrier: 'a-duie-pyle', number: '999999990',
    route: /^https:\/\/aduiepyle\.com\/resources\/shipment-status\/\?tracking=999999990$/,
    marker: /We are unable to find this shipment\.|Track with Pyle Pro Number/ },
  // The direct link renders the shipment on the server; its notice for an unknown PRO names no number.
  { carrier: 'averitt', number: '9999999999',
    route: /^https:\/\/tools\.averitt\.com\/servlet\/rsoLTLtrack\?Type=PN&Number=9999999999$/,
    marker: /Nothing found to display|Tracking Details/, forwarding: { notFound: /Nothing found to display/ } },
  // The shipment page looks the number up and sends an unknown one to its search form, prefilled.
  { carrier: 'ccfs', number: '999999999999',
    route: /^https:\/\/auth\.ccfs\.com\/track\/(?:search|detail)\/999999999999$/,
    marker: /Individual Tracking Number|Location History/ },
  // The lookup redirects to the carrier's NetSuite page, whose notice for an unknown number names no number.
  { carrier: 'am-home-delivery', number: '99999999',
    route: /^https:\/\/4301600\.extforms\.netsuite\.com\/app\/site\/hosting\/scriptlet\.nl\?(?:[^#]*&)?number=99999999(?:&|$)/,
    marker: /Please Enter a Valid BOL Number|Tracking Details/,
    forwarding: { notFound: /Please Enter a Valid BOL Number/ } },
  // Team Trac's answer page looks up the bill in its address and names one it has no status for.
  { carrier: 'team-worldwide', number: 'ZZZ000000',
    route: /^https:\/\/www\.teamww\.com\/wp-content\/tracking\/teamTrac\.php\?hbl=ZZZ000000$/,
    marker: /Status is not available for Team Bill #|Status Details/ },
  // The tracer looks the number up from its address and shows its notice for an unknown PRO.
  { carrier: 'rl-carriers', number: 'ZZ9999999',
    route: /^https:\/\/www\.rlcarriers\.com\/freight\/shipping\/shipment-tracing\?pro=ZZ9999999&docType=PRO&source=web$/,
    marker: /No records found for Number/ },
  // The page asks the service for the code's orders on load; its notice for an unknown code names no number.
  { carrier: 'chazki', number: '000000000000',
    route: /^https:\/\/nintendo\.chazki\.com\/trackcodeTracking\/000000000000$/,
    marker: /No se encontró información sobre la orden/,
    forwarding: { notFound: /No se encontró información sobre la orden/ } },
  // The page asks the service for the number's summary on load and goes back to its search for an unknown one.
  { carrier: '99minutos', number: '9999999999',
    route: /^https:\/\/tracking\.99minutos\.com\/(?:search\/9999999999)?$/,
    marker: /Rastrea aquí tu pedido|Número de guía/ },
  // The server renders the lookup for the number in its address; an unknown one gets the absence heading.
  { carrier: 'dai-post', number: 'NZC999999999',
    route: /^https:\/\/daipost\.com\/track\?tracknbr=NZC999999999$/,
    marker: /Sorry, we couldn.t find your parcel|Where it.s at/ },
  // The phone search page posts the number from its address to the order search on load.
  { carrier: 'tsjy', number: 'TSJY900000000CN',
    route: /^https:\/\/www\.tsjy56\.com\/orderResult\.html\?nos=TSJY900000000CN$/,
    marker: /未找到相关的轨迹信息/ },
  // The page posts the waybill in its address to the tracking lookup on load.
  { carrier: 'tws-express', number: '280000Z000001',
    route: /^https:\/\/www\.mytws\.it\/tracking-status;ldv=280000Z000001$/,
    marker: /La tua lettera di vettura non è presente|Inserisci la lettera di vettura/ },
  // The page reads the number from its address and asks the tracking service on load.
  { carrier: 'hywl', number: 'TRK999999999999',
    route: /^https:\/\/www\.szhywl\.it\.com\/track\.html\?number=TRK999999999999$/,
    marker: /查询失败：HTTP 404/ },
  // The page sends the number in its address to the tracking lookup on load and counts an unknown one not found.
  { carrier: 'dhlink', number: 'FC9912310000001',
    route: /^https:\/\/www\.dhlink\.com\/trackQuery\?intlExpressNo=FC9912310000001&lang=en$/,
    marker: /Tracking Search|There is no track for this waybill number/ },
  // The page reads the number from its address and asks the tracker's lookup; an unknown one gets a notice naming it.
  { carrier: 'direx', number: '9999999999',
    route: /^https:\/\/direx\.bg\/track\/\?code=9999999999$/,
    marker: /Хм, не можахме да намерим нищо за проследяващ номер|Текущ статус/ },
  // The site serves the page's script with a 404 at every tracking address; the script asks the tracking lookup for
  // the number in the address and shows a notice for an unknown one.
  { carrier: 'closer-logistics', number: '000000000000',
    route: /^https:\/\/tracking\.closerlogistics\.com\/tracking\/000000000000$/,
    marker: /El paquete que intenta buscar no existe o ha caducado la información|Último estado del envío/,
    shipmentNotFound: { status: 404, marker: /El paquete que intenta buscar no existe o ha caducado la información/ } },
  // The page puts the number in its search box and posts it to the tracking service on load.
  { carrier: 'speedaf', number: 'MA000000000000',
    route: /^https:\/\/www\.speedaf\.com\/cn-en\/send-parcel\?tradeNo=MA000000000000$/,
    marker: /Track[\s\S]*Inquiry/ },
  // The page reads the number from its address and posts it to the tracker's lookup; its status counters come from the reply.
  { carrier: 'urvaam', number: '2000000000000000',
    route: /^https:\/\/www\.urvaam\.es\/track\/result\?no=2000000000000000$/,
    marker: /Entregado al punto de Recogida|Entregado ao ponto de auto-entrega|Problem piece/ },
  // The page moves to the browser's language prefix, then looks the number up from its address.
  { carrier: 'mailamericas', number: 'MLAR000000000EX',
    route: /^https:\/\/mailamericas\.com\/(?:(?:en|pt)\/)?tracking\?number_id=MLAR000000000EX$/,
    marker: /No se encontró información para este número de tracking|No information found for this tracking number|Não foram encontradas informações para este número de rastreamento|Historial de Seguimiento|Rastrear tu Envío|Track Your Shipment|Rastrear seu Envio/i },
  // The result page looks the NIC in its address up on the server; an unknown one gets a notice without the number.
  // The page's styles show the notice in capitals.
  { carrier: 'cruz-del-sur', number: '900000000',
    route: /^https:\/\/www\.cruzdelsur\.com\/herramientas_seguimiento_resultado\.php\?nic=900000000$/,
    marker: /No existe NIC\.|Línea de seguimiento/i,
    forwarding: { notFound: /No existe NIC\./i } },
  // The page puts the number in its field and posts it to the tracker; an unknown one gets its generic error in Ukrainian.
  { carrier: 'nova-global', number: 'NP00000000000000NPG',
    route: /^https:\/\/nova\.global\/track\/\?Tracking_ID=NP00000000000000NPG$/,
    marker: /Enter the parcel number|Status history|Щось пішло не так/ },
  // The e-Posta page reads the code from its address, shows it in its heading and asks the tracker's lookup.
  { carrier: 'posta-shqiptare', number: 'ZZ000000005AL',
    route: /^https:\/\/eposta\.postashqiptare\.al\/tracking\/ZZ000000005AL$/,
    marker: /Kodi:|Nuk ka ngjarje për këtë barkod|Gjurmo dërgesën/ },
  // The page posts the number from its address to the tracker's lookup, which refuses the 1SE prefix and leaves the card empty.
  { carrier: 'shipentegra', number: '1SE000000000',
    route: /^https:\/\/track\.shipentegra\.com\/\?trackno=1SE000000000$/,
    marker: /Where can I find my ShipEntegra tracking number|ShipEntegra takip numaramı nerede bulabilirim|Dónde puedo encontrar mi número de seguimiento de ShipEntegra/ },
  // The page puts the number in its field and posts it to the tracker; an unknown one gets its invalid-number notice.
  { carrier: 'connect-couriers', number: '00000000000',
    route: /^https:\/\/www\.connectcouriers\.eu\/tracking\/\?tracking_number=00000000000$/,
    marker: /Track and Trace Your Parcel|This tracking number is invalid/ },
  // The page puts the number in its field; it names one below its current series as an earlier year's instead of looking it up.
  { carrier: 'bex-express', number: '000000000',
    route: /^https:\/\/bexexpress\.rs\/pracenje-posiljke\?broj-posiljke=000000000$/,
    marker: /Praćenje pošiljke|je iz prethodne godine/ },
  // The page looks the number in its address up and shows it over "No data" when unknown.
  { carrier: 'janio', number: 'JNSG000000000000',
    route: /^https:\/\/tracker\.janio\.asia\/JNSG000000000000$/,
    marker: /Enter Parcel Tracking ID/ },
  // The page looks the number in its address up and names an unknown one in a popup.
  { carrier: 'fastdrop', number: '0000000000',
    route: /^https:\/\/booking\.fastdrop\.mt\/package-tracking\/0000000000$/,
    marker: /Tracking ID not found|the pins do not point to the exact addresses of origin and destination/ },
  // The site turns the address to lower case; the page then looks the number up and names an unknown one in a popup.
  { carrier: 'drop2shop', number: 'GLB9000000000003',
    route: /^https:\/\/www\.drop2shop\.ie\/tracking\?trackingnumber=glb9000000000003$/i,
    marker: /Shipment not found|could not find the shipment details for this tracking number/,
    forwarding: { notFound: /could not find the shipment details for this tracking number/ } },
  // The tracker looks up the barcode from its address and names an unknown one in an alert.
  { carrier: 'mylerz', number: '63000000000000',
    route: /^https:\/\/mylerz\.net\/track\/63000000000000$/,
    marker: /Not recognized barcode|لم يتم التعرف على الباركود/,
    forwarding: { notFound: /Not recognized barcode|لم يتم التعرف على الباركود/ } },
  // The page looks up the number from its address on load and shows it beside its result.
  { carrier: 'anjun', number: 'AJ260101000000001',
    route: /^https:\/\/anjuntrack\.com\/trackQuery\?t=AJ260101000000001$/,
    marker: /查询不到|Query not found|Não é possível consultar/ },
  // The server renders the results page; an unknown airway bill gets a notice that names it.
  { carrier: 'smsa-express', number: '100000000000',
    route: /^https:\/\/www\.smsaexpress\.com\/sa\/trackingdetails\?tracknumbers=100000000000$/,
    marker: /Track And Trace Details|This tracking number is not found/ },
  // The server renders the tracker's popup; an unknown number gets a notice under the number it shows.
  { carrier: 'gs-postbox', number: '000000000000',
    route: /^https:\/\/www\.cvsnet\.co\.kr\/invoice\/tracking\.do\?invoice_no=000000000000$/,
    marker: /해당 운송장의 배송정보를 조회할 수 없습니다/ },
  // The page keeps the number from its address in its form and posts it to its own lookup on load.
  { carrier: 'cj-logistics', number: '000000000000',
    route: /^https:\/\/www\.cjlogistics\.com\/ko\/tool\/parcel\/newTracking\?gnbInvcNo=000000000000$/,
    marker: /운송장이 등록되지 않았거나 보내는 분이 상품을 준비 중입니다|운송장번호를 입력하세요/ },
  // The tracker keeps the number from its address in its form and looks it up on load.
  { carrier: 'shadowfax', number: 'SF000000001ZZZ',
    route: /^https:\/\/tracker\.shadowfax\.in\/#\/(?:awb\/SF000000001ZZZ|track\/)/,
    marker: /Invalid AWB Number\. Please check again\.|Track Your Order with Shadowfax/ },
  // The page fills its field in from the address and looks the number up on load.
  { carrier: 'imile', number: '0000000000013',
    route: /^https:\/\/www\.imile\.com\/[^/]+\/track\/?\?waybillNo=0000000000013$/,
    marker: /TRACK YOUR ORDER|TYPE YOUR ORDER NUMBER/i },
  // The server renders the lookup; its answer to an unknown number does not show the number.
  { carrier: 'naqel', number: '100000009',
    route: /^https:\/\/www\.naqelexpress\.com\/en\/Track\/TrackShipment\/100000009$/,
    marker: /Waybills \/ Reference Numbers|Shipment Details/,
    forwarding: { notFound: /Sorry Tracking information is not available/ } },
  // The page shows the number from its address as a tag in its form and asks its own lookup on load.
  { carrier: 'saudi-post', number: 'RR000000005SA',
    route: /^https:\/\/splonline\.com\.sa\/en\/shipmentdetailsstatic\/\?tid=RR000000005SA$/,
    marker: /No data matches entered tracking number|Track Your Shipment/ },
  // The page fills its field in from the address and looks the number up once its large script bundles load.
  { carrier: 'starken', number: '100000009',
    route: /^https:\/\/www\.starken\.cl\/seguimiento\?codigo=100000009$/,
    marker: /Realiza seguimiento en línea|número de orden de flete/, renderTimeoutMs: 25_000 },
  // The page reads the number from its address, looks it up on load and repeats it when it finds no shipment.
  { carrier: 'pdq-chile', number: '100200300400',
    route: /^https:\/\/www\.pdq\.cl\/tracking\?q=100200300400$/,
    marker: /No encontramos ese envío|Rastrea tu envío/ },
  // The tracker spends several seconds on an ALTCHA proof of work before it looks the guide up, then clears an unknown
  // guide from its search field and says it found none.
  { carrier: 'interrapidisimo', number: '999999999999',
    route: /^https:\/\/siguetuenvio\.interrapidisimo\.com\/999999999999$/,
    marker: /Consulta el estado de tu envío/, renderTimeoutMs: 30_000,
    forwarding: { notFound: /No se encontraron guías con la información ingresada/ } },
  // The server renders the lookup; its answer to an unknown number shows the number.
  { carrier: 't-cat', number: '900000000099',
    route: /^https:\/\/www\.t-cat\.com\.tw\/Inquire\/TraceDetail\.aspx\?BillID=900000000099$/,
    marker: /一般包裹查詢|目前資料庫尚未能查詢到該筆貨物追蹤查詢號碼狀態/ },
  { carrier: 'tcs-pakistan', number: '10000000001',
    route: /^https:\/\/www\.tcsexpress\.com\/track\/10000000001$/,
    marker: /Enter any combination of TCS tracking Reference number/ },
  // The server looks the number in the address up and fills its form in with it.
  { carrier: 'm-and-p', number: '999999999999999',
    route: /^https:\/\/www\.mulphilog\.com\/tracking\/999999999999999$/,
    marker: /No tracking record found with the provided consignment number|Consignment Number/ },
  // The server renders the lookup and echoes the number, with an empty history for an unknown code.
  { carrier: 'pakistan-post', number: 'ZZ000000014PK',
    route: /^https:\/\/ep\.gov\.pk\/emtts\/EPTrack_Live\.aspx\?ArticleIDz=ZZ000000014PK$/,
    marker: /Article Track Detail/ },
  // The page posts the number in `cn` to its own lookup as it opens, and keeps it in the field.
  { carrier: 'postex', number: '00000000000000',
    route: /^https:\/\/postex\.pk\/tracking\?cn=00000000000000$/,
    marker: /Tracking a Call Courier shipment\?/ },
  // The server renders the lookup and names the number above an empty timeline for an unknown code.
  // The heading is styled in capitals.
  { carrier: 'algerie-poste', number: 'ZZ000000014DZ',
    route: /^https:\/\/ems\.dz\/track\/index\.php\?icd=ZZ000000014DZ$/,
    marker: /Détails d'envoi Nº/i },
  // The server looks the code up and, finding nothing, shows only the time the search took; a code
  // that is not thirteen characters long gets a refusal instead.
  { carrier: 'corre', number: 'ZZ900000040MZ',
    route: /^https:\/\/www\.corremz\.com\/cgi-bin\/tracktrace\.cgi\?OBJ=ZZ900000040MZ$/,
    marker: /A obter a imagem da Guia no repositorio de arquivo/,
    forwarding: { notFound: /A pesquisa demorou \d+ milisegundos/ } },
  // The page fills its field in from the address, looks the code up and names the codes it did not find.
  { carrier: 'pecom', number: '100000000033',
    route: /^https:\/\/pecom\.ru\/services-are\/order-status\/\?code=100000000033$/,
    marker: /Отследить груз|Запрашиваемые вами грузы не найдены/ },
  // The page fills its search box in from the address, looks the number up and names it when it finds nothing.
  { carrier: 'cse-russia', number: '100000000000',
    route: /^https:\/\/www\.cse\.ru\/mow\/track\/\?numbers=100000000000$/,
    marker: /По запросу \d+ ничего не найдено\. Проверьте правильность написания номера|Отслеживание посылок/ },
  // The page looks the number up itself and names it in its answer to an unknown one.
  { carrier: '5post', number: '99990000000000',
    route: /^https:\/\/fivepost\.ru\/tracking\/\?id=99990000000000$/,
    marker: /Заказ с номером \S+ не существует|Где мой заказ\?/ },
  // The page puts the waybill in its address in its field, looks it up on load and names an unknown one in its answer.
  { carrier: '4sides', number: 'FS000000000RU',
    route: /^https:\/\/4sides\.ru\/tracking\?number=FS000000000RU$/,
    marker: /Не найдено FS000000000RU|Номер накладной|Хронология движения/ },
  // The page fills its search box in from the address without looking the number up.
  // Its heading stays in Thai when the page's settings load late.
  { carrier: 'kex', number: 'SYNT000000017',
    route: /^https:\/\/th\.kex-express\.com\/en\/track\/\?track=SYNT000000017$/,
    marker: /Track & Trace|ติดตามเลขพัสดุเคอีเอ็กซ์ เอ็กซ์เพรส/ },
  // The server looks the number in the address up and shows it over its answer.
  { carrier: 'kex-express-hk', number: 'Z000000000',
    route: /^https:\/\/www\.kex\.kln\.com\/en\/track\?track=Z000000000$/,
    marker: /have not yet received information of this tracking no|Track & Trace/ },
  // The page reads the numbers from its address and looks them up on load.
  { carrier: 'lion-parcel', number: '55LP0000000000001',
    route: /^https:\/\/lionparcel\.com\/track\/stt\?q=55LP0000000000001$/,
    marker: /Hasil pencarian tidak ditemukan|Nomor resi atau STT|Riwayat Pengiriman/i },
  // The page fills its field in from the address and looks the number up a few seconds later.
  { carrier: 'via-cargo', number: '999000000000',
    route: /^https:\/\/formularios\.viacargo\.com\.ar\/seguimiento-envio\/999000000000$/,
    marker: /Seguimiento de env[íi]o|No existen datos para el n[úu]mero de env[íi]o ingresado/i },
  // The page posts the number in its address to the lookup, which names it above an empty history for an unknown one.
  { carrier: 'blueex', number: '4000000003',
    route: /^https:\/\/www\.blue-ex\.com\/tracking\?trackno=4000000003$/,
    marker: /Shipment Tracking|BlueEX Shipping Label/ },
  // The server renders the ID in the address into the page and answers an unknown one with a
  // notice in place of the parcel.
  { carrier: 'ecourier', number: 'ECR0000000000000',
    route: /^https:\/\/ecourier\.com\.bd\/tracking\/\?tracking_no=ECR0000000000000$/,
    marker: /Shipment Tracking|No Result Found/,
    forwarding: { notFound: /No Result Found/ } },
  // The page looks up each air waybill in its address and answers an unknown one with its notice
  // in place of the scans.
  { carrier: 'bombino', number: '0000000000',
    route: /^https:\/\/www\.bombinoexp\.com\/track\?tracking_no=0000000000$/,
    marker: /No tracking data found for this AWB|Tracking History/ },
  // The page fills its field in from the address and looks the number up.
  { carrier: 'bosta', number: '99999998',
    route: /^https:\/\/bosta\.co\/en-eg\/tracking-shipments\?shipment-number=99999998$/,
    marker: /Track Your Shipment|Tracking Number Not Found/ },
  // The page lists the waybills from its address; each opens its scans.
  { carrier: 'j-and-t-middle-east', number: 'JTE300000000000',
    route: /^https:\/\/www\.jtexpress\.me\/KSA\/trajectoryList\?waybillNo=JTE300000000000&type=0$/,
    marker: /Waybill list/ },
  // The page looks up the waybills in `q` and says it has no tracking records for an unknown one.
  { carrier: 'j-and-t-au', number: 'JTAU000000000000',
    route: /^https:\/\/www\.jtexpress\.au\/tracking\?q=JTAU000000000000$/,
    marker: /No tracking records yet|Keine Abfrageergebnisse|暂无查询记录|Waybill list/ },
  { carrier: 'j-and-t-de', number: 'JTDE000000000000',
    route: /^https:\/\/www\.jtexpress\.de\/tracking\?q=JTDE000000000000$/,
    marker: /Keine Abfrageergebnisse|No tracking records yet|暂无查询记录|Waybill list/ },
  { carrier: 'j-and-t-uk', number: 'JTUK000000000000',
    route: /^https:\/\/www\.jtexpress\.uk\/tracking\?q=JTUK000000000000$/,
    marker: /No tracking records yet|暂无查询记录|Waybill list/ },
  { carrier: 'aymakan', number: 'AY99999999999',
    route: /^https:\/\/aymakan\.com\/tracking\/AY99999999999$/,
    marker: /No shipment found|Track Shipments/ },
  // The page looks the number up from its address and sends an unknown one to its wrong-number page. Until the
  // site's visitor token arrives, it sends the number to the home page's tracking box instead.
  { carrier: 'ajex', number: 'AJA000000000000',
    route: /^https:\/\/aj-ex\.com\/(?:shipment-status\/AJA000000000000|wrong-tracking-number|\?awb=AJA000000000000)$/,
    marker: /Wrong Tracking Number|Shipment Status|Type your tracking number/,
    forwarding: { notFound: /Wrong Tracking Number/ } },
  // The page looks the number up from its address and sends an unknown one to its not-found page.
  { carrier: 'labaih', number: '00000000000000',
    route: /^https:\/\/track\.mylabaih\.com\/(?:track\/\?cn=00000000000000|errors\/404)$/,
    marker: /Shipment\(s\) Not Found|تتبع الشحنة/,
    forwarding: { notFound: /Shipment\(s\) Not Found/ } },
  // The page looks the number up and, for an unknown one, shows its error without it.
  { carrier: 'hepsijet', number: 'ZZ0000000000',
    route: /^https:\/\/www\.hepsijet\.com\/gonderi-takibi\/ZZ0000000000$/,
    marker: /Gönderi numarasını eksik|GÖNDERİ DURUMU/,
    forwarding: { notFound: /Gönderi numarasını eksik\s+ya da hatalı girdiniz/ } },
  // The page reads the ID from its address and looks it up on load.
  { carrier: 'pathao-courier', number: 'DZ010126SMPL00',
    route: /^https:\/\/merchant\.pathao\.com\/public-tracking\?consignment_id=DZ010126SMPL00$/,
    marker: /No Data Found|Tracking Details|Consignment ID/i },
  // The page reads the ID from its address, looks it up on load and names it when it finds no parcel.
  { carrier: 'redx', number: '26A1A5MO1SMPL0',
    route: /^https:\/\/redx\.com\.bd\/track-global-parcel\/\?trackingId=26A1A5MO1SMPL0$/,
    marker: /No parcel found|Track Parcel/i },
  // The page looks the number up and prints it in groups; for an unknown one it says it has no data.
  { carrier: 'fukuyama', number: '12345678901',
    route: /^https:\/\/seikyu\.fukuyama-tsuun\.com\/corp\/tracking_no_hunt\/12345678901$/,
    marker: /お荷物配達状況詳細|該当データはありません/,
    forwarding: { notFound: /該当データはありません/ } },
  // The co-op's form on Yamato System Development's tracker looks the number up and lists it, with its state.
  { carrier: 'last-one-mile-coop', number: '700000000000',
    route: /^https:\/\/y-track\.jp\/ytrack\/inqservlet\?cd=81118&id=02116&number01=700000000000$/,
    marker: /送り状番号未登録|貨物状況/ },
  // The page puts the number in its form and looks it up on load.
  { carrier: 'cttyex', number: 'CTTY9900000001CN',
    route: /^https:\/\/www\.cttyvip888\.com\/index\/tracknumber\/track\?nos=CTTY9900000001CN$/,
    marker: /快件跟踪|跟踪\(Track\)/ },
  // The same tracker system as CTTYEX's: the number in the form, looked up on load.
  { carrier: 'linhan', number: 'LHGJ99000001CD',
    route: /^https:\/\/www\.linhan56\.com\/index\/tracknumber\/track\?nos=LHGJ99000001CD$/,
    marker: /快件跟踪|跟踪\(Track\)/ },
  // The page moves the number into its hash route, through a bare `#/` first, looks it up on load
  // and lists it, with a notice while it has no data.
  { carrier: 'dayone', number: 'DOT0990000000000001',
    route: /^https:\/\/www\.dayonetrack\.com\/track\?trackNo=DOT0990000000000001(?:#\/(?:track\?trackNo=DOT0990000000000001(?:&lang=[a-zA-Z-]+)?)?)?$/,
    marker: /Tracked number|The order information has not been updated yet|订单信息尚未更新/ },
  // The tracker renders the number's history as it serves the page, or 暂无记录 for an unknown one.
  { carrier: 'ydh', number: 'YDH0000000017YQ',
    route: /^https:\/\/track\.ydhex\.com\/track_query\.aspx\?track_number=YDH0000000017YQ$/,
    marker: /暂无记录|目的国家/ },
  { carrier: 'dealersend', number: 'DSLAF9000000001YQ',
    route: /^https:\/\/dealer-send\.com\/en-US\/track-my-shipment\?trackingNumber=DSLAF9000000001YQ$/,
    marker: /Track My Shipment/ },
  // The page fills its form with the reference and looks it up on load.
  { carrier: 'sendle', number: 'QSS990000001',
    route: /^https:\/\/www\.sendle\.com\/tracking\?ref=QSS990000001$/,
    marker: /Order or tracking number|Track your parcel/ },
  // The page fills its form with the waybill, looks it up on load and says when it has none.
  { carrier: 'gig-logistics', number: '1990000001',
    route: /^https:\/\/giglogistics\.com\/track-shipment\/\?waybill=1990000001$/,
    marker: /waybill number to get real-time updates|Invalid waybill number/ },
  // The page runs its quick search for the number on load and names it beside the count.
  { carrier: 'team-global-express', number: '9900000000000',
    route: /^https:\/\/www\.myteamge\.com\/\?externalSearchQuery=9900000000000$/,
    marker: /0 shipments\s+matched|Track your shipment/i },
  // The page answers an unknown number with a notice and an empty form.
  { carrier: 'south-african-post-office', number: 'ZZ000000014ZA',
    route: /^https:\/\/trackingnew\.postoffice\.co\.za\/\?ParcelId=ZZ000000014ZA$/,
    marker: /Enter Parcel Number To Track|PARCEL TRACKING RESULTS/i,
    forwarding: { notFound: /No tracking record found/ } },
  // The tracer looks the PRO up on the server and names it in its not-found notice.
  { carrier: 'southeastern-freight-lines', number: '9999999',
    route: /^https:\/\/www\.sefl\.com\/webconnect\/tracing\?Type=PN&RefNum1=9999999$/,
    marker: /The tracing information you requested for Pro Number 9999999 was not found in our system|Tracing Results/ },
  // The page fills its field in from the address and looks the number up.
  { carrier: 'bulgarian-posts', number: 'ZZ000000014BG',
    route: /^https:\/\/www\.bgpost\.bg\/(?:en\/)?postal-services\/track-package\?itemid=ZZ000000014BG$/,
    marker: /ПРОСЛЕДЯВАНЕ НА ПРАТКА|ITEM TRACKING/i },
  // The page looks the number up and answers an unknown one with its not-found notice.
  // The page asks its API for the number in its address and says when it has no delivery status.
  { carrier: 'pin-ag', number: '0100800000000001',
    route: /^https:\/\/sendungsverfolgung\.pin-ag\.de\/\?sendung=0100800000000001$/,
    marker: /kein Zustellstatus|Sendungsnummer/i },
  { carrier: 'better-trucks', number: 'BTPA0000000ZZ01',
    route: /^https:\/\/tracking\.bettertrucks\.com\/tracking\?trackingNumber=BTPA0000000ZZ01$/,
    marker: /Shipment can.t be found|Enter your tracking number/i },
  // The page looks the number in its address up on the server and names it in its not-found notice.
  { carrier: 'fleetex', number: 'SR000000000000',
    route: /^https:\/\/tracking\.fleetexpress\.ca\/tracking\/en\/SR000000000000$/,
    marker: /Package Not Found|Track your package/ },
  // The page spaces the number in its field and its address before it asks its service,
  // then answers an unknown number with its not-found notice.
  { carrier: 'lightning-express', number: 'YYZ00000000000000',
    route: /^https:\/\/www\.lightningexpressca\.com\/track\.html\?id=YYZ00(?:%20| |\+)?00000000(?:%20| |\+)?0000$/,
    marker: /Track your shipment|No order found/i, forwarding: { notFound: /No order found\. Please check and try again\./ } },
  // The page fills its field in from the address and looks the number up; the form's heading
  // shows while the answer is slow.
  { carrier: 'belpost', number: 'ZZ000000014BY',
    route: /^https:\/\/(?:www\.)?belpost\.by\/Otsleditotpravleniye\?number=ZZ000000014BY$/,
    marker: /Введите номер отправления|Где мое отправление|У нас пока нет данных об этом трек-номере|Where is my postal item|any data on this tracking number/i },
  // The page looks the code up and heads its answer with it, here the notice for service letters the post does not use.
  { carrier: 'correo-uruguayo', number: 'ZZ000000014UY',
    route: /^https:\/\/ahiva\.correo\.com\.uy\/servicioConsultaTntIps-web\/SeguimientoJSNuevo\?codigoPieza=ZZ000000014UY$/,
    marker: /Consultas para el env[ií]o con c[óo]digo|Producto inv[áa]lido/i },
  // The page fills its field in from the address and looks the code up.
  { carrier: 'uzbekistan-post', number: 'ZZ000000014UZ',
    route: /^https:\/\/uz\.post\/ru\/tracking\/ZZ000000014UZ\/?$/,
    marker: /CC123456789UZ/ },
  // The page reads the code from the fragment and looks it up. An address without the language
  // redirects to one with it and drops the fragment, and an English one shows its labels' keys.
  { carrier: 'haypost', number: 'ZZ000000045AM',
    route: /^https:\/\/www\.haypost\.am\/am\/track-trace#ZZ000000045AM$/,
    marker: /Հետևել բեռնային համարով|Տվյալը չի գտնվել/ },
  // The page looks the number from its path up once it loads, and names it in its not-found notice.
  { carrier: 'nipost', number: 'ZZ000000014NG',
    route: /^https:\/\/tracking\.nipost\.gov\.ng\/ZZ000000014NG$/,
    marker: /We couldn't find any information for tracking number|Tracking updates/ },
  // A single-page app that looks the number up on load and shows it over its notice.
  { carrier: 'kazpost', number: 'ZZ000000014KZ',
    route: /^https:\/\/post\.kz\/services\/postal\/ZZ000000014KZ$/,
    marker: /Сәлемдемені іздеу|Найти посылку|Track a parcel|Сәлемдеме бойынша ақпарат жоқ|Отсутствует информация о посылке|There is no information about the parcel/ },
  // The page fills its field in from the address and looks the number up.
  { carrier: 'exline-kz', number: '0000000000',
    route: /^https:\/\/exline\.kz\/ru\/tracking\?id=0000000000$/,
    marker: /Отслеживайте вашу посылку|Отправление с таким номером не найдено/ },
  // The page looks the number in its address up on load.
  { carrier: 'shipblu', number: '1000000000000',
    route: /^https:\/\/go\.shipblu\.com\/en\/1000000000000$/,
    marker: /We have an eye on your shipment|Not found!/i },
  // The page looks the number up on the server and heads its results with it.
  { carrier: 'maersk-ecommerce', number: '1MEXAMPLE0000000001',
    route: /^https:\/\/www\.maersk\.com\/tracking\/parcel\/1MEXAMPLE0000000001$/,
    marker: /We couldn't find any parcels with that tracking number/i,
    forwarding: { notFound: /We couldn't find any parcels with that tracking number/i } },
  // The tracker heads its answer with the number, its no-record answer too.
  { carrier: 'fedex-international-connect', number: 'ZZZ0000GB00000000017',
    route: /^https:\/\/fictracking\.fedex\.com\/\?MyFICNumber=ZZZ0000GB00000000017$/,
    marker: /Sorry we have no record of your reference on file at this time/i },
  { carrier: 'mainfreight', number: 'S00000000',
    route: /^https:\/\/www\.mainfreight\.com\/tracking\?trackingnumber=S00000000$/,
    marker: /Tracking Results for|No results found for the provided tracking number/i },
  // The server renders the lookup; it sends an unknown number back to the home page's form, prefilled.
  { carrier: 'pbt', number: 'ZZQ0000000',
    route: /^https:\/\/www\.pbt\.nz\/(?:tracking-result\/)?\?consignmentNumber=ZZQ0000000(?:&hasError=true)?(?:#tracking-search)?$/,
    marker: /Tracking Results|Latest status|The ticket\/consignment note number you.ve provided is not valid/i },
  // A single-page app that puts the guía in its search field, looks it up on load and names it when it finds nothing.
  { carrier: 'envia-colombia', number: '999000000001',
    route: /^https:\/\/envia\.co\/tracking\?guia=999000000001$/,
    marker: /Rastreo de\s+tu env[ií]o|No se encontr[óo] informaci[óo]n de rastreo para la gu[ií]a|Track\s+your shipment|No tracking information found for guide/i },
  // The deep link opens an anonymous session on the number and redirects to the app, which says it cannot find it.
  { carrier: 'raben', number: '999999000000033',
    route: /^https:\/\/oftc\.myraben\.com\/index\.html$/,
    marker: /Shipment number: \d+ could not be found|Shipment, reference number or Colli/i },
  // The page reads the voucher from its address fragment and looks it up on load; for an unknown
  // one it clears the fragment and says so for a few seconds.
  { carrier: 'skroutz-last-mile', number: 'Z9SAMPLE0UNK0',
    route: /^https:\/\/www\.skroutzlastmile\.gr\/(?:#.*)?$/,
    marker: /Search for your parcel with your voucher|The voucher you provided was not found|Shipment Tracking/i },
  // The page looks the number up on the server and names it in its not-found notice.
  { carrier: 'olva-courier', number: '26-00000000',
    route: /^https:\/\/tracking\.olvacourier\.com\/\?q=26-00000000$/,
    marker: /El número ingresado 26-00000000 no se ha encontrado|Código de seguimiento inválido/ },
  // The page posts the number in its address to the tracking lookup on load; an unknown one gets the not-found line.
  { carrier: 'flash-express', number: 'TH9999000000Z',
    route: /^https:\/\/www\.flashexpress\.co\.th\/fle\/tracking\?se=TH9999000000Z$/,
    marker: /ไม่พบข้อมูลของเลขพัสดุนี้|No information found for this tracking number|未查到此运单信息/ },
  // The site's browser check reloads the page after a few seconds; the page then posts the number
  // in its address to the tracking lookup, and an unknown one gets the not-found line.
  { carrier: 'flash-express-ph', number: 'P9999000000Z',
    route: /^https:\/\/www\.flashexpress\.ph\/fle\/tracking\?se=P9999000000Z$/,
    marker: /No information found for this tracking number|未查到此运单信息/, renderTimeoutMs: 20_000 },
  // The server answers an unknown code with its empty search page, which clears the code; a known
  // one first gets a script that adds `reloaded` to the address.
  { carrier: 'delnext', number: 'ZZ0000',
    route: /^https:\/\/www\.delnext\.com\/PT\/track_your_parcel\?tracking_code=ZZ0000(?:&reloaded=PT)?$/,
    marker: /Acompanhe a entrega da sua encomenda/,
    forwarding: { notFound: /Acompanhe a entrega da sua encomenda/ } },
  // The app looks the number up on its preview route and, once the lookup finds nothing, moves to its
  // search route with the same address.
  { carrier: 'fedex-pl', number: '6230000000005',
    route: /^https:\/\/fds2tracking\.emea\.fedex\.com\/#\/(?:preview|tracking(?:\/list)?)\?packages=6230000000005(?:&|$)/,
    marker: /Monitorowanie przesyłek krajowych|Track (?:your )?domestic shipment/ },
  // The IPS page answers a code it holds nothing for with a notice that does not repeat the code.
  { carrier: 'jordan-post', number: 'ZZ000000014JO',
    route: /^https:\/\/212\.35\.69\.85\/webtracking\/IPSWeb_item_events\.aspx\?itemid=ZZ000000014JO&Submit=Submit$/,
    marker: /No information, please check your item identifier|IPS Web Tracking/,
    forwarding: { notFound: /No information, please check your item identifier/ } },
  // The page looks the code up in the browser, keeps it in the search box and calls an unknown one "Óþekkt númer".
  { carrier: 'posturinn', number: 'ZZ000000014IS',
    route: /^https:\/\/(?:www\.)?posturinn\.is\/einstaklingar\/mottaka\/fylgstu-med-sendingunni-thinni\/\?q=ZZ000000014IS$/,
    marker: /Fylgstu með sendingunni þinni|Óþekkt númer/ },
  // The single-page tracker reads the number from the path, keeps it in its field and looks it up.
  { carrier: 'posta-faroe', number: 'RR123456785FO',
    route: /^https:\/\/www\.posta\.fo\/en\/private\/send-receive\/track-trace\/RR123456785FO$/,
    marker: /Track & Trace|Trace & trace number was not found/i },
  // The network's tracker writes the number into its heading, over its notice for an unknown one.
  { carrier: 'skynet-worldwide', number: 'ZZ0000000000',
    route: /^https:\/\/tracking\.skynetexpress\.com\/go\/plm-tracking\?stid=skynet&cn=ZZ0000000000$/,
    marker: /No tracking found for this number|Frontier Force Technology/ },
  // SkyTrack looks the number up as the page opens and renders over Blazor's connection; an unknown
  // one gets the number and NOT FOUND under the search box.
  { carrier: 'skynet-sa', number: 'ZZ0000000000',
    route: /^https:\/\/web\.skynet\.co\.za:5002\/T\?R=ZZ0000000000$/,
    marker: /TRACKING INFORMATION|ZZ0000000000 NOT FOUND/ },
  // The tracker reads the number from the path, prefills its form and looks it up once loaded; an unknown
  // one gets NO TRACKING FOUND under the waybill.
  { carrier: 'ram-hand-to-hand', number: 'RAM00000000',
    route: /^https:\/\/www\.ram\.co\.za\/track\/RAM00000000$/,
    marker: /Enter unique RAM waybill number|NO TRACKING FOUND/ },
  // The path redirects to the page's own route, which looks the number up and says when it does not recognize it.
  { carrier: 'danske-fragtmaend', number: 'ZZ000000',
    route: /^https:\/\/trace\.fragt\.dk\/#\/trackTrace\/ZZ000000$/,
    marker: /no record of the consignment note number|kan ikke genkende fragtbrevsnummeret/ },
  // The booking page heads its answer with the code, over its notice for a code without a booking.
  { carrier: 'fermopoint', number: 'Z0000ZZ000000',
    route: /^https:\/\/www\.fermopoint\.it\/prenotazione\/Z0000ZZ000000$/,
    marker: /non ci risulta essere attivo|Fermoticket n\./ },
  // The tracker keeps the reference in its search box and names it in its notice for an unknown one.
  { carrier: 'citymail', number: 'BCMZZ0000000',
    route: /^https:\/\/tracking\.citymail\.se\/\?search=BCMZZ0000000$/,
    marker: /Ingen spårningsinformation hittades för den angivna referensen|Ange paketreferens nedan/ },
  // The page reads the number from the fragment, looks it up and names it over its notice for an unknown one.
  { carrier: 'bussgods', number: 'BG9000000000',
    route: /^https:\/\/bussgods\.se\/spara-paket\/#BG9000000000$/,
    marker: /Hittade inget resultat för BG9000000000|Sökresultat/ },
  // The page reads the number from its parameter, shows it, looks it up and says when it does not know it.
  { carrier: 'burd-delivery', number: '012345600000000098',
    route: /^https:\/\/burd\.dk\/track\?code=012345600000000098$/,
    marker: /Det indtastede forsendelses nummer findes ikke|Forsendelsesnummer/ },
  // The page looks the number up from its parameter and says when it does not know it.
  { carrier: 'bookurier', number: 'BOK0000000',
    route: /^https:\/\/t\.bookurier\.ro\/\?awb=BOK0000000$/,
    marker: /Situația AWB-ului: BOK0000000|AWB not found/ },
  // The server renders the page; an unknown shipment gets the table with only its not-found heading.
  { carrier: 'toptrans', number: '00000000000',
    route: /^https:\/\/apis\.toptrans\.cz\/tracking\?parcel_number=00000000000$/,
    marker: /Vyhledávání zásilek/,
    forwarding: { notFound: /Zásilka nenalezena/ } },
  // The server renders the page for the number in its path, and only a notice for an unknown one.
  { carrier: 't-group', number: '3010TGR00000000000000',
    route: /^https:\/\/track\.tgroupspa\.com\/ttnet\/traccia_spedizione\/3010TGR00000000000000$/,
    marker: /NUMERO SPEDIZIONE NON TROVATO/,
    forwarding: { notFound: /NUMERO SPEDIZIONE NON TROVATO/ } },
  // The server renders the page and repeats any code it is asked, with an empty card for an unknown one.
  { carrier: 'torrestir', number: 'M0010000A00000000000',
    route: /^https:\/\/tracking\.torrestir\.com\/\?id=M0010000A00000000000$/,
    marker: /Tracking Code:/ },
  // The server renders the page and repeats an unknown number in its not-found notice.
  { carrier: 'intex-paketdienst', number: '0000000-0',
    route: /^https:\/\/www\.intex-paketdienst\.de\/sendungsstatus\/index\.php\?sdnr=0000000-0&mid=1$/,
    marker: /konnte nicht ermittelt werden/ },
  // The page looks the number up from its path and answers an unknown one with a notice that does not repeat it.
  { carrier: 'messenger-cz', number: 'ZZZZ0000',
    route: /^https:\/\/tracking\.messenger\.cz\/ZZZZ0000$/,
    marker: /Zásilku se nám nepodařilo vyhledat/,
    forwarding: { notFound: /Zásilku se nám nepodařilo vyhledat/ } },
  // The page looks the number up from its query, keeps it in its search box and says when it does not know it.
  { carrier: 'go4', number: '20000000000',
    route: /^https:\/\/zona\.go4\.eu\/status\/\?parcelId=20000000000$/,
    marker: /Zásielka sa nenašla/ },
  // The page looks the barcode up from its path, keeps it in its search box and says when it does not know it.
  { carrier: 'nox', number: '220000000000000101000000',
    route: /^https:\/\/trackandtrace\.app\.nox\.express\/scannungen\/220000000000000101000000$/,
    marker: /Der von Ihnen angegebene Barcode ist uns nicht bekannt|Behalten Sie mit Track & Trace Ihre Sendungen im Blick/ },
  // The server renders the page; its heading names the number over the notice for an unknown one.
  { carrier: 'logoix', number: 'LIX9000000003',
    route: /^https:\/\/www\.logoix\.com\/cgi-bin\/tnt\.pl\?q=LIX9000000003$/,
    marker: /Verlauf der Sendung LIX9000000003|unbekannte Sendungsnummer/ },
  // The server renders the page for the number in its query; an unknown one gets a row without it.
  { carrier: 'a1-post', number: 'A10000000000',
    route: /^https:\/\/a1post\.bg\/track\.php\?t=A10000000000$/,
    marker: /Package not found|Track at partner website/,
    forwarding: { notFound: /Package not found/ } },
  // The server renders the page for the number in its query; its heading names an unknown one over the notice.
  { carrier: 'eparcel-kr', number: 'EXX000000000KR',
    route: /^https:\/\/www\.eparcel\.kr\/Track\/Result\?mode=0&ids=EXX000000000KR&lang=en-US$/,
    marker: /Registration Number : EXX000000000KR|No data\./ },
  // The tracker answers a number it has no record of with a bare notice instead of its page.
  { carrier: 'exmate', number: 'EXK00000000J',
    route: /^https:\/\/pod\.exmate\.net\/pod\/\?exmno=EXK00000000J$/,
    marker: /No Data!!|Tracking Visibility/,
    forwarding: { notFound: /No Data!!/ } },
  // The server renders the page for the receipt number in its query; an unknown one gets only its notice.
  { carrier: 'gsi-express', number: '0000000',
    route: /^https:\/\/www\.gsiexpress\.com\/track_pop\.php\?textfield=0000000&track_type=invoice_no$/,
    marker: /해당 데이타가 존재하지 않습니다|GSI 접수번호/,
    forwarding: { notFound: /해당 데이타가 존재하지 않습니다/ } },
  // The page looks the number up from its path, shows it under the shipping details and has no
  // not-found answer: an unknown one gets its notice that it cannot retrieve tracking.
  { carrier: 'pitney-bowes', number: 'UPAAA000000000000000',
    route: /^https:\/\/trackpb\.shipment\.co\/track\/UPAAA000000000000000$/,
    marker: /We are unable to retrieve tracking information at this time|Shipping Info/ },
  // SmartTrack shows only its notice for a number it has no parcel for, without the number.
  { carrier: 'one-world-express', number: 'OWE000000000000',
    route: /^https:\/\/www\.smarttrack\.co\/tracking\.php\?tracking_number=OWE000000000000$/,
    marker: /No Tracking available|Tracking Events/,
    forwarding: { notFound: /No Tracking available/ } },
  // The page fills its field with the number in its path, asks the tracker's lookup and answers an
  // unknown number with its notice in place of the scans.
  { carrier: 'pdn-express', number: 'PDN0000000000',
    route: /^https:\/\/pdn\.express\/en\/track\/PDN0000000000\/?$/,
    marker: /No parcel found for that number|Parcel details/i },
  // The tracker names an unknown number in its notice above the search form.
  { carrier: 'pro-carrier', number: 'DG00000000000',
    route: /^https:\/\/tracking\.weareprocarrier\.com\/\?tn=DG00000000000$/,
    marker: /Shipment not found|Shipment History/ },
  { carrier: 'pfc-express', number: 'R1000002912230003',
    route: /^https:\/\/www\.pfctrack\.com\/\?nums=R1000002912230003(?:,|%2C)?$/,
    marker: /Not Found|Powered by PFCEXPRESS/ },
  // The server looks the numbers in the query up and names an unknown one in its notice.
  { carrier: 'seko', number: 'ZZ0000000000',
    route: /^https:\/\/www\.sekologistics\.com\/en\/track\/\?trackingNumbers=ZZ0000000000$/,
    marker: /No results found for tracking number|Enter up to 30 tracking numbers/i },
  // The page on tdn.es forwards the number to the tracker on plain HTTP a moment after it loads,
  // so the route takes both. The tracker's heading names the number over its notice for an
  // unregistered one.
  { carrier: 'tdn', number: '999916276898',
    route: /^(?:https:\/\/www\.tdn\.es\/tracking\/?\?envio=999916276898&autoredir=1|http:\/\/tracking\.tdnonline\.com\/consulta_expediciones\/tracking\?REFERENCIA=999916276898&Aceptar=Aceptar)$/,
    marker: /Envío no registrado|Entregado|En reparto/ },
  // The page fills its field with the number in the address, asks Teleship's API and answers an
  // unknown number with its notice in place of the shipment.
  { carrier: 'teleship', number: 'TSGBUS000000000000000',
    route: /^https:\/\/teleship\.com\/tracking\?number=TSGBUS000000000000000$/,
    marker: /We could not find a parcel with this tracking ID|Teleship Tracking Number/ },
  // The server looks the AWB number in the query up and shows it over the consignment. The
  // all-zeros number holds a record of its own on this tracker.
  { carrier: 'tmm-express', number: '0000000000',
    route: /^https:\/\/ukr\.tmm-express\.com\/en\/trackparcels\?num=0000000000&mark=is_code$/,
    marker: /Common information|Detailed information/ },
  // The server looks the AWB number in the query up. An unknown one gets the page's notice,
  // which does not repeat it.
  { carrier: 'dragon-star-curier', number: '00000000',
    route: /^https:\/\/dragonstarcurier\.ro\/tracking-awb\?awb=00000000$/,
    marker: /VERIFICARE AWB|Codul AWB introdus este invalid/,
    forwarding: { notFound: /Codul AWB introdus este invalid/ } },
  // The page reads the number from its address on load and shows it over the answer.
  { carrier: 'xlcourier', number: 'XLC00000000000',
    route: /^https:\/\/www\.xlcourier\.com\/trackOrder\?number=XLC00000000000$/,
    marker: /We couldn't find any package with the tracking number you provided|Tracking Number/ },
  // The page checks the device, moves a desktop to its `tracking` route and renders over Blazor's
  // connection; an unknown number gets the sentence in place of the shipment.
  { carrier: 'transaher', number: '103000000000000000000000000',
    route: /^https:\/\/clientes\.transaher\.es\/webclient\/h?tracking\/-5,0,103000000000000000000000000$/,
    marker: /No se ha encontrado la expedición indicada/i,
    forwarding: { notFound: /No se ha encontrado la expedición indicada/i } },
  // The server looks the reference up while it renders; an unknown one gets the backend's message under the form.
  { carrier: 'transcorp', number: '0000000000',
    route: /^https:\/\/app\.elite-co\.com\/shipments\/track\?references=0000000000$/,
    marker: /shipment with reference 0000000000 does not exist|Please enter your tracking number or reference/ },
  // The server looks the reference in the path up; an unknown one gets the notice in place of the shipment.
  { carrier: 'norsk-global', number: 'PKG000000000000',
    route: /^https:\/\/norsk\.trackmyparcel\.info\/gb\/tracking\/PKG000000000000$/,
    marker: /Nothing found using that tracking number|HAWB/,
    forwarding: { notFound: /Nothing found using that tracking number/ } },
  // The page's script prefills the waybill from the address and looks it up; an unknown one gets the notice.
  { carrier: 'evropat', number: '00000000000000',
    route: /^https:\/\/evropat\.bg\/track\/\?barcode=00000000000000$/,
    marker: /Няма намерена пратка с този номер|Проследяване на пратка/ },
  // The page prefills its search box from the address and asks Exelot's lookup; an unknown number gets the notice.
  { carrier: 'exelot', number: 'XLT000000000',
    route: /^https:\/\/go\.exelot\.com\/tracking\?barcodes=XLT000000000$/,
    marker: /We couldn.t find this shipment|Track your shipment|לא הצלחנו למצוא את המשלוח/ },
  // The server looks the number in the path up while it renders; one it has nothing for gets the notice.
  { carrier: 'apc-postal-logistics', number: '00000P0000000000000000',
    route: /^https:\/\/tracking\.apc-pli\.com\/00000P0000000000000000$/,
    marker: /Package Not Found|Track a Package/,
    forwarding: { notFound: /The package you are trying to track could not be found/ } },
  // The page prefills its search box from the address and asks Next Level's lookup; the number heads the answer.
  { carrier: 'next-level-delivery', number: '0000000000000',
    route: /^https:\/\/nextlevel\.delivery\/track\?awb=0000000000000$/,
    marker: /Waybill #: 0000000000000|SHIPMENTS TRACKING/i },
  // The page shows the waybill from the address and its script looks it up; an unknown one gets an alert.
  { carrier: 'kyoungdong', number: '0000000000000',
    route: /^https:\/\/kdexp\.com\/service\/delivery\/etc\/delivery\.do\?barcode=0000000000000$/,
    marker: /검색정보|기본정보/ },
  // The page puts the number from its address in its search box and looks it up on load; an unknown one gets a notice.
  { carrier: 'l-post', number: 'ABC00000000',
    route: /^https:\/\/l-post\.ru\/tracking\?id=ABC00000000$/,
    marker: /Не удалось найти заказ|История отправления|Статус доставки/ },
  // The page puts the number from its address in its search box and looks it up on load; an unknown one gets a notice.
  { carrier: 'zajil', number: '00000000000',
    route: /^https:\/\/zajil-express\.com\/track\?tracking_id=00000000000$/,
    marker: /No Shipment Found|Shipment Summary/ },
  // The tracker looks up the number in its address as it is served; an unknown one gets the empty form and a notice.
  { carrier: 'hunter-express', number: 'ZZZ000000',
    route: /^https:\/\/portal\.hunterexpress\.com\.au\/Track\/55010\/ZZZ000000$/,
    marker: /Missing or incorrect tracking number|Consignment Details/,
    forwarding: { notFound: /Missing or incorrect tracking number/ } },
  // Quick Track puts the number from its address in its field and looks it up on load.
  { carrier: 'border-express', number: '00000000',
    route: /^https:\/\/bexonline\.borderexpress\.com\.au\/bxo\/track\?consignmentNumber=00000000$/,
    marker: /Quick Track|We could not find your consignment/ },
  // The tracker looks up the number in its address as it is served and shows it in a read-only field over the statuses or an unknown one's notice.
  { carrier: 'quicksilver-sa', number: 'QS000000000',
    route: /^https:\/\/erp\.quick-silver\.express\/v2\/tracking\/QS000000000$/,
    marker: /Tracking number not found|Place an order|Ready For Dispatch|Out For Delivery/ },
  // The tracker looks up the order number in its address on load and answers an unknown one with a notice without the number.
  { carrier: 'quiqup', number: '0000000',
    route: /^https:\/\/track-parcel\.quiqup\.com\/0000000$/,
    marker: /We can't seem to find this shipment in our system|Order status: #/,
    forwarding: { notFound: /We can't seem to find this shipment in our system/ } },
  // The tracker looks up the number in its address as it stands and answers an unknown one with its own notice.
  { carrier: 'gogo-xpress', number: 'ZXQA-0000-0009',
    route: /^https:\/\/app\.gogoxpress\.com\/track\/ZXQA-0000-0009$/,
    marker: /Track your package|Check your Tracking Number and try again/i },
  // The home page puts `tn` into its field, looks it up and answers an unknown number with its own notice.
  { carrier: 'xde-logistics', number: 'X0000000000',
    route: /^https:\/\/www\.xde\.com\.ph\/\?tn=X0000000000$/,
    marker: /We could not find your package|Track your package/ },
  // The page puts the ID in its address into its field, looks it up and answers an unknown one with its own notice.
  { carrier: 'fargo-uz', number: 'TEZ000000',
    route: /^https:\/\/fargo\.uz\/track\?id=TEZ000000$/,
    marker: /We could not find that order|Track ID or order number/ },
  // The server looks up the number in the address and shows it in an unknown one's notice. A browser in
  // English or Arabic is sent to that language's page with the same number.
  { carrier: 'zr-express', number: '00-000000-ZR',
    route: /^https:\/\/www\.zrexpress\.net\/(?:suivi|en\/track|ar\/suivi)\?tn=00-000000-ZR$/,
    marker: /Aucun colis ne correspond à ce numéro/ },
  // The tracker renders the barcode in its address on the server; an unknown one gets a notice naming it.
  { carrier: 'united-delivery-service', number: '00UDS00000000000',
    route: /^https:\/\/www\.uniteddeliveryservice\.com\/track\/barcode\/00UDS00000000000$/,
    marker: /Barcode (?:00UDS00000000000 )?Not Found|Delivery Status/ },
  // The page looks up the number in its address and answers an unknown one with its own notice.
  { carrier: 'skyking', number: '999999999',
    route: /^https:\/\/skyking\.co\/track\?cno=999999999$/,
    marker: /No Tracking Information Available/ },
  // The page looks up the number in its address and shows it under its package details, found or not.
  { carrier: 'tracx-logis', number: 'QSP000000001',
    route: /^https:\/\/www\.tracxlogis\.com\/tracking\?trackingNo=QSP000000001$/,
    marker: /Tracking Parcel|Package Info/ },
  // The search page sends the number in its address to the tracker's summary lookup and lists it with the notice for an unknown one.
  { carrier: 'airpak-express', number: '999999999990',
    route: /^https:\/\/tracking\.airpak-express\.com\/go\/plm-tracking_search\?stid=airpak&cn=999999999990$/,
    marker: /No tracking available|Track & Trace/ },
  // The page puts the number in its address into its field, looks it up and answers an unknown one with its own notice.
  // The page's styles show its notices in capitals.
  { carrier: 'chronodiali', number: 'CHPU0000000000000000000',
    route: /^https:\/\/chronodiali\.ma\/suivi_colis\.html\?id=CHPU0000000000000000000$/,
    marker: /Veuillez v[ée]rifier votre tracking id|Informations colis/i },
  // The page puts the number in its address into its field and looks it up.
  { carrier: 'gaash', number: 'GWD000000000',
    route: /^https:\/\/gaashwd\.com\/track-parcel\/\?TrackingNumber=GWD000000000$/,
    marker: /We could not find your parcel|Track Your Parcel/ },
  // The page fills its search field in from the address and looks the number up; a browser in another
  // language is sent to that language's page with the same number.
  { carrier: 'starex-az', number: 'STRAZ000000000000',
    route: /^https:\/\/starexglobal\.com\/(?:az|en|ru)\/tracking\/STRAZ000000000000$/,
    marker: /Bağlamalarınızı buradan izləyə bilərsiniz|You can follow your parcels from here|Здесь вы можете следить за своими посылками/ },
  // The page fills its search box in from the address and looks the number up.
  { carrier: 'anserx', number: 'BTYCN0000000000YQ',
    route: /^https:\/\/oms\.anserx\.com\/tracking\?nos=BTYCN0000000000YQ$/,
    marker: /查看英文轨迹|轨迹说明/ },
  // The page looks up the number in its address on load; an unknown one gets a notice.
  { carrier: 'chukou1', number: 'SUF991231ZZZZ0000000',
    route: /^https:\/\/ec\.chukou1\.com\/track\?track_number=SUF991231ZZZZ0000000$/,
    marker: /This number can.t be found at this moment|Global Shipment Tracking Platform/ },
  // The page looks up the number in its address and sends an unknown one back to its search page with a notice.
  { carrier: 'gobolt', number: '000000000000',
    route: /^https:\/\/track\.gobolt\.com\/tracking(?:\/000000000000)?$/,
    marker: /Track your shipment in real time|couldn.t find that tracking number|Suivez votre envoi en temps r[ée]el/ },
  // The track-and-trace page fills the number into its form and frames the GETOnline search page with it.
  { carrier: 'dpex', number: '999999999994',
    route: /^https:\/\/dpex\.com\/track-and-trace\/\?cn=999999999994$/,
    marker: /assist you in tracking your shipment/ },
  // The page fills its search field in from the address and looks the number up.
  { carrier: 'skypostal', number: 'SKAMZUS0000000000',
    route: /^https:\/\/tracking\.skypostal\.com\/\?trck_number=SKAMZUS0000000000&lng_code=ENG$/,
    marker: /Choose to track one package or multiple packages|No records to display/ },
  // The tracker looks up the air waybill in its address and puts it in its search field.
  { carrier: 'sagawa-global', number: '100000000004',
    route: /^https:\/\/tracking\.sagawa-sgx\.com\/sgx\/trackeng\.asp\?ENC=JPN&CAT=AWB&AWB=100000000004$/,
    marker: /Sagawa Global Tracking|No Record\./ },
  // The page's script posts the number from the address and clears it when TFM Express does not know it.
  { carrier: 'tfm-express', number: '000000000000',
    route: /^https:\/\/customer\.tfmex\.com\/Skybill\/TrackSkybill(?:\?awb=000000000000)?$/,
    marker: /BY AWB NUMBER|Shipment Not Found|Where Your Shipment Has Been/,
    forwarding: { notFound: /Shipment Not Found/ } },
  // The page looks up the number in its address and names an unknown one in its notice.
  { carrier: 'estes-forwarding', number: '0000000',
    route: /^https:\/\/efwtrack\.com\/track\/0000000$/,
    marker: /was not found\. Please verify the number or contact our Control Tower|EFW Tracking/ },
  // The page fills its field in from the address and looks the number up; an unknown one
  // gets an empty card under the number.
  { carrier: 'shree-anjani', number: '9000000001',
    route: /^https:\/\/shreeanjani\.co\.in\/tracking\/\?awb=9000000001$/,
    marker: /Enter your 10-digit docket number to track/ },
  // CloudFront serves the tracker's app with HTTP 404 for every order, known or not. The app looks up the
  // number in its address and shows it as the order ID over empty parcel details when it has no order.
  { carrier: 'paperfly', number: '010125-0000-A1-A1',
    route: /^https:\/\/go\.paperfly\.com\.bd\/track\/order\/010125-0000-A1-A1$/,
    marker: /Share Tracking Details|Parcel Details/,
    shipmentNotFound: { status: 404, marker: /Share Tracking Details/ } },
  // The page looks up the number in its address and answers an unknown one with a notice.
  { carrier: 'line-clear', number: 'V000000000000000',
    route: /^https:\/\/www\.lineclearexpress\.com\/tracker\?id=V000000000000000$/,
    marker: /TRACK & TRACE|Item Not Found!/ },
  // The page looks the number in its address up on the server and lists it with its status.
  { carrier: 'ics-courier', number: 'ND000000000000A0A0A0',
    route: /^https:\/\/www\.icscourier\.ca\/online-services\/parcel-tracking\.aspx\?trackNums=ND000000000000A0A0A0$/,
    marker: /Enter up to 25 tracking numbers|Tracking Number\s+Last Updated/ },
  // The page fills its search field in from the address and answers an unknown number with a notice.
  { carrier: 'fleetoptics', number: 'FOAESH0000000',
    route: /^https:\/\/track\.fleetopticsinc\.com\/\?tracking_number=FOAESH0000000$/,
    marker: /Tracking number not found|Tracking History|Enter Your Tracking Number/ },
  // The page looks up the order number in its address and names it in its not-found error.
  { carrier: 'apple-express', number: '00000000',
    route: /^https:\/\/track\.appleexpress\.com\/orderNumber\/00000000$/,
    marker: /Could not find order: 00000000|There was an error with your request/ },
  // The page looks up the AWB in its address and answers an unknown one with BLANK in place of its status.
  { carrier: 'pcp-express', number: 'ZZZZZZB1000101Z00000',
    route: /^https:\/\/pcpexpress\.com\/lacak_detailv2\.php\?awb=ZZZZZZB1000101Z00000$/,
    marker: /Riwayat Pengiriman|Rincian Pengiriman/, forwarding: { notFound: /\bBLANK\b/ } },
  // The tracker looks up the number in its address on load and answers an unknown one with "Not Found", without the number.
  { carrier: 'northline', number: '1ABC00000000',
    route: /^https:\/\/track\.northline\.com\.au\/status\/1ABC00000000$/,
    marker: /Track another\s+consignment/i,
    forwarding: { notFound: /Not Found\s+Track another\s+consignment/i } },
  // The server renders the lookup; its notice for an unknown number leaves the number to the page's title.
  { carrier: 'straightship', number: 'STRTD000000000',
    route: /^https:\/\/www\.straightship\.com\/track-your-shipment\/tracking-id\/STRTD000000000\/$/,
    marker: /Canada B2C Shipment Tracking|No results found/,
    forwarding: { notFound: /No results found!/ } },
  // The page looks the number in its address up, keeps it in the field and answers an unknown one with a notice.
  { carrier: 'bringer-parcel', number: 'BPS000000000000',
    route: /^https:\/\/www\.bringerparcel\.com\/tracking\/BPS000000000000$/,
    marker: /BPX Tracking|We couldn't find any shipment with that tracking number/ },
  // The page looks the number in its address up and shows an unknown one as a parcel without events.
  { carrier: 'parcelpoint', number: '1234567890123',
    route: /^https:\/\/parcelpoint\.com\.au\/track-your-parcel\/\?trackingnumber=1234567890123$/,
    marker: /No tracking events available yet|Tracking number 1234567890123 was not found/ },
  // The page looks up the number in its address and answers an unknown one with "Shipment Not Found".
  { carrier: 'gta-airskip', number: 'GRG0000000000000000',
    route: /^https:\/\/gtaairskip\.com\/tracking\/\?trackingid=GRG0000000000000000$/,
    marker: /Shipment Not Found|Track a Package/i },
  // The tracing page looks the PRO number in its address up and answers an unknown one on its
  // search form, with a notice and the number in the first field.
  { carrier: 'pitt-ohio', number: '9999999999',
    route: /^https:\/\/pittohio\.com\/myPittOhio\/Shipping\/LTL\/TraceRequest\?pro=9999999999$/,
    marker: /Search returned no results|LTL Shipment Status Details/ },
  // The tracking page renders the air waybill in its address on the server; its notice for an unknown one names no number.
  { carrier: 'icc-worldwide', number: '99999999999',
    route: /^https:\/\/www\.iccworld\.com\/track-result\.php\?track_no=99999999999$/,
    marker: /Record not found|Detailed Report/i, forwarding: { notFound: /Record not found/i } },
  // The tracker's script reads the AWB number from its address, fills it in, looks it up and shows
  // its message for an unknown one under the form.
  { carrier: 'grand-slam-express', number: '000000000',
    route: /^https:\/\/www\.grandslamexpress\.in\/Web\/Track\?AwbNo=000000000$/,
    marker: /Please enter valid AWB number|Tracking History/ },
  // Atlantic's site builds an address for one air waybill, but its tracking page reads no number
  // from the address and opens its empty form.
  { carrier: 'atlantic-courier', number: '0000000000',
    route: /^https:\/\/atlanticcourier\.net\/track\/0000000000\/?$/,
    marker: /Track your shipment|Enter Your Tracking Number/i, forwarding: 'none' },
  // The tracker looks up the document number in its address on the server and answers an unknown
  // one with its notice, the number left in its field.
  { carrier: 'maruti-air', number: '99999999',
    route: /^https:\/\/erp\.marutiair\.com\/TrackpageWeb\/WebAWBTracking\.aspx\?AWB=99999999$/,
    marker: /DETAIL NOT FOUND|Awb Tracking/i },
  // The visibility portal looks up the number in its address on the server and answers an unknown one with a notice naming it.
  { carrier: 'prompt-xpress', number: 'RP00000000',
    route: /^https:\/\/web\.promptxpress\.lk\/PublicTracking\/TrackingStatus\?trackingNo=RP00000000$/,
    marker: /No tracking data was found for|Tracking & Visibility Portal/ },
  // The portal opens a tab for the number in its address and loads its answer, an alert for an unknown PRO.
  { carrier: 'roadrunner', number: '999999999',
    route: /^https:\/\/tools\.rrts\.com\/LTLTrack\/\?searchValues=999999999$/,
    marker: /Invalid PRO number|Travel History/ },
  // The page fills its search field in from the address and looks the number up on load; it shows no notice for an unknown one.
  { carrier: 'followmont', number: '0000000',
    route: /^https:\/\/www\.followmont\.com\.au\/\?(?=.*\bconsignmentNumber=0000000\b)(?=.*\btrack-trace-start-unsecured-user\b)/,
    marker: /Search for your freight using the search box below/ },
  // The page looks the number in its address up and shows the lookup's answer for an unknown one.
  { carrier: 'mailplus-au', number: 'MPX000000000',
    route: /^https:\/\/track\.mailplus\.com\.au\/MPX000000000$/,
    marker: /Add your tracking ID|There are no results for this tracking/ },
  // The page looks the number in its address up and answers an unknown one with "No shipment found for" and the number.
  { carrier: 'precision-deliveries', number: 'ASL0000000000',
    route: /^https:\/\/track\.precisiondeliveries\.com\/ASL0000000000$/,
    marker: /No shipment found for "ASL0000000000"|No Shipment Found/ },
  // The quick trace page renders the PRO in its address on the server, keeps it in hidden fields
  // and answers an unknown one with its support notice.
  { carrier: 'oak-harbor', number: '99999999',
    route: /^https:\/\/www\.oakh\.com\/quicktrace&PRO=99999999$/,
    marker: /There was an issue tracking your shipment|Pro Not Found|Pro Information/ },
  // The page looks up the number in its address and answers an unknown one with its own 404 page.
  { carrier: 'qwintry', number: 'QR00000000',
    route: /^https:\/\/logistics\.qwintry\.com\/track\?tracking=QR00000000$/,
    marker: /This tracking does not exist|Tracking log/,
    shipmentNotFound: { status: 404, marker: /This tracking does not exist/ }, forwarding: { notFound: /This tracking does not exist/ } },
  // The page fills the number in its address into its form and looks it up; an unknown one is "Invalid Tracking Code".
  { carrier: 'domain-logistics', number: '000000000000',
    route: /^https:\/\/domainlogistics\.ca\/tracking\/\?tracking=000000000000$/,
    marker: /Invalid Tracking Code|Please enter your tracking number as received upon confirmation of shipment/ },
  // The history page fills its search field in with the number and answers for it.
  { carrier: 'ocs-ana', number: '100000000015',
    route: /^https:\/\/webcsw\.ocs\.co\.jp\/csw\/ECSWG0201R00003P\.do\?cwbno=100000000015$/,
    marker: /Air Waybill(?: No\.|番号)/ },
  // The page looks up the waybill in its address, keeps it in the field and answers an unknown one with a notice.
  // Nine digits are far past the waybills Collivery has issued.
  { carrier: 'mds-collivery', number: '900000003',
    route: /^https:\/\/collivery\.net\/tracking\?waybill=900000003$/,
    marker: /Track Your\s+Parcel|couldn.t find a parcel with that number/i },
  // The page looks up the number in its address on the server, keeps it in the field and answers an unknown one with a notice.
  { carrier: 'mauritius-post', number: 'RR000000005MU',
    route: /^https:\/\/www\.mauritiuspost\.mu\/track-trace\/\?tracking_code=RR000000005MU$/,
    marker: /No tracking information available for this item|Days in Transit/ },
  // The page looks the number up on load and answers an unknown one with a dialog,
  // which sends the browser back only once it is closed.
  { carrier: 'ilyang-logis', number: '0000000000',
    route: /^https:\/\/www\.ilyanglogis\.co\.kr\/page\/TrackingResult\.do\?trackingType=0&blNum=0000000000$/,
    marker: /해당 정보가 없습니다/ },
  // The page looks the number in its address up, repeats it in its search field and answers an unknown one with a notice.
  { carrier: 'midland-transport', number: '0000000000000000',
    route: /^https:\/\/ship\.midlandtransport\.com\/Tracking\/TrackClientTrackings\?TrackingNumber=0000000000000000&Lang=0$/,
    marker: /The shipment number does not exist|Travel History/ },
  // The quick track looks the number in its address up and answers an unknown one with a notice naming it.
  { carrier: 'maritime-ontario', number: 'F0000000',
    route: /^https:\/\/www\.m-o\.com\/quick-track-form\/\?t=F0000000$/,
    marker: /We couldn.t find a shipment matching|Track Your Shipment/ },
  // The FastNet page looks the probill in its address up on the server and answers an unknown one
  // with its notice, without the number.
  { carrier: 'fastfrate', number: '0000000000',
    route: /^https:\/\/apps\.fastfrate\.com\/fastnet\/FastNet\.aspx\?ProbillNo=0000000000$/,
    marker: /Fastfrate Quick Probill Tracking/,
    forwarding: { notFound: /Probill (?:Number )?not found/ } },
  // The server looks up the number in its address and answers an unknown one with HTTP 404 and
  // its not-found notice, which does not repeat the number.
  { carrier: 'hovership', number: 'ZZ00000000ZZ',
    route: /^https:\/\/www\.hovership\.com\/track\/ZZ00000000ZZ\/$/,
    marker: /Tracking number not found|Tracking history/,
    shipmentNotFound: { status: 404, marker: /We couldn.t find a shipment for that tracking number/ },
    forwarding: { notFound: /Tracking number not found/i } },
  // The server renders the lookup; its answer to an unknown number clears the search field.
  { carrier: 'mrl-global', number: 'CAAA000000',
    route: /^https:\/\/www\.mrlglobal\.com\/tracking\/\?connoteno=CAAA000000$/,
    marker: /Invalid Connote number|Tracking history/i,
    forwarding: { notFound: /Error : Invalid Connote number/ } },
  // The page looks up the AWB in its address on the server and names an unknown one in its notice.
  { carrier: 'makati-express', number: 'DXB0000000',
    route: /^https:\/\/makati-express\.com\/tracking\/\?awbnumber=DXB0000000$/,
    marker: /Data not found \/ its not updated in the server|Shipment Progress of AWB No\./ },
  // The server renders the lookup for the ODT in the address and names an unknown one in its notice.
  { carrier: 'pullman-cargo', number: '00000000000',
    route: /^https:\/\/pullmancargo\.cl\/seguimiento\/00000000000$/,
    marker: /ODT no encontrada|Historial de Movimientos/ },
  // The server renders the lookup for the guía in the address, repeats it in the history's
  // heading and answers an unknown one with a notice.
  { carrier: 'aex-paraguay', number: 'A000000000',
    route: /^https:\/\/www\.aex\.com\.py\/web\/tracking\.php\?guia=A000000000$/,
    marker: /No se encuentra el número de seguimiento que ingresaste|Historial de eventos/ },
  // The server renders the lookup; its answer to an unknown number leaves the number and recipient blank.
  { carrier: 'aci-express-kr', number: '000000000000',
    route: /^https:\/\/www\.acieshop\.com\/pod\.php\?OrderNo=000000000000$/,
    marker: /Track Shipments Detailed Results/,
    forwarding: { notFound: /Tracking Number\s*받는 사람\s*\*/ } },
  // The page's script looks up the number in its address on load and names an unknown one beside the not-found notice.
  { carrier: 'morning-global', number: 'BR000000000MG',
    route: /^https:\/\/www\.morninglobal\.com\/trace-track\/\?tracking_number=BR000000000MG$/,
    marker: /No shipment record was found for this tracking number|Shipment Journey/ },
  // The page prefills its box with the number and its script looks it up on load.
  { carrier: 'pcs-logistics-vn', number: '000000000000000',
    route: /^https:\/\/pcs-logistics\.com\/en\/track-trace\?code=000000000000000$/,
    marker: /Up to 25 tracking number, one per line|What is a PCS tracking number\?/ },
  // The server renders the lookup; its answer to an unknown waybill keeps the number in the search box.
  { carrier: 'domex', number: '00000000',
    route: /^https:\/\/domex\.lk\/Order-Details\.php\?wbno=00000000$/,
    marker: /Record Not Found!|WAYBILL INFORMATION/ },
  // I-Trek searches the number as a pro number; its notice for an unknown one leaves the field empty.
  { carrier: 'american-west-express', number: 'ZZ0000000',
    route: /^https:\/\/awest\.freightgate\.com\/cgi-bin\/tarifftrek5\.1\/itrek\.cgi\?database=awest&type=submit&/,
    marker: /Tracking Lookup will only find shipments picked up within the past 90 days/,
    forwarding: { notFound: /no records found matching your criteria/ } },
  // The server looks up the code in the address and keeps it in the field over an unknown one's notice.
  { carrier: 'upaya', number: 'QQQQQQ00000-0000000',
    route: /^https:\/\/upaya\.com\.np\/track\/\?tracking=QQQQQQ00000-0000000$/,
    marker: /No order found for this tracking code|Track your order/ },
  // The page fills its search field in from the address and answers an unknown number under it.
  { carrier: 'gtl-goto', number: 'GTL0000000001',
    route: /^https:\/\/gtl\.id\/tracking\?tracking_number=GTL0000000001$/,
    marker: /Input Your Tracking Number|Package not found|shipment not found/i },
  // The page looks up the number in its address and answers an unknown one with "Invalid Consignment No.".
  { carrier: 'gms-worldwide', number: '000000009',
    route: /^https:\/\/www\.gmsworldwide\.com\/shipment-tracking\/\?tracking_no=000000009&tracking_type=cnno$/,
    marker: /Invalid (?:Consignment|Tracking) No\.|Shipment Number/ },
  // The page writes the number into its search field and looks it up on load; an unknown one gets "Заказ не найден".
  { carrier: 'kit-tk', number: '0000000009',
    route: /^https:\/\/tk-kit\.ru\/tracking\?track_code=0000000009$/,
    marker: /Отслеживание груза|Заказ не найден/ },
  // The page fills its field in from the address; the lookup waits for a captcha.
  { carrier: 'flippost', number: '00-0000009',
    route: /^https:\/\/flippost\.com\/instruments\/online\/\?number=00-0000009$/,
    marker: /Отследить отправление|Введите код для отслеживания/ },
  // The page looks up the number in its address on load and answers an unknown one with "Проверьте корректность номера заказа.".
  { carrier: 'vozovoz', number: '100000000',
    route: /^https:\/\/vozovoz\.ru\/order\/manage\/\?id=100000000$/,
    marker: /Управление заказом|Проверьте корректность номера заказа/ },
  // The page looks up the guía in its address on load and answers an unknown one with "La guía ingresada no existe".
  { carrier: 'guatex', number: 'A0000X00000',
    route: /^https:\/\/servicios\.guatex\.gt\/Guatex\/RastreoTracking\?tipo=G&dato=A0000X00000$/,
    marker: /¿Por dónde va|Consultar el estado de tu envío/ },
  // The page looks up the number in `?q=` on load and lists an unknown one as Not Found.
  { carrier: 'shouwu', number: 'SWECN000000000001YQ',
    route: /^https:\/\/admin\.shshouwu\.com\/track\.html\?q=SWECN000000000001YQ$/,
    marker: /守务国际包裹追踪|We seem can't identify the number/ },
  // The small-parcel tracker writes the number in `?track_number=` into its query box as it serves the page.
  { carrier: 'yfhex', number: 'ZZ0000000000',
    route: /^https:\/\/toms\.yfhex\.com:6055\/track_query_c\.aspx\?track_number=ZZ0000000000$/,
    marker: /专线及小包查询|Parcel \/ Line Query/ },
  // The page fills its form with `?number=` and says when it has no such parcel.
  { carrier: 'timely-titan', number: 'TT2600000000017CN',
    route: /^https:\/\/timelytitan\.com\/tracking\.html\?number=TT2600000000017CN$/,
    marker: /tracking not found|TimelyTitan All rights reserved/ },
  // The tracking page serves the parcel at its number's address and says when it has none.
  { carrier: 'starlinks-global', number: 'ASO1004GB04198255001',
    route: /^https:\/\/starlinks\.app\/track\/ASO1004GB04198255001$/,
    marker: /Shipment History|Parcel not found/ },
  { carrier: 'mhi', number: 'MHI154W100134524859',
    route: /^https:\/\/www\.trackmail\.co\.uk\/\?Tracking=MHI154W100134524859&command=Track$/,
    marker: /Tracking History|No details found for Tracking Code/ },
  { carrier: 'e-commerce-international', number: 'PL15132382072UA',
    route: /^https:\/\/ecommerce-system\.com\/track\/PL15132382072UA$/,
    marker: /Śledzenie przesyłki|Shipment tracking/ },
  { carrier: 'boxtal', number: '2301136016MONRW3S7FR',
    route: /^https:\/\/shipping\.boxtal\.com\/fr\/fr\/suivi\/suivre-mon-envoi\?reference=2301136016MONRW3S7FR$/,
    marker: /Livré|En cours d'acheminement|Delivered|In transit/ },
  { carrier: 'quick-rabbit', number: 'PKG00620251019000305561',
    route: /^https:\/\/web\.quickrabbit\.es\/es\/tracking\?ref=PKG00620251019000305561$/,
    marker: /Devuelto al Remitente|Returned to Sender/ },
  { carrier: 'pactic', number: 'C0001260302091512000017',
    route: /^https:\/\/dashboard\.pactic\.com\/tracking\?waybill=C0001260302091512000017$/,
    marker: /No such tracking ID can be found in our system|Eine solche Sendungsnummer ist in unserem System nicht vorhanden/ },
  // The page looks the number up from its script and says when it finds no shipment.
  { carrier: 'optima-overnight', number: 'P00000000000017',
    route: /^https:\/\/www\.shipoptima\.com\/pages\/tracking\?tracking=P00000000000017$/,
    marker: /No shipment found for tracking number/ },
  // The server renders the parcel's scans, or says it does not recognise the number, with HTTP 200.
  { carrier: 'ukp-worldwide', number: 'WHISU990000001',
    route: /^https:\/\/www\.ukpworldwide\.com\/tracking\/\?x=WHISU990000001$/,
    marker: /Nothing found|Tracking results/,
    forwarding: { notFound: /Nothing found/ } },
  // The server renders the shipment, or says it found none under the number its search field repeats, with HTTP 200.
  { carrier: 'safeway-express-cargo', number: 'BH99000025',
    route: /^https:\/\/www\.safewayxp\.com\/track\.php\?awb=BH99000025$/,
    marker: /Tracking Information Not Found|Shipment Information/ },
  // The app asks the tracker's function for the number in its path and shows it over its scans, or over none.
  { carrier: 'aquiline', number: 'AQUAA9900000009YQ',
    route: /^https:\/\/aq-track\.com\/app\/track\/AQUAA9900000009YQ$/,
    marker: /Tracking History|No tracking events available/ },
  // The page looks the number up from its script and says when it holds no package under it.
  { carrier: 'consegnia', number: 'CLC999999917',
    route: /^https:\/\/clc-express\.com\/track-delivery\?awb=CLC999999917$/,
    marker: /No information about your package|Enter your tracking number or order number/ },
  // The server renders the booking's timeline, or says it holds none, with HTTP 200.
  { carrier: 'hitch', number: 'ZIP0SYNTHETIC01',
    route: /^https:\/\/hitch\.com\.ph\/tracking\?no=ZIP0SYNTHETIC01$/,
    marker: /we couldn't find any bookings\/results matching|Tracking Details/ },
  // The server renders the consignment's card, or a placeholder heading for a number it has no data for, with HTTP 200.
  { carrier: 'fmx', number: 'MYX0000000017',
    route: /^https:\/\/www\.fmx\.asia\/result_detail\.php\?p=1&conno=MYX0000000017$/,
    marker: /Consignment Data Generated, Awaiting for Handover|Tracking Number:/,
    forwarding: { notFound: /Consignment Data Generated, Awaiting for Handover/ } },
  // The page renders the parcel for the number in its path, or says it could not find it, with HTTP 404.
  { carrier: 'ecom-logistics', number: 'E00A0000099',
    route: /^https:\/\/shipecom\.com\/track\/E00A0000099$/,
    marker: /We could not find that number|Tracking history/,
    shipmentNotFound: { status: 404, marker: /We could not find that number/ } },
  // The page asks the open delivery service for the number in its path and names it when the service does not hold it.
  { carrier: 'anc-delivers', number: 'A00000000AA',
    route: /^https:\/\/ancdelivers\.com\.au\/track\/A00000000AA$/,
    marker: /We couldn’t find your tracking number/ },
  // The page lists the number in its number parameter and asks the open service, which holds no scan for this one.
  { carrier: 'bestfulfill', number: 'BEST00000000000000',
    route: /^https:\/\/www\.bestfulfillpacket\.com\/track\?number=BEST00000000000000$/,
    marker: /Tracking Number List/ },
  // The page posts the number in its references parameter to the platform's search and shows no result for one it does not hold.
  { carrier: 'lex-my', number: 'TMYLE000000000',
    route: /^https:\/\/lex\.com\.my\/tracking\?references=TMYLE000000000$/,
    marker: /No Result Found/ },
  // The tracker's frame repeats the number in its item parameter as its heading, with no scan for one it does not hold.
  { carrier: 'go-logistics-au', number: '9999999999',
    route: /^https:\/\/services\.gologistics\.com\.au\/track\/iframe2\.php\?item=9999999999$/,
    marker: /Coupon\/Consignment Tracking/ },
  // The tracker's page repeats the consignment in its con parameter, with one row saying no consignment was found.
  { carrier: 'tnt-au', number: 'TNA000000009',
    route: /^https:\/\/www\.tntexpress\.com\.au\/interaction\/ASPs\/trackref_detail\.asp\?con=TNA000000009$/,
    marker: /Consignment No: TNA000000009/ },
  // The page loads the fragment for the number in its address, which fills its search box and renders the
  // parcel or says the number does not exist, with HTTP 200.
  { carrier: 'skybox', number: '009900000099',
    route: /^https:\/\/www\.skybox\.net\/TrackingInformation\/IndexPublic\?tracking=009900000099$/,
    marker: /The tracking number does not exists|Tracking Information:/ },
  // The page renders the shipment, or says no shipment matches the number, with HTTP 200.
  { carrier: 'whiz-delivery', number: 'SW0000000000',
    route: /^https:\/\/track\.whizdelivery\.ca\/track\/SW0000000000$/,
    marker: /We couldn't find that shipment|Tracking History/ },
  // The page fills its field with the number in its address and asks the tracking service.
  { carrier: 'flashbird-ca', number: '100000000033',
    route: /^https:\/\/flashbird\.ca\/tracking\/100000000033$/,
    marker: /No parcel details found|Aucun renseignement trouvé pour ce colis|Tracking Parcels|Suivi des colis/ },
  // The server renders the shipment's row, or a placeholder row for a number it does not hold.
  { carrier: 'ats-healthcare', number: '000000017',
    route: /^https:\/\/www\.atshealthcare\.ca\/quickTrackResult\?ship=000000017$/,
    marker: /No detail for shipment 000000017|lstProgressDescr/ },
  // The server renders the list row for the number: the shipment's state, or that it holds none.
  { carrier: 'tonami', number: '0000000011',
    route: /^https:\/\/trc1\.tonami\.co\.jp\/trc\/search3\/excSearch3\?id%5B0%5D=0000000011$/,
    marker: /該当伝票番号なし|詳細1/ },
  // The site's tracking widget reads the probill from the address fragment and asks its API.
  { carrier: 'xgs', number: '00000017',
    route: /^https:\/\/www\.xgsi\.com\/#track-shipment=00000017$/,
    marker: /No data was found for the specified criteria|Detail Information/ },
  // The portal renders the shipment's card, or says it has none, with HTTP 200.
  { carrier: 'logisimple', number: '000000000017',
    route: /^https:\/\/portal\.logisimple\.pt\/pt\/tracking\?tracking=000000000017$/,
    marker: /TRK#000000000017|Não encontrámos correspondências para o código de envio/ },
  // The server renders the page, keeps the number in its form and shows its try-again notice for a made-up one.
  { carrier: 'viadireta', number: 'VD900000000017',
    route: /^https:\/\/www\.viadireta\.pt\/tracking\?codigo=VD900000000017$/,
    marker: /ainda não está a ser possível verificar o estado da sua encomenda|not yet possible to check the status of your order|Envio Nº|Shipment No\./ },
];

/**
 * Carriers with their own adapter (or no automatic tracking) whose link no
 * case above opens, and why. Universal carriers are out of scope: their
 * tracking comes from shared providers, not the page the link opens.
 */
export const uncheckedTrackingLinks: Partial<Record<CarrierId, string>> = {
  egxpress: 'Unknown waybills redirect to a system-error page; the rendered-link check has no verified missing-parcel view for that route.',
  'tcc-co': 'the public tracking page submits a reCAPTCHA token; native history comes from its separate guest endpoint',
  'toyou': 'the page can remain on its loading view; native tracking reads server-rendered guest state and a separate parcel API',
  'zoom-ve': 'the result is rendered after the application Turnstile callback, which the daily link check does not submit',
  'fm-transportes': 'the parcel view needs a Turnstile guest session, and its initial empty view is not a number-bound missing-parcel notice',
  roadie: 'The tracker requires US egress; the rendered-link canary has no scoped US browser transport.',
  'asyad-express': 'The web tracker requires Omani network access; the adapter reads the separate mobile guest endpoints.',
  'nepal-post': 'The internal tracker requires Nepali network access; the rendered-link check has no country-specific browser transport.',
  'russian-post': 'The public tracker requires Russian network access; the rendered-link check has no country-specific browser transport.',
  'surat-kargo': 'The public tracker requires Turkish network access; the rendered-link check has no country-specific browser transport.',
  eushipments: 'euShipments\' tracking page takes the number only in its form, which posts it to a handler, so no address opens one order',
  'no-limit': 'No Limit\'s tracking page takes the number only in its form, which it posts back to itself with the page\'s state, so no address opens one shipment',
  'ecms-express': 'Opening a numbered tracking link requires an arithmetic picture CAPTCHA; the adapter solves the separate guest API flow.',
  'israel-post': 'The public tracking page blocks requests before the tracking form; the adapter uses the native guest API.',
  zto: 'the domestic tracking page asks for Dingxiang verification before returning a shipment; the link opens the search form',
  '17feia': 'www.17feia.com sends a session without its cookie to cc.html, whose reload opens the home page without the number, so number forwarding cannot be verified',
  'ab-courier': 'A&B\'s order numbers run in sequence, so a synthetic one can open another customer\'s order, and the page answers an unknown order without its number; only a known order verifies the link',
  'ait-worldwide': 'FasTrak also finds shipments by their shippers\' references, so a synthetic number can open other people\'s shipments; only a known bill verifies the link',
  'allegro-one': 'allegro.pl answers automated Chrome with a DataDome block page instead of the tracker, so number forwarding cannot be verified',
  'an-post': 'Radware Bot Manager sends automated sessions on www.anpost.com to validate.perfdrive.com and a CAPTCHA, so number forwarding cannot be verified',
  'barid-al-maghrib': 'the detail page sends an unknown number back to the empty search form, so only a real item verifies the link',
  'bjs-home-delivery': 'the tracker\'s page script runs only once the visitor accepts statistics cookies in its Cookiebot banner, and then answers an unknown number with "Tracker is currently unavailable", so only a real order verifies the link',
  'blue-express': 'blue.cl answers headless Chrome with a Cloudflare managed challenge before the tracking page, so number forwarding cannot be verified',
  cacesa: 'www.cacesa.com answers an address with a number only after about twenty seconds, past the navigation limit; the page then fills the number in and looks it up',
  'china-post': 'www.ems.com.cn answers automated Chrome with an empty HTTP 400 from its web application firewall, and its tracker asks for a click CAPTCHA before each lookup',
  'ceva-logistics': 'www.cevalogistics.com answers headless Chrome with a Cloudflare block page instead of CEVA Trak, so number forwarding cannot be verified',
  cdek: 'the order page asks the tracking service for the number in its address, but answers an unknown one with the site\'s generic page-not-found screen, so only a real order verifies the link',
  'citylink-express': 'the result page looks up any fifteen digits in its address, and a synthetic consignment number can be another person\'s shipment, so only a known consignment verifies the link',
  cne: 'the tracking portal redirects inspected Chrome sessions to about:blank through its anti-debug script, preventing a stable rendered-page check',
  'dayton-freight': 'the detail page answers a PRO it does not know with a generic HTTP 500 error page without the number, and its PROs run in sequence, so a synthetic one can open another shipment; only a known PRO verifies the link',
  dellin: 'www.dellin.ru puts Qrator\'s script check before every page, and the order page answers an unknown number with the site\'s generic page-not-found screen, so only a real order verifies the link',
  'daylight-transport': 'Daylight reuses its eight-digit probills, so a synthetic one can open other people\'s shipments; only a known probill verifies the link',
  'colis-prive': 'an unknown number-and-postcode credential redirects to the homepage, so only a real parcel verifies the link',
  couriersplease: 'www.couriersplease.com.au answers the burst of script requests its tracker page makes in automated Chrome with HTTP 429, so the page never reads the number from its address and number forwarding cannot be verified daily',
  'dohrn-transfer': 'Dohrn\'s PROs run densely, so a synthetic one can open another shipper\'s shipment or rate quote; only a known PRO verifies the link',
  'dpd-at': 'Radware Bot Manager answers the lookup the myDPD page makes from automated Chrome with a CAPTCHA on validate.perfdrive.com, so number forwarding cannot be verified',
  'dpd-ie': 'www.dpd.ie passes the number only to its tracker frame from tracking.dpd.ie, which loads it as a document the rendered-page check does not read, so number forwarding cannot be verified',
  'dpd-ro': 'tracking.dpd.ro redirects to services.dpd.ro/tracking/, which answers automated Chrome with a Cloudflare managed challenge and asks for a Turnstile token with each lookup, so number forwarding cannot be verified',
  dropp: 'the tracker page answers an unknown number with a generic "try again later" error that does not show the number, so only a real parcel verifies the link',
  dtdc: 'the MyDTDC Flutter page exposes no visible body text until accessibility is enabled, and the portal link opens its home page',
  'emirates-post': 'www.emiratespost.ae answers automated Chrome with a Cloudflare managed challenge before the tracker page; only the TRAWL browser step clears it, so number forwarding cannot be verified daily',
  'fargo-courier': 'www.fargocourier.co.ke passes the number only to its tracker frame from portal.fargocourier.co.ke, which loads it as a document the rendered-page check does not read and answers an unknown waybill with a generic HTTP 500 error page, so number forwarding cannot be verified',
  'fedex-freight': 'FedEx Freight\'s ten-digit PROs run densely, so a synthetic one can open another shipper\'s shipment; only a known PRO verifies the link',
  'forward-air': 'Forward Air reuses its eight-digit waybill numbers, so a synthetic one can open other people\'s shipments; only a known waybill verifies the link',
  'forza-delivery': 'the tracker asks for a reCAPTCHA checkbox before it reads the guía in the address',
  gdex: 'gdexpress.com answers automated Chrome with a Cloudflare managed challenge before the tracking page, so number forwarding cannot be verified',
  hanjin: 'the result page answers an unknown number with an alert and sends the browser back to the empty search form, so only a real parcel verifies the link',
  'indah-logistik': 'the resi page answers an unknown number with a generic internal server error page without the number, so only a real resi verifies the link',
  'integral-pack': 'the page looks the guide in its address up with its parts padded and IPE- before them, and leaves its search form as it was, without the guide or a notice, for one it does not know, so only a real guide verifies the link',
  'j-and-t': 'the Philippine page the link opens asks for a Tencent CAPTCHA before it looks a waybill up, and the adapter reads the Indonesian network instead',
  'j-and-t-cargo': 'headless Chrome receives the page frame without the tracking form, which a regular browser shows with the waybill filled in',
  'evri-uk': 'the protected key request rejects the default automated browser and leaves the domestic result panel empty, so number forwarding cannot be verified',
  liccardi: 'my.liccarditrasporti.com answers automated Chrome with SafeLine\'s browser check (HTTP 468), which asks for a confirmation click before the tracking page, so number forwarding cannot be verified',
  logistiq: 'the gecko.logistiq.io tracker is a Flutter page drawn on a canvas, which exposes no visible body text until accessibility is enabled, so number forwarding cannot be verified',
  'm-one': 'm-one.rs sends its certificate without the intermediate one, which headless Chromium and Node do not fetch, so the page cannot be opened',
  'magyar-posta': 'www.posta.hu fills the number into its tracker frame, which the rendered-page check does not read, and the tracker asks for a reCAPTCHA checkbox before each lookup',
  'nim-express': 'www.nimexpress.com drops connections from the daily check\'s network while other networks in the United States get its page, so number forwarding cannot be verified daily; the page looks up the number in its address and names it above its not-found notice',
  noest: 'the page answers a number it does not hold with its empty search form, without the number or a notice, so only a real parcel verifies the link',
  oca: 'the parcel page asks for a reCAPTCHA checkbox before it shows the history, so number forwarding cannot be verified',
  ocasa: 'the tracking link opens a reCAPTCHA checkbox, with the number in a hidden field, before it shows the shipment, so number forwarding cannot be verified',
  passport: 'track.passportglobal.com answers automated Chrome with a Human Verification page that watches the visitor\'s activity before it shows the tracker, so number forwarding cannot be verified',
  'pilot-freight': 'Pilot\'s tracking service opens any shipment it holds under the pro number asked, and a synthetic nine-digit one can be another person\'s shipment, so only a known pro number verifies the link',
  'posta-north-macedonia': 'www.posta.com.mk often drops connections from the daily check\'s network, and its lookup can stall past the render window, so number forwarding cannot be verified daily; the page puts the number in its address into its field, looks it up and names it in its not-found row',
  'poste-italiane': 'the results page exposes no readable text to headless Chrome',
  ptt: 'the link opens the home page, whose tracking window stays folded until a visitor opens it and asks for a Cloudflare Turnstile token before each lookup',
  rivigo: 'Rivigo\'s ten-digit consignment numbers run densely, so a synthetic one can open another shipper\'s consignment, whose page names its consignor and consignee; only a known consignment verifies the link',
  'tci-express': 'the page answers an unknown docket with an empty result and neither the number nor a notice, so only a real parcel verifies the link',
  'team-express-ae': 'the page answers a number it does not hold with its empty tracking form, without the number or a notice, so only a real shipment verifies the link',
  'thailand-post': 'some of the tracker\'s servers stall on its script bundles, so the page often stays empty past the render window',
  'today-kr': 'a synthetic waybill may belong to a real parcel, whose page names its sender and recipient, so only a known waybill verifies the link',
  'total-express': 'totalconecta.totalexpress.com.br answers many networks with an Akamai Access Denied page, so number forwarding cannot be verified daily; the page puts the number from its address in its search field',
  trackon: 'the page answers an unknown number with its empty search form, without the number or a notice, and shows only consignments of the last 75 days, so only a recent real consignment verifies the link',
  'tst-cf-express': 'the results page shows any PRO it holds to anyone, and a synthetic PRO can belong to another shipment, so only a known PRO verifies the link',
  sagawa: 'the inquiry page the link opens answers Access Denied while Sagawa keeps its inquiry service suspended after unauthorized access',
  sending: 'Sending\'s tracker gives the same not-found notice, without the number, for an unknown number and for an address with none, so only a real shipment verifies the link',
  servientrega: 'the tracker shows its result in a frame from mobile.servientrega.com, which does not answer connections from Europe, North America or Asia, so number forwarding cannot be verified daily',
  slgtrax: 'sonic.pk drops connections from the daily check\'s network and some others, so number forwarding cannot be verified daily; the page looks up the number in its address as it opens',
  shiprocket: 'shiprocket.co answers an AWB it does not know with HTTP 400 and a not-found page that does not show the number, so only a real AWB verifies the link',
  'shree-maruti': 'shreemaruti.com shows the tracker in a frame from tracking.shreemaruti.com, which looks the number up on load, and the page itself holds only the menu and notices the home page has, so the rendered-page check cannot tell it is a tracker',
  swiftx: 'swiftx-express.com answers automated Chrome with a Cloudflare managed challenge before the tracking page, so number forwarding cannot be verified',
  'spee-dee': 'the tracker shows its result in a frame from packages.speedeedelivery.com, which drops connections from many networks, so number forwarding cannot be verified daily',
  speedex: 'www.speedex.gr passes the number only to its tracker frame, which loads it as a document the rendered-page check does not read, so number forwarding cannot be verified',
  usps: 'tools.usps.com answers automated Chrome with an anti-bot script instead of the page',
  'xpo-ltl': 'the shipment page asks for a reCAPTCHA checkbox before it shows a result, so number forwarding cannot be verified',
};

/**
 * The carriers' status maps, asked about one scan at a time.
 *
 * The parcel app keeps the wording no carrier map staged for review, keyed by
 * carrier, provider code and normalized wording. `statusMapAnswer` tells it
 * what the map of the scraper it runs says about such a key: the stage the map
 * gives it, a gap the map leaves on purpose, or nothing. A carrier declares its
 * `statusMap` next to its map in `status.ts`; carriers without one answer
 * `unknown`. The scans the app files under the carrier `unknown` come from the
 * universal providers, whose map is the reading they give a scan
 * (`providers/status.ts`).
 */
import { statusMap as seventeenFeia } from '../../carriers/17feia/status.js';
import { statusMap as twoGo } from '../../carriers/2go/status.js';
import { statusMap as fourSeventyTwo } from '../../carriers/4-72/status.js';
import { statusMap as fourSides } from '../../carriers/4sides/status.js';
import { statusMap as fivePost } from '../../carriers/5post/status.js';
import { statusMap as ninetynineMinutos } from '../../carriers/99minutos/status.js';
import { statusMap as a1Post } from '../../carriers/a1-post/status.js';
import { statusMap as aDuiePyle } from '../../carriers/a-duie-pyle/status.js';
import { statusMap as aTuHoraExpress } from '../../carriers/a-tu-hora-express/status.js';
import { statusMap as abCourier } from '../../carriers/ab-courier/status.js';
import { statusMap as abfFreight } from '../../carriers/abf-freight/status.js';
import { statusMap as aciExpressKr } from '../../carriers/aci-express-kr/status.js';
import { statusMap as acsCourier } from '../../carriers/acs-courier/status.js';
import { statusMap as aexParaguay } from '../../carriers/aex-paraguay/status.js';
import { statusMap as aitWorldwide } from '../../carriers/ait-worldwide/status.js';
import { statusMap as airpakExpress } from '../../carriers/airpak-express/status.js';
import { statusMap as ajex } from '../../carriers/ajex/status.js';
import { statusMap as algeriePoste } from '../../carriers/algerie-poste/status.js';
import { statusMap as aliexpress } from '../../carriers/aliexpress/status.js';
import { statusMap as allegroOne } from '../../carriers/allegro-one/status.js';
import { statusMap as amHomeDelivery } from '../../carriers/am-home-delivery/status.js';
import { statusMap as amazonShipping } from '../../carriers/amazon-shipping/status.js';
import { statusMap as americanWestExpress } from '../../carriers/american-west-express/status.js';
import { statusMap as amerijet } from '../../carriers/amerijet/status.js';
import { statusMap as ampm } from '../../carriers/ampm/status.js';
import { statusMap as ancDelivers } from '../../carriers/anc-delivers/status.js';
import { statusMap as anPost } from '../../carriers/an-post/status.js';
import { statusMap as andreani } from '../../carriers/andreani/status.js';
import { statusMap as anjun } from '../../carriers/anjun/status.js';
import { statusMap as anousith } from '../../carriers/anousith/status.js';
import { statusMap as anserx } from '../../carriers/anserx/status.js';
import { statusMap as anteraja } from '../../carriers/anteraja/status.js';
import { statusMap as apcOvernight } from '../../carriers/apc-overnight/status.js';
import { statusMap as apcPostalLogistics } from '../../carriers/apc-postal-logistics/status.js';
import { statusMap as appleExpress } from '../../carriers/apple-express/status.js';
import { statusMap as aquiline } from '../../carriers/aquiline/status.js';
import { statusMap as aramex } from '../../carriers/aramex/status.js';
import { statusMap as aramexAu } from '../../carriers/aramex-au/status.js';
import { statusMap as aramexNz } from '../../carriers/aramex-nz/status.js';
import { statusMap as arasKargo } from '../../carriers/aras-kargo/status.js';
import { statusMap as arrowXl } from '../../carriers/arrow-xl/status.js';
import { statusMap as asendia } from '../../carriers/asendia/status.js';
import { statusMap as asyadExpress } from '../../carriers/asyad-express/status.js';
import { statusMap as nepalPost } from '../../carriers/nepal-post/status.js';
import { statusMap as russianPost } from '../../carriers/russian-post/status.js';
import { statusMap as suratKargo } from '../../carriers/surat-kargo/status.js';
import { statusMap as atlanticCourier } from '../../carriers/atlantic-courier/status.js';
import { statusMap as atsHealthcare } from '../../carriers/ats-healthcare/status.js';
import { statusMap as australiaPost } from '../../carriers/australia-post/status.js';
import { statusMap as austrianPost } from '../../carriers/austrian-post/status.js';
import { statusMap as averitt } from '../../carriers/averitt/status.js';
import { statusMap as aymakan } from '../../carriers/aymakan/status.js';
import { statusMap as bangladeshPost } from '../../carriers/bangladesh-post/status.js';
import { statusMap as baridAlMaghrib } from '../../carriers/barid-al-maghrib/status.js';
import { statusMap as belpost } from '../../carriers/belpost/status.js';
import { statusMap as bestfulfill } from '../../carriers/bestfulfill/status.js';
import { statusMap as bestOverniteExpress } from '../../carriers/best-overnite-express/status.js';
import { statusMap as betterTrucks } from '../../carriers/better-trucks/status.js';
import { statusMap as bexExpress } from '../../carriers/bex-express/status.js';
import { statusMap as bjsHomeDelivery } from '../../carriers/bjs-home-delivery/status.js';
import { statusMap as blueDart } from '../../carriers/blue-dart/status.js';
import { statusMap as blueExpress } from '../../carriers/blue-express/status.js';
import { statusMap as blueex } from '../../carriers/blueex/status.js';
import { statusMap as bombino } from '../../carriers/bombino/status.js';
import { statusMap as bookurier } from '../../carriers/bookurier/status.js';
import { statusMap as borderExpress } from '../../carriers/border-express/status.js';
import { statusMap as bosta } from '../../carriers/bosta/status.js';
import { statusMap as boxNow } from '../../carriers/box-now/status.js';
import { statusMap as boxtal } from '../../carriers/boxtal/status.js';
import { statusMap as bpost } from '../../carriers/bpost/status.js';
import { statusMap as bringPosten } from '../../carriers/bring-posten/status.js';
import { statusMap as bringerParcel } from '../../carriers/bringer-parcel/status.js';
import { statusMap as brt } from '../../carriers/brt/status.js';
import { statusMap as bulgarianPosts } from '../../carriers/bulgarian-posts/status.js';
import { statusMap as burdDelivery } from '../../carriers/burd-delivery/status.js';
import { statusMap as bussgods } from '../../carriers/bussgods/status.js';
import { statusMap as byhd } from '../../carriers/byhd/status.js';
import { statusMap as cChezVous } from '../../carriers/c-chez-vous/status.js';
import { statusMap as c3x } from '../../carriers/c3x/status.js';
import { statusMap as cacesa } from '../../carriers/cacesa/status.js';
import { statusMap as canadaPost } from '../../carriers/canada-post/status.js';
import { statusMap as canpar } from '../../carriers/canpar/status.js';
import { statusMap as cargus } from '../../carriers/cargus/status.js';
import { statusMap as castleParcels } from '../../carriers/castle-parcels/status.js';
import { statusMap as castores } from '../../carriers/castores/status.js';
import { statusMap as cblLogistica } from '../../carriers/cbl-logistica/status.js';
import { statusMap as ccfs } from '../../carriers/ccfs/status.js';
import { statusMap as cdek } from '../../carriers/cdek/status.js';
import { statusMap as cdl } from '../../carriers/cdl/status.js';
import { statusMap as celeritas } from '../../carriers/celeritas/status.js';
import { statusMap as centralTransport } from '../../carriers/central-transport/status.js';
import { statusMap as ceskaPosta } from '../../carriers/ceska-posta/status.js';
import { statusMap as cevaLogistics } from '../../carriers/ceva-logistics/status.js';
import { statusMap as chazki } from '../../carriers/chazki/status.js';
import { statusMap as chilexpress } from '../../carriers/chilexpress/status.js';
import { statusMap as chinaPost } from '../../carriers/china-post/status.js';
import { statusMap as chitChats } from '../../carriers/chit-chats/status.js';
import { statusMap as chronodiali } from '../../carriers/chronodiali/status.js';
import { statusMap as chronopost } from '../../carriers/chronopost/status.js';
import { statusMap as chukou1 } from '../../carriers/chukou1/status.js';
import { statusMap as chunghwaPost } from '../../carriers/chunghwa-post/status.js';
import { statusMap as chunil } from '../../carriers/chunil/status.js';
import { statusMap as ciblex } from '../../carriers/ciblex/status.js';
import { statusMap as citilogistics } from '../../carriers/citilogistics/status.js';
import { statusMap as cityExpressRs } from '../../carriers/city-express-rs/status.js';
import { statusMap as citylinkExpress } from '../../carriers/citylink-express/status.js';
import { statusMap as citymail } from '../../carriers/citymail/status.js';
import { statusMap as cjLogistics } from '../../carriers/cj-logistics/status.js';
import { statusMap as cjPacket } from '../../carriers/cj-packet/status.js';
import { statusMap as closerLogistics } from '../../carriers/closer-logistics/status.js';
import { statusMap as cne } from '../../carriers/cne/status.js';
import { statusMap as colisPrive } from '../../carriers/colis-prive/status.js';
import { statusMap as colisweb } from '../../carriers/colisweb/status.js';
import { statusMap as connectCouriers } from '../../carriers/connect-couriers/status.js';
import { statusMap as consegnia } from '../../carriers/consegnia/status.js';
import { statusMap as coordinadora } from '../../carriers/coordinadora/status.js';
import { statusMap as copaCourier } from '../../carriers/copa-courier/status.js';
import { statusMap as corre } from '../../carriers/corre/status.js';
import { statusMap as correiosBr } from '../../carriers/correios-br/status.js';
import { statusMap as correoArgentino } from '../../carriers/correo-argentino/status.js';
import { statusMap as correoUruguayo } from '../../carriers/correo-uruguayo/status.js';
import { statusMap as correosChile } from '../../carriers/correos-chile/status.js';
import { statusMap as correosCuba } from '../../carriers/correos-cuba/status.js';
import { statusMap as correosDeMexico } from '../../carriers/correos-de-mexico/status.js';
import { statusMap as correosElSalvador } from '../../carriers/correos-el-salvador/status.js';
import { statusMap as correosExpress } from '../../carriers/correos-express/status.js';
import { statusMap as correosSpain } from '../../carriers/correos-spain/status.js';
import { statusMap as courierCenter } from '../../carriers/courier-center/status.js';
import { statusMap as couriersPlease } from '../../carriers/couriersplease/status.js';
import { statusMap as cruzDelSur } from '../../carriers/cruz-del-sur/status.js';
import { statusMap as cseRussia } from '../../carriers/cse-russia/status.js';
import { statusMap as cttExpress } from '../../carriers/ctt-express/status.js';
import { statusMap as ctt } from '../../carriers/ctt/status.js';
import { statusMap as cttyex } from '../../carriers/cttyex/status.js';
import { statusMap as cyprusPost } from '../../carriers/cyprus-post/status.js';
import { statusMap as dExpress } from '../../carriers/d-express/status.js';
import { statusMap as daiPost } from '../../carriers/dai-post/status.js';
import { statusMap as danskeFragtmaend } from '../../carriers/danske-fragtmaend/status.js';
import { statusMap as dayone } from '../../carriers/dayone/status.js';
import { statusMap as daylightTransport } from '../../carriers/daylight-transport/status.js';
import { statusMap as dayRoss } from '../../carriers/day-ross/status.js';
import { statusMap as dealersend } from '../../carriers/dealersend/status.js';
import { statusMap as daytonFreight } from '../../carriers/dayton-freight/status.js';
import { statusMap as dachser } from '../../carriers/dachser/status.js';
import { statusMap as dao } from '../../carriers/dao/status.js';
import { statusMap as delhivery } from '../../carriers/delhivery/status.js';
import { statusMap as dellin } from '../../carriers/dellin/status.js';
import { statusMap as delnext } from '../../carriers/delnext/status.js';
import { statusMap as deppon } from '../../carriers/deppon/status.js';
import { statusMap as dhlEcommerce } from '../../carriers/dhl-ecommerce/status.js';
import { statusMap as dhlEcommerceEs } from '../../carriers/dhl-ecommerce-es/status.js';
import { statusMap as dhlEcommerceNl } from '../../carriers/dhl-ecommerce-nl/status.js';
import { statusMap as dhlEcommercePl } from '../../carriers/dhl-ecommerce-pl/status.js';
import { statusMap as dhlEcommerceUk } from '../../carriers/dhl-ecommerce-uk/status.js';
import { statusMap as dhlExpress } from '../../carriers/dhl-express/status.js';
import { statusMap as dhlFreight } from '../../carriers/dhl-freight/status.js';
import { statusMap as dhl } from '../../carriers/dhl/status.js';
import { statusMap as dhlink } from '../../carriers/dhlink/status.js';
import { statusMap as direx } from '../../carriers/direx/status.js';
import { statusMap as dobropost } from '../../carriers/dobropost/status.js';
import { statusMap as dohrnTransfer } from '../../carriers/dohrn-transfer/status.js';
import { statusMap as domainLogistics } from '../../carriers/domain-logistics/status.js';
import { statusMap as domex } from '../../carriers/domex/status.js';
import { statusMap as dpd } from '../../carriers/dpd/status.js';
import { statusMap as dpdAt } from '../../carriers/dpd-at/status.js';
import { statusMap as dpdBe } from '../../carriers/dpd-be/status.js';
import { statusMap as dpdDe } from '../../carriers/dpd-de/status.js';
import { statusMap as dpdFr } from '../../carriers/dpd-fr/status.js';
import { statusMap as dpdHu } from '../../carriers/dpd-hu/status.js';
import { statusMap as dpdIe } from '../../carriers/dpd-ie/status.js';
import { statusMap as dpdNl } from '../../carriers/dpd-nl/status.js';
import { statusMap as dpdPl } from '../../carriers/dpd-pl/status.js';
import { statusMap as dpdPt } from '../../carriers/dpd-pt/status.js';
import { statusMap as dpdRo } from '../../carriers/dpd-ro/status.js';
import { statusMap as dpdUk } from '../../carriers/dpd-uk/status.js';
import { statusMap as dpdZa } from '../../carriers/dpd-za/status.js';
import { statusMap as dpex } from '../../carriers/dpex/status.js';
import { statusMap as dragonStarCurier } from '../../carriers/dragon-star-curier/status.js';
import { statusMap as drop2shop } from '../../carriers/drop2shop/status.js';
import { statusMap as dropp } from '../../carriers/dropp/status.js';
import { statusMap as dsv } from '../../carriers/dsv/status.js';
import { statusMap as dtdc } from '../../carriers/dtdc/status.js';
import { statusMap as dx } from '../../carriers/dx/status.js';
import { statusMap as dynalogic } from '../../carriers/dynalogic/status.js';
import { statusMap as eCommerceInternational } from '../../carriers/e-commerce-international/status.js';
import { statusMap as earlyBird } from '../../carriers/early-bird/status.js';
import { statusMap as easyMail } from '../../carriers/easy-mail/status.js';
import { statusMap as ecmsExpress } from '../../carriers/ecms-express/status.js';
import { statusMap as ecomLogistics } from '../../carriers/ecom-logistics/status.js';
import { statusMap as econt } from '../../carriers/econt/status.js';
import { statusMap as ecoscooting } from '../../carriers/ecoscooting/status.js';
import { statusMap as ecourier } from '../../carriers/ecourier/status.js';
import { statusMap as egyptPost } from '../../carriers/egypt-post/status.js';
import { statusMap as egxpress } from '../../carriers/egxpress/status.js';
import { statusMap as ekart } from '../../carriers/ekart/status.js';
import { statusMap as elta } from '../../carriers/elta/status.js';
import { statusMap as emile } from '../../carriers/emile/status.js';
import { statusMap as emiratesPost } from '../../carriers/emirates-post/status.js';
import { statusMap as ems } from '../../carriers/ems/status.js';
import { statusMap as emsVietnam } from '../../carriers/ems-vietnam/status.js';
import { statusMap as energiaTk } from '../../carriers/energia-tk/status.js';
import { statusMap as enviaColombia } from '../../carriers/envia-colombia/status.js';
import { statusMap as envialia } from '../../carriers/envialia/status.js';
import { statusMap as eparcelKr } from '../../carriers/eparcel-kr/status.js';
import { statusMap as epostGlobal } from '../../carriers/epost-global/status.js';
import { statusMap as equick } from '../../carriers/equick/status.js';
import { statusMap as estafeta } from '../../carriers/estafeta/status.js';
import { statusMap as estes } from '../../carriers/estes/status.js';
import { statusMap as estesForwarding } from '../../carriers/estes-forwarding/status.js';
import { statusMap as eurodis } from '../../carriers/eurodis/status.js';
import { statusMap as euroexpressBa } from '../../carriers/euroexpress-ba/status.js';
import { statusMap as europochta } from '../../carriers/europochta/status.js';
import { statusMap as eushipments } from '../../carriers/eushipments/status.js';
import { statusMap as evdemoLojistik } from '../../carriers/evdemo-lojistik/status.js';
import { statusMap as evri } from '../../carriers/evri/status.js';
import { statusMap as evriUk } from '../../carriers/evri-uk/status.js';
import { statusMap as evropat } from '../../carriers/evropat/status.js';
import { statusMap as ewe } from '../../carriers/ewe/status.js';
import { statusMap as exelot } from '../../carriers/exelot/status.js';
import { statusMap as exlineKz } from '../../carriers/exline-kz/status.js';
import { statusMap as exmate } from '../../carriers/exmate/status.js';
import { statusMap as expressOne } from '../../carriers/express-one/status.js';
import { statusMap as expressOneBg } from '../../carriers/express-one-bg/status.js';
import { statusMap as fanCourier } from '../../carriers/fan-courier/status.js';
import { statusMap as farInternational } from '../../carriers/far-international/status.js';
import { statusMap as fastbox } from '../../carriers/fastbox/status.js';
import { statusMap as fargoCourier } from '../../carriers/fargo-courier/status.js';
import { statusMap as fargoUz } from '../../carriers/fargo-uz/status.js';
import { statusMap as fastdrop } from '../../carriers/fastdrop/status.js';
import { statusMap as fastfrate } from '../../carriers/fastfrate/status.js';
import { statusMap as fedex } from '../../carriers/fedex/status.js';
import { statusMap as fedexFreight } from '../../carriers/fedex-freight/status.js';
import { statusMap as fedexInternationalConnect } from '../../carriers/fedex-international-connect/status.js';
import { statusMap as fedexPl } from '../../carriers/fedex-pl/status.js';
import { statusMap as fermopoint } from '../../carriers/fermopoint/status.js';
import { statusMap as fgDelivery } from '../../carriers/fg-delivery/status.js';
import { statusMap as firstLine } from '../../carriers/first-line/status.js';
import { statusMap as flashExpress } from '../../carriers/flash-express/status.js';
import { statusMap as flashExpressPh } from '../../carriers/flash-express-ph/status.js';
import { statusMap as flashbirdCa } from '../../carriers/flashbird-ca/status.js';
import { statusMap as fleetex } from '../../carriers/fleetex/status.js';
import { statusMap as fleetoptics } from '../../carriers/fleetoptics/status.js';
import { statusMap as flippost } from '../../carriers/flippost/status.js';
import { statusMap as fmx } from '../../carriers/fmx/status.js';
import { statusMap as followmont } from '../../carriers/followmont/status.js';
import { statusMap as fmTransportes } from '../../carriers/fm-transportes/status.js';
import { statusMap as forwardAir } from '../../carriers/forward-air/status.js';
import { statusMap as forzaDelivery } from '../../carriers/forza-delivery/status.js';
import { statusMap as fourPx } from '../../carriers/four-px/status.js';
import { statusMap as foxpost } from '../../carriers/foxpost/status.js';
import { statusMap as franchExpress } from '../../carriers/franch-express/status.js';
import { statusMap as fukuyama } from '../../carriers/fukuyama/status.js';
import { statusMap as gaash } from '../../carriers/gaash/status.js';
import { statusMap as gati } from '../../carriers/gati/status.js';
import { statusMap as gdex } from '../../carriers/gdex/status.js';
import { statusMap as gebruederWeiss } from '../../carriers/gebrueder-weiss/status.js';
import { statusMap as geis } from '../../carriers/geis/status.js';
import { statusMap as geodis } from '../../carriers/geodis/status.js';
import { statusMap as geodisPl } from '../../carriers/geodis-pl/status.js';
import { statusMap as geniki } from '../../carriers/geniki-taxydromiki/status.js';
import { statusMap as gigLogistics } from '../../carriers/gig-logistics/status.js';
import { statusMap as globalDeliveryNetwork } from '../../carriers/global-delivery-network/status.js';
import { statusMap as glsCh } from '../../carriers/gls-ch/status.js';
import { statusMap as glsDe } from '../../carriers/gls-de/status.js';
import { statusMap as glsEs } from '../../carriers/gls-es/status.js';
import { statusMap as glsFr } from '../../carriers/gls-fr/status.js';
import { statusMap as glsIt } from '../../carriers/gls-it/status.js';
import { statusMap as goExpress } from '../../carriers/go-express/status.js';
import { statusMap as globalpost } from '../../carriers/globalpost/status.js';
import { statusMap as gmsWorldwide } from '../../carriers/gms-worldwide/status.js';
import { statusMap as goLogisticsAu } from '../../carriers/go-logistics-au/status.js';
import { statusMap as lexId } from '../../carriers/lex-id/status.js';
import { statusMap as lexMy } from '../../carriers/lex-my/status.js';
import { statusMap as go4 } from '../../carriers/go4/status.js';
import { statusMap as gobolt } from '../../carriers/gobolt/status.js';
import { statusMap as gofo } from '../../carriers/gofo/status.js';
import { statusMap as gofoCa } from '../../carriers/gofo-ca/status.js';
import { statusMap as gofoEs } from '../../carriers/gofo-es/status.js';
import { statusMap as gofoFr } from '../../carriers/gofo-fr/status.js';
import { statusMap as gofoIt } from '../../carriers/gofo-it/status.js';
import { statusMap as gofoNl } from '../../carriers/gofo-nl/status.js';
import { statusMap as gogoXpress } from '../../carriers/gogo-xpress/status.js';
import { statusMap as grandSlamExpress } from '../../carriers/grand-slam-express/status.js';
import { statusMap as gsPostbox } from '../../carriers/gs-postbox/status.js';
import { statusMap as gsiExpress } from '../../carriers/gsi-express/status.js';
import { statusMap as gtaAirskip } from '../../carriers/gta-airskip/status.js';
import { statusMap as gtlGoto } from '../../carriers/gtl-goto/status.js';
import { statusMap as guatex } from '../../carriers/guatex/status.js';
import { statusMap as gzyl } from '../../carriers/gzyl/status.js';
import { statusMap as hanjin } from '../../carriers/hanjin/status.js';
import { statusMap as happyPost } from '../../carriers/happy-post/status.js';
import { statusMap as haypost } from '../../carriers/haypost/status.js';
import { statusMap as hctLogistics } from '../../carriers/hct-logistics/status.js';
import { statusMap as helthjem } from '../../carriers/helthjem/status.js';
import { statusMap as heppner } from '../../carriers/heppner/status.js';
import { statusMap as hepsijet } from '../../carriers/hepsijet/status.js';
import { statusMap as hermes } from '../../carriers/hermes/status.js';
import { statusMap as hermesAt } from '../../carriers/hermes-at/status.js';
import { statusMap as hermesDe } from '../../carriers/hermes-de/status.js';
import { statusMap as hitch } from '../../carriers/hitch/status.js';
import { statusMap as hispapost } from '../../carriers/hispapost/status.js';
import { statusMap as homexpress } from '../../carriers/homexpress/status.js';
import { statusMap as hongkongPost } from '../../carriers/hongkong-post/status.js';
import { statusMap as horoz } from '../../carriers/horoz/status.js';
import { statusMap as houngAhLoun } from '../../carriers/houng-ah-loun/status.js';
import { statusMap as hovership } from '../../carriers/hovership/status.js';
import { statusMap as hrParcel } from '../../carriers/hr-parcel/status.js';
import { statusMap as hrvatskaPosta } from '../../carriers/hrvatska-posta/status.js';
import { statusMap as hunterExpress } from '../../carriers/hunter-express/status.js';
import { statusMap as huahan } from '../../carriers/huahan/status.js';
import { statusMap as huayaExpress } from '../../carriers/huaya-express/status.js';
import { statusMap as hywl } from '../../carriers/hywl/status.js';
import { statusMap as iccWorldwide } from '../../carriers/icc-worldwide/status.js';
import { statusMap as icsCourier } from '../../carriers/ics-courier/status.js';
import { statusMap as idsLogistik } from '../../carriers/ids-logistik/status.js';
import { statusMap as ilyangLogis } from '../../carriers/ilyang-logis/status.js';
import { statusMap as imile } from '../../carriers/imile/status.js';
import { statusMap as indahLogistik } from '../../carriers/indah-logistik/status.js';
import { statusMap as indiaPost } from '../../carriers/india-post/status.js';
import { statusMap as inpost } from '../../carriers/inpost/status.js';
import { statusMap as instabox } from '../../carriers/instabox/status.js';
import { statusMap as integralPack } from '../../carriers/integral-pack/status.js';
import { statusMap as intelValley } from '../../carriers/intel-valley/status.js';
import { statusMap as intelcom } from '../../carriers/intelcom/status.js';
import { statusMap as internetExpress } from '../../carriers/internet-express/status.js';
import { statusMap as interrapidisimo } from '../../carriers/interrapidisimo/status.js';
import { statusMap as intexPaketdienst } from '../../carriers/intex-paketdienst/status.js';
import { statusMap as israelPost } from '../../carriers/israel-post/status.js';
import { statusMap as jAndT } from '../../carriers/j-and-t/status.js';
import { statusMap as jAndTAu } from '../../carriers/j-and-t-au/status.js';
import { statusMap as jAndTDe } from '../../carriers/j-and-t-de/status.js';
import { statusMap as jAndTUk } from '../../carriers/j-and-t-uk/status.js';
import { statusMap as jntCargo } from '../../carriers/j-and-t-cargo/status.js';
import { statusMap as jAndTMiddleEast } from '../../carriers/j-and-t-middle-east/status.js';
import { statusMap as janio } from '../../carriers/janio/status.js';
import { statusMap as japanPost } from '../../carriers/japan-post/status.js';
import { statusMap as jcex } from '../../carriers/jcex/status.js';
import { statusMap as jdLogistics } from '../../carriers/jd-logistics/status.js';
import { statusMap as jeebly } from '../../carriers/jeebly/status.js';
import { statusMap as jerseyPost } from '../../carriers/jersey-post/status.js';
import { statusMap as jetLogistic } from '../../carriers/jet-logistic/status.js';
import { statusMap as jetlineCouriers } from '../../carriers/jetline-couriers/status.js';
import { statusMap as jhgj } from '../../carriers/jhgj/status.js';
import { statusMap as jifan } from '../../carriers/jifan/status.js';
import { statusMap as jordanPost } from '../../carriers/jordan-post/status.js';
import { statusMap as jitsu } from '../../carriers/jitsu/status.js';
import { statusMap as jne } from '../../carriers/jne/status.js';
import { statusMap as jrt } from '../../carriers/jrt/status.js';
import { statusMap as jsExpress } from '../../carriers/js-express/status.js';
import { statusMap as jumppoint } from '../../carriers/jumppoint/status.js';
import { statusMap as kazpost } from '../../carriers/kazpost/status.js';
import { statusMap as kex } from '../../carriers/kex/status.js';
import { statusMap as kexExpressHk } from '../../carriers/kex-express-hk/status.js';
import { statusMap as kitTk } from '../../carriers/kit-tk/status.js';
import { statusMap as komonExpress } from '../../carriers/komon-express/status.js';
import { statusMap as koreaPost } from '../../carriers/korea-post/status.js';
import { statusMap as kolayGelsin } from '../../carriers/kolay-gelsin/status.js';
import { statusMap as kuehneNagel } from '../../carriers/kuehne-nagel/status.js';
import { statusMap as kunExpress } from '../../carriers/kun-express/status.js';
import { statusMap as kunyoung } from '../../carriers/kunyoung/status.js';
import { statusMap as kyoungdong } from '../../carriers/kyoungdong/status.js';
import { statusMap as kyrgyzPost } from '../../carriers/kyrgyz-post/status.js';
import { statusMap as lPost } from '../../carriers/l-post/status.js';
import { statusMap as laPoste } from '../../carriers/la-poste/status.js';
import { statusMap as laPosteBurkinaFaso } from '../../carriers/la-poste-burkina-faso/status.js';
import { statusMap as laPosteSenegal } from '../../carriers/la-poste-senegal/status.js';
import { statusMap as laarCourier } from '../../carriers/laar-courier/status.js';
import { statusMap as labaih } from '../../carriers/labaih/status.js';
import { statusMap as landmarkGlobal } from '../../carriers/landmark-global/status.js';
import { statusMap as lastOneMileCoop } from '../../carriers/last-one-mile-coop/status.js';
import { statusMap as latvijasPasts } from '../../carriers/latvijas-pasts/status.js';
import { statusMap as lbcExpress } from '../../carriers/lbc-express/status.js';
import { statusMap as leopardsCourier } from '../../carriers/leopards-courier/status.js';
import { statusMap as liccardi } from '../../carriers/liccardi/status.js';
import { statusMap as linearLogistics } from '../../carriers/linear-logistics/status.js';
import { statusMap as lietuvosPastas } from '../../carriers/lietuvos-pastas/status.js';
import { statusMap as lightningExpress } from '../../carriers/lightning-express/status.js';
import { statusMap as lineClear } from '../../carriers/line-clear/status.js';
import { statusMap as lingdong } from '../../carriers/lingdong/status.js';
import { statusMap as linhan } from '../../carriers/linhan/status.js';
import { statusMap as lionParcel } from '../../carriers/lion-parcel/status.js';
import { statusMap as logen } from '../../carriers/logen/status.js';
import { statusMap as loggi } from '../../carriers/loggi/status.js';
import { statusMap as logisimple } from '../../carriers/logisimple/status.js';
import { statusMap as logistiq } from '../../carriers/logistiq/status.js';
import { statusMap as logoix } from '../../carriers/logoix/status.js';
import { statusMap as loomisExpress } from '../../carriers/loomis-express/status.js';
import { statusMap as lotteGlobal } from '../../carriers/lotte-global/status.js';
import { statusMap as mAndP } from '../../carriers/m-and-p/status.js';
import { statusMap as mOne } from '../../carriers/m-one/status.js';
import { statusMap as madhurCourier } from '../../carriers/madhur-courier/status.js';
import { statusMap as magyarPosta } from '../../carriers/magyar-posta/status.js';
import { statusMap as mailamericas } from '../../carriers/mailamericas/status.js';
import { statusMap as mailplusAu } from '../../carriers/mailplus-au/status.js';
import { statusMap as mainfreight } from '../../carriers/mainfreight/status.js';
import { statusMap as makatiExpress } from '../../carriers/makati-express/status.js';
import { statusMap as maerskEcommerce } from '../../carriers/maersk-ecommerce/status.js';
import { statusMap as maltapost } from '../../carriers/maltapost/status.js';
import { statusMap as maritimeOntario } from '../../carriers/maritime-ontario/status.js';
import { statusMap as marutiAir } from '../../carriers/maruti-air/status.js';
import { statusMap as matkahuolto } from '../../carriers/matkahuolto/status.js';
import { statusMap as mauritiusPost } from '../../carriers/mauritius-post/status.js';
import { statusMap as mayiyinfu } from '../../carriers/mayiyinfu/status.js';
import { statusMap as mdsCollivery } from '../../carriers/mds-collivery/status.js';
import { statusMap as meest } from '../../carriers/meest/status.js';
import { statusMap as meihooPegasus } from '../../carriers/meihoo-pegasus/status.js';
import { statusMap as mesoGlobal } from '../../carriers/meso-global/status.js';
import { statusMap as mhi } from '../../carriers/mhi/status.js';
import { statusMap as messengerCz } from '../../carriers/messenger-cz/status.js';
import { statusMap as metropolitanWarehouse } from '../../carriers/metropolitan-warehouse/status.js';
import { statusMap as microExpress } from '../../carriers/micro-express/status.js';
import { statusMap as midlandTransport } from '../../carriers/midland-transport/status.js';
import { statusMap as mngKargo } from '../../carriers/mng-kargo/status.js';
import { statusMap as mondialRelay } from '../../carriers/mondial-relay/status.js';
import { statusMap as mongolInfinityPost } from '../../carriers/mongol-infinity-post/status.js';
import { statusMap as morningGlobal } from '../../carriers/morning-global/status.js';
import { statusMap as mrlGlobal } from '../../carriers/mrl-global/status.js';
import { statusMap as mrw } from '../../carriers/mrw/status.js';
import { statusMap as mtscn } from '../../carriers/mtscn/status.js';
import { statusMap as mylerz } from '../../carriers/mylerz/status.js';
import { statusMap as nacex } from '../../carriers/nacex/status.js';
import { statusMap as naqel } from '../../carriers/naqel/status.js';
import { statusMap as nationex } from '../../carriers/nationex/status.js';
import { statusMap as nextLevelDelivery } from '../../carriers/next-level-delivery/status.js';
import { statusMap as nimExpress } from '../../carriers/nim-express/status.js';
import { statusMap as ninjaVan } from '../../carriers/ninja-van/status.js';
import { statusMap as nipost } from '../../carriers/nipost/status.js';
import { statusMap as nipponExpress } from '../../carriers/nippon-express/status.js';
import { statusMap as noLimit } from '../../carriers/no-limit/status.js';
import { statusMap as noest } from '../../carriers/noest/status.js';
import { statusMap as norskGlobal } from '../../carriers/norsk-global/status.js';
import { statusMap as northline } from '../../carriers/northline/status.js';
import { statusMap as novaGlobal } from '../../carriers/nova-global/status.js';
import { statusMap as novaPoshta } from '../../carriers/nova-poshta/status.js';
import { statusMap as nowCouriers } from '../../carriers/now-couriers/status.js';
import { statusMap as nox } from '../../carriers/nox/status.js';
import { statusMap as nzCouriers } from '../../carriers/nz-couriers/status.js';
import { statusMap as nzPost } from '../../carriers/nz-post/status.js';
import { statusMap as oakHarbor } from '../../carriers/oak-harbor/status.js';
import { statusMap as oca } from '../../carriers/oca/status.js';
import { statusMap as ocasa } from '../../carriers/ocasa/status.js';
import { statusMap as ocsAna } from '../../carriers/ocs-ana/status.js';
import { statusMap as oldDominion } from '../../carriers/old-dominion/status.js';
import { statusMap as olvaCourier } from '../../carriers/olva-courier/status.js';
import { statusMap as omgo } from '../../carriers/omgo/status.js';
import { statusMap as omniva } from '../../carriers/omniva/status.js';
import { statusMap as oneWorldExpress } from '../../carriers/one-world-express/status.js';
import { statusMap as ontrac } from '../../carriers/ontrac/status.js';
import { statusMap as optimaOvernight } from '../../carriers/optima-overnight/status.js';
import { statusMap as orlenPaczka } from '../../carriers/orlen-paczka/status.js';
import { statusMap as osmWorldwide } from '../../carriers/osm-worldwide/status.js';
import { statusMap as ozonLogistics } from '../../carriers/ozon-logistics/status.js';
import { statusMap as paack } from '../../carriers/paack/status.js';
import { statusMap as packMan } from '../../carriers/pack-man/status.js';
import { statusMap as packeta } from '../../carriers/packeta/status.js';
import { statusMap as packlink } from '../../carriers/packlink/status.js';
import { statusMap as packs } from '../../carriers/packs/status.js';
import { statusMap as pactic } from '../../carriers/pactic/status.js';
import { statusMap as pakistanPost } from '../../carriers/pakistan-post/status.js';
import { statusMap as palletways } from '../../carriers/palletways/status.js';
import { statusMap as panduLogistics } from '../../carriers/pandu-logistics/status.js';
import { statusMap as paperfly } from '../../carriers/paperfly/status.js';
import { statusMap as paquetexpress } from '../../carriers/paquetexpress/status.js';
import { statusMap as parcelabc } from '../../carriers/parcelabc/status.js';
import { statusMap as parcelpoint } from '../../carriers/parcelpoint/status.js';
import { statusMap as passport } from '../../carriers/passport/status.js';
import { statusMap as pathaoCourier } from '../../carriers/pathao-courier/status.js';
import { statusMap as pbt } from '../../carriers/pbt/status.js';
import { statusMap as pcpExpress } from '../../carriers/pcp-express/status.js';
import { statusMap as pcsLogisticsVn } from '../../carriers/pcs-logistics-vn/status.js';
import { statusMap as pdnExpress } from '../../carriers/pdn-express/status.js';
import { statusMap as pdqChile } from '../../carriers/pdq-chile/status.js';
import { statusMap as pecom } from '../../carriers/pecom/status.js';
import { statusMap as pengyou } from '../../carriers/pengyou/status.js';
import { statusMap as pfcExpress } from '../../carriers/pfc-express/status.js';
import { statusMap as phlpost } from '../../carriers/phlpost/status.js';
import { statusMap as pflogistics } from '../../carriers/pflogistics/status.js';
import { statusMap as pilotFreight } from '../../carriers/pilot-freight/status.js';
import { statusMap as pinAg } from '../../carriers/pin-ag/status.js';
import { statusMap as pitneyBowes } from '../../carriers/pitney-bowes/status.js';
import { statusMap as pittOhio } from '../../carriers/pitt-ohio/status.js';
import { statusMap as planzer } from '../../carriers/planzer/status.js';
import { statusMap as pocztaPolska } from '../../carriers/poczta-polska/status.js';
import { statusMap as posIndonesia } from '../../carriers/pos-indonesia/status.js';
import { statusMap as posMalaysia } from '../../carriers/pos-malaysia/status.js';
import { statusMap as postHaste } from '../../carriers/post-haste/status.js';
import { statusMap as postLuxembourg } from '../../carriers/post-luxembourg/status.js';
import { statusMap as postaFaroe } from '../../carriers/posta-faroe/status.js';
import { statusMap as postaKenya } from '../../carriers/posta-kenya/status.js';
import { statusMap as postaNorthMacedonia } from '../../carriers/posta-north-macedonia/status.js';
import { statusMap as postaRomana } from '../../carriers/posta-romana/status.js';
import { statusMap as postaShqiptare } from '../../carriers/posta-shqiptare/status.js';
import { statusMap as postaSlovenije } from '../../carriers/posta-slovenije/status.js';
import { statusMap as postaSrbije } from '../../carriers/posta-srbije/status.js';
import { statusMap as posteItaliane } from '../../carriers/poste-italiane/status.js';
import { statusMap as postex } from '../../carriers/postex/status.js';
import { statusMap as posti } from '../../carriers/posti/status.js';
import { statusMap as postlogistics } from '../../carriers/postlogistics/status.js';
import { statusMap as postmediaParcelServices } from '../../carriers/postmedia-parcel-services/status.js';
import { statusMap as postnord } from '../../carriers/postnord/status.js';
import { statusMap as posturinn } from '../../carriers/posturinn/status.js';
import { statusMap as ppl } from '../../carriers/ppl/status.js';
import { statusMap as precisionDeliveries } from '../../carriers/precision-deliveries/status.js';
import { statusMap as proCarrier } from '../../carriers/pro-carrier/status.js';
import { statusMap as promptXpress } from '../../carriers/prompt-xpress/status.js';
import { statusMap as proships } from '../../carriers/proships/status.js';
import { statusMap as ptsWorldwideExpress } from '../../carriers/pts-worldwide-express/status.js';
import { statusMap as ptt } from '../../carriers/ptt/status.js';
import { statusMap as pullmanCargo } from '../../carriers/pullman-cargo/status.js';
import { statusMap as purolator } from '../../carriers/purolator/status.js';
import { statusMap as quantiumSolutions } from '../../carriers/quantium-solutions/status.js';
import { statusMap as quickRabbit } from '../../carriers/quick-rabbit/status.js';
import { statusMap as quicksilverSa } from '../../carriers/quicksilver-sa/status.js';
import { statusMap as quiqup } from '../../carriers/quiqup/status.js';
import { statusMap as qwintry } from '../../carriers/qwintry/status.js';
import { statusMap as raben } from '../../carriers/raben/status.js';
import { statusMap as ramHandToHand } from '../../carriers/ram-hand-to-hand/status.js';
import { statusMap as redpack } from '../../carriers/redpack/status.js';
import { statusMap as redur } from '../../carriers/redur/status.js';
import { statusMap as rexIndonesia } from '../../carriers/rex-indonesia/status.js';
import { statusMap as redx } from '../../carriers/redx/status.js';
import { statusMap as relaisColis } from '../../carriers/relais-colis/status.js';
import { statusMap as relaytech } from '../../carriers/relaytech/status.js';
import { statusMap as rivigo } from '../../carriers/rivigo/status.js';
import { statusMap as rlCarriers } from '../../carriers/rl-carriers/status.js';
import { statusMap as roadrunner } from '../../carriers/roadrunner/status.js';
import { statusMap as royalExpressMm } from '../../carriers/royal-express-mm/status.js';
import { statusMap as royalMail } from '../../carriers/royal-mail/status.js';
import { statusMap as rpxIndonesia } from '../../carriers/rpx-indonesia/status.js';
import { statusMap as saia } from '../../carriers/saia/status.js';
import { statusMap as sagawa } from '../../carriers/sagawa/status.js';
import { statusMap as safexpress } from '../../carriers/safexpress/status.js';
import { statusMap as sagawaGlobal } from '../../carriers/sagawa-global/status.js';
import { statusMap as safewayExpressCargo } from '../../carriers/safeway-express-cargo/status.js';
import { statusMap as sailpost } from '../../carriers/sailpost/status.js';
import { statusMap as sameday } from '../../carriers/sameday/status.js';
import { statusMap as sapxExpress } from '../../carriers/sapx-express/status.js';
import { statusMap as satUkraine } from '../../carriers/sat-ukraine/status.js';
import { statusMap as saudiPost } from '../../carriers/saudi-post/status.js';
import { statusMap as seino } from '../../carriers/seino/status.js';
import { statusMap as seko } from '../../carriers/seko/status.js';
import { statusMap as sendex } from '../../carriers/sendex/status.js';
import { statusMap as sendle } from '../../carriers/sendle/status.js';
import { statusMap as sending } from '../../carriers/sending/status.js';
import { statusMap as serpost } from '../../carriers/serpost/status.js';
import { statusMap as servientrega } from '../../carriers/servientrega/status.js';
import { statusMap as seur } from '../../carriers/seur/status.js';
import { statusMap as sfExpress } from '../../carriers/sf-express/status.js';
import { statusMap as sfc } from '../../carriers/sfc/status.js';
import { statusMap as shadowfax } from '../../carriers/shadowfax/status.js';
import { statusMap as shipa } from '../../carriers/shipa/status.js';
import { statusMap as shipblu } from '../../carriers/shipblu/status.js';
import { statusMap as shipentegra } from '../../carriers/shipentegra/status.js';
import { statusMap as shiprocket } from '../../carriers/shiprocket/status.js';
import { statusMap as shipglobalIn } from '../../carriers/shipglobal-in/status.js';
import { statusMap as shouwu } from '../../carriers/shouwu/status.js';
import { statusMap as shreeAnjani } from '../../carriers/shree-anjani/status.js';
import { statusMap as shreeMaruti } from '../../carriers/shree-maruti/status.js';
import { statusMap as singaporePost } from '../../carriers/singapore-post/status.js';
import { statusMap as skroutzLastMile } from '../../carriers/skroutz-last-mile/status.js';
import { statusMap as skybox } from '../../carriers/skybox/status.js';
import { statusMap as skyking } from '../../carriers/skyking/status.js';
import { statusMap as skynetSa } from '../../carriers/skynet-sa/status.js';
import { statusMap as skynetWorldwide } from '../../carriers/skynet-worldwide/status.js';
import { statusMap as skypostal } from '../../carriers/skypostal/status.js';
import { statusMap as slgtrax } from '../../carriers/slgtrax/status.js';
import { statusMap as slovakParcelService } from '../../carriers/slovak-parcel-service/status.js';
import { statusMap as slovenskaPosta } from '../../carriers/slovenska-posta/status.js';
import { statusMap as smsaExpress } from '../../carriers/smsa-express/status.js';
import { statusMap as southAfricanPost } from '../../carriers/south-african-post-office/status.js';
import { statusMap as southeasternFreightLines } from '../../carriers/southeastern-freight-lines/status.js';
import { statusMap as spExpress } from '../../carriers/sp-express/status.js';
import { statusMap as speeDee } from '../../carriers/spee-dee/status.js';
import { statusMap as speedAndSafe } from '../../carriers/speed-and-safe/status.js';
import { statusMap as speedaf } from '../../carriers/speedaf/status.js';
import { statusMap as speedex } from '../../carriers/speedex/status.js';
import { statusMap as speedpak } from '../../carriers/speedpak/status.js';
import { statusMap as speedx } from '../../carriers/speedx/status.js';
import { statusMap as speedy } from '../../carriers/speedy/status.js';
import { statusMap as springGds } from '../../carriers/spring-gds/status.js';
import { statusMap as spxBr } from '../../carriers/spx-br/status.js';
import { statusMap as spxId } from '../../carriers/spx-id/status.js';
import { statusMap as spxMy } from '../../carriers/spx-my/status.js';
import { statusMap as spxPh } from '../../carriers/spx-ph/status.js';
import { statusMap as spxSg } from '../../carriers/spx-sg/status.js';
import { statusMap as spxTh } from '../../carriers/spx-th/status.js';
import { statusMap as spxTw } from '../../carriers/spx-tw/status.js';
import { statusMap as spxVn } from '../../carriers/spx-vn/status.js';
import { statusMap as stCourier } from '../../carriers/st-courier/status.js';
import { statusMap as stallionExpress } from '../../carriers/stallion-express/status.js';
import { statusMap as starexAz } from '../../carriers/starex-az/status.js';
import { statusMap as starken } from '../../carriers/starken/status.js';
import { statusMap as starlinksGlobal } from '../../carriers/starlinks-global/status.js';
import { statusMap as sto } from '../../carriers/sto/status.js';
import { statusMap as stone3pl } from '../../carriers/stone3pl/status.js';
import { statusMap as straightship } from '../../carriers/straightship/status.js';
import { statusMap as sundarbanCourier } from '../../carriers/sundarban-courier/status.js';
import { statusMap as sunyou } from '../../carriers/sunyou/status.js';
import { statusMap as swiftx } from '../../carriers/swiftx/status.js';
import { statusMap as swissPost } from '../../carriers/swiss-post/status.js';
import { statusMap as swissPostCargo } from '../../carriers/swiss-post-cargo/status.js';
import { statusMap as tCat } from '../../carriers/t-cat/status.js';
import { statusMap as tGroup } from '../../carriers/t-group/status.js';
import { statusMap as tanzaniaPosts } from '../../carriers/tanzania-posts/status.js';
import { statusMap as taxydema } from '../../carriers/taxydema/status.js';
import { statusMap as tccCo } from '../../carriers/tcc-co/status.js';
import { statusMap as taqbinHk } from '../../carriers/taqbin-hk/status.js';
import { statusMap as tciExpress } from '../../carriers/tci-express/status.js';
import { statusMap as tcsPakistan } from '../../carriers/tcs-pakistan/status.js';
import { statusMap as tdn } from '../../carriers/tdn/status.js';
import { statusMap as tealca } from '../../carriers/tealca/status.js';
import { statusMap as teamExpressAe } from '../../carriers/team-express-ae/status.js';
import { statusMap as teamGlobalExpress } from '../../carriers/team-global-express/status.js';
import { statusMap as teamWorldwide } from '../../carriers/team-worldwide/status.js';
import { statusMap as techlink } from '../../carriers/techlink/status.js';
import { statusMap as teleship } from '../../carriers/teleship/status.js';
import { statusMap as tfmExpress } from '../../carriers/tfm-express/status.js';
import { statusMap as tforceFreight } from '../../carriers/tforce-freight/status.js';
import { statusMap as thailandPost } from '../../carriers/thailand-post/status.js';
import { statusMap as theCourierGuy } from '../../carriers/the-courier-guy/status.js';
import { statusMap as thhy } from '../../carriers/thhy/status.js';
import { statusMap as tiki } from '../../carriers/tiki/status.js';
import { statusMap as timelyTitan } from '../../carriers/timely-titan/status.js';
import { statusMap as tipsa } from '../../carriers/tipsa/status.js';
import { statusMap as tirupatiCourier } from '../../carriers/tirupati-courier/status.js';
import { statusMap as tmmExpress } from '../../carriers/tmm-express/status.js';
import { statusMap as tnt } from '../../carriers/tnt/status.js';
import { statusMap as tntAu } from '../../carriers/tnt-au/status.js';
import { statusMap as tntIt } from '../../carriers/tnt-it/status.js';
import { statusMap as todayKr } from '../../carriers/today-kr/status.js';
import { statusMap as tonami } from '../../carriers/tonami/status.js';
import { statusMap as toptrans } from '../../carriers/toptrans/status.js';
import { statusMap as topyou } from '../../carriers/topyou/status.js';
import { statusMap as torrestir } from '../../carriers/torrestir/status.js';
import { statusMap as totalExpress } from '../../carriers/total-express/status.js';
import { statusMap as toyou } from '../../carriers/toyou/status.js';
import { statusMap as trackon } from '../../carriers/trackon/status.js';
import { statusMap as tracxLogis } from '../../carriers/tracx-logis/status.js';
import { statusMap as transaher } from '../../carriers/transaher/status.js';
import { statusMap as transcorp } from '../../carriers/transcorp/status.js';
import { statusMap as trendyolExpress } from '../../carriers/trendyol-express/status.js';
import { statusMap as transmission } from '../../carriers/transmission/status.js';
import { statusMap as tsjy } from '../../carriers/tsjy/status.js';
import { statusMap as tstCfExpress } from '../../carriers/tst-cf-express/status.js';
import { statusMap as tufesa } from '../../carriers/tufesa/status.js';
import { statusMap as twsExpress } from '../../carriers/tws-express/status.js';
import { statusMap as ubiSmartParcel } from '../../carriers/ubi-smart-parcel/status.js';
import { statusMap as ukpWorldwide } from '../../carriers/ukp-worldwide/status.js';
import { statusMap as ukrposhta } from '../../carriers/ukrposhta/status.js';
import { statusMap as unitedDeliveryService } from '../../carriers/united-delivery-service/status.js';
import { statusMap as uniuni } from '../../carriers/uniuni/status.js';
import { statusMap as upaya } from '../../carriers/upaya/status.js';
import { statusMap as ups } from '../../carriers/ups/status.js';
import { statusMap as urbano } from '../../carriers/urbano/status.js';
import { statusMap as urvaam } from '../../carriers/urvaam/status.js';
import { statusMap as usps } from '../../carriers/usps/status.js';
import { statusMap as uzbekistanPost } from '../../carriers/uzbekistan-post/status.js';
import { statusMap as valmo } from '../../carriers/valmo/status.js';
import { statusMap as vaspExpresso } from '../../carriers/vasp-expresso/status.js';
import { statusMap as veloces } from '../../carriers/veloces/status.js';
import { statusMap as venipak } from '../../carriers/venipak/status.js';
import { statusMap as viaCargo } from '../../carriers/via-cargo/status.js';
import { statusMap as viadireta } from '../../carriers/viadireta/status.js';
import { statusMap as viettelPost } from '../../carriers/viettel-post/status.js';
import { statusMap as vimenpaq } from '../../carriers/vimenpaq/status.js';
import { statusMap as vintedGo } from '../../carriers/vinted-go/status.js';
import { statusMap as vozovoz } from '../../carriers/vozovoz/status.js';
import { statusMap as vrlLogistics } from '../../carriers/vrl-logistics/status.js';
import { statusMap as wanbexpress } from '../../carriers/wanbexpress/status.js';
import { statusMap as weWorldExpress } from '../../carriers/we-world-express/status.js';
import { statusMap as whistl } from '../../carriers/whistl/status.js';
import { statusMap as whizDelivery } from '../../carriers/whiz-delivery/status.js';
import { statusMap as wiio } from '../../carriers/wiio/status.js';
import { statusMap as winit } from '../../carriers/winit/status.js';
import { statusMap as xdeLogistics } from '../../carriers/xde-logistics/status.js';
import { statusMap as xdp } from '../../carriers/xdp/status.js';
import { statusMap as xgs } from '../../carriers/xgs/status.js';
import { statusMap as xingheFreight } from '../../carriers/xinghe-freight/status.js';
import { statusMap as xlcourier } from '../../carriers/xlcourier/status.js';
import { statusMap as xpoLtl } from '../../carriers/xpo-ltl/status.js';
import { statusMap as xpressbees } from '../../carriers/xpressbees/status.js';
import { statusMap as yalidine } from '../../carriers/yalidine/status.js';
import { statusMap as yamato } from '../../carriers/yamato/status.js';
import { statusMap as yanwen } from '../../carriers/yanwen/status.js';
import { statusMap as yunda } from '../../carriers/yunda/status.js';
import { statusMap as ywe } from '../../carriers/ywe/status.js';
import { statusMap as ycsLogistics } from '../../carriers/ycs-logistics/status.js';
import { statusMap as ydh } from '../../carriers/ydh/status.js';
import { statusMap as zto } from '../../carriers/zto/status.js';
import { statusMap as ztoInternational } from '../../carriers/zto-international/status.js';
import { statusMap as yto } from '../../carriers/yto/status.js';
import { statusMap as yunexpress } from '../../carriers/yunexpress/status.js';
import { statusMap as yilongLogistics } from '../../carriers/yilong-logistics/status.js';
import { statusMap as yurticiKargo } from '../../carriers/yurtici-kargo/status.js';
import { statusMap as yypost } from '../../carriers/yypost/status.js';
import { statusMap as zajil } from '../../carriers/zajil/status.js';
import { statusMap as zeleris } from '../../carriers/zeleris/status.js';
import { statusMap as zoomVe } from '../../carriers/zoom-ve/status.js';
import { statusMap as zrExpress } from '../../carriers/zr-express/status.js';
import type { CarrierId, Stage } from '../../generated/catalog.js';
import { statusMap as universal } from '../../providers/status.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../status/statusMap.js';
import { CARRIER_DEFINITIONS } from './definitions.js';

/** By adapter: a carrier served by another's adapter, as Delivengo by La Poste's, reads that map. */
export const STATUS_MAPS: Readonly<Record<string, CarrierStatusMap>> = {
  'nepal-post': nepalPost, 'russian-post': russianPost, 'surat-kargo': suratKargo,
  '17feia': seventeenFeia, '2go': twoGo, '4-72': fourSeventyTwo, '4sides': fourSides, '5post': fivePost, '99minutos': ninetynineMinutos,
  'a-duie-pyle': aDuiePyle, 'a-tu-hora-express': aTuHoraExpress, 'a1-post': a1Post, 'ab-courier': abCourier, 'abf-freight': abfFreight, 'aci-express-kr': aciExpressKr,
  'acs-courier': acsCourier, 'aex-paraguay': aexParaguay, 'airpak-express': airpakExpress, 'ait-worldwide': aitWorldwide, ajex,
  'algerie-poste': algeriePoste, aliexpress, 'allegro-one': allegroOne, 'am-home-delivery': amHomeDelivery, 'amazon-shipping': amazonShipping, 'american-west-express': americanWestExpress, amerijet, ampm, 'an-post': anPost, 'anc-delivers': ancDelivers,
  andreani, anjun, anousith, anserx, anteraja, 'apc-overnight': apcOvernight, 'apc-postal-logistics': apcPostalLogistics,
  'apple-express': appleExpress, aquiline, aramex, 'aramex-au': aramexAu,
  'aramex-nz': aramexNz, 'aras-kargo': arasKargo, 'arrow-xl': arrowXl, asendia, 'asyad-express': asyadExpress, 'atlantic-courier': atlanticCourier, 'ats-healthcare': atsHealthcare, 'australia-post': australiaPost, 'austrian-post': austrianPost, averitt, aymakan, 'bangladesh-post': bangladeshPost,
  'barid-al-maghrib': baridAlMaghrib, belpost, 'best-overnite-express': bestOverniteExpress, bestfulfill, 'better-trucks': betterTrucks, 'bex-express': bexExpress, 'bjs-home-delivery': bjsHomeDelivery, 'blue-dart': blueDart, 'blue-express': blueExpress, blueex, bombino,
  bookurier, 'border-express': borderExpress, bosta, 'box-now': boxNow, boxtal, bpost, 'bring-posten': bringPosten, 'bringer-parcel': bringerParcel, brt, 'bulgarian-posts': bulgarianPosts, 'burd-delivery': burdDelivery, bussgods,
  byhd, 'c-chez-vous': cChezVous, c3x, cacesa, 'canada-post': canadaPost, canpar, cargus, 'castle-parcels': castleParcels, castores, 'cbl-logistica': cblLogistica, ccfs, cdek, cdl, celeritas,
  'central-transport': centralTransport, 'ceska-posta': ceskaPosta, 'ceva-logistics': cevaLogistics, chazki, chilexpress, 'china-post': chinaPost,
  'chit-chats': chitChats, chronodiali, chronopost, chukou1, 'chunghwa-post': chunghwaPost, chunil, ciblex, citilogistics, 'city-express-rs': cityExpressRs, 'citylink-express': citylinkExpress, citymail,
  'cj-logistics': cjLogistics, 'cj-packet': cjPacket, 'closer-logistics': closerLogistics, cne, 'colis-prive': colisPrive, colisweb, 'connect-couriers': connectCouriers, consegnia, coordinadora,
  'copa-courier': copaCourier, corre,
  'correios-br': correiosBr, 'correo-argentino': correoArgentino, 'correo-uruguayo': correoUruguayo, 'correos-chile': correosChile, 'correos-cuba': correosCuba, 'correos-de-mexico': correosDeMexico, 'correos-el-salvador': correosElSalvador, 'correos-express': correosExpress, 'correos-spain': correosSpain,
  'courier-center': courierCenter, couriersplease: couriersPlease, 'cruz-del-sur': cruzDelSur, 'cse-russia': cseRussia, ctt, 'ctt-express': cttExpress, cttyex,
  'cyprus-post': cyprusPost, 'd-express': dExpress, dachser, 'dai-post': daiPost, 'danske-fragtmaend': danskeFragtmaend, dao, 'day-ross': dayRoss,
  dayone, 'daylight-transport': daylightTransport, 'dayton-freight': daytonFreight, dealersend, delhivery, dellin, delnext, deppon, dhl, 'dhl-ecommerce': dhlEcommerce, 'dhl-ecommerce-es': dhlEcommerceEs, 'dhl-ecommerce-nl': dhlEcommerceNl, 'dhl-ecommerce-pl': dhlEcommercePl, 'dhl-ecommerce-uk': dhlEcommerceUk, 'dhl-express': dhlExpress,
  'dhl-freight': dhlFreight, dhlink, direx, dobropost, 'dohrn-transfer': dohrnTransfer, 'domain-logistics': domainLogistics, domex, dpd,
  'dpd-at': dpdAt, 'dpd-be': dpdBe, 'dpd-de': dpdDe, 'dpd-fr': dpdFr, 'dpd-hu': dpdHu, 'dpd-ie': dpdIe,
  'dpd-nl': dpdNl, 'dpd-pl': dpdPl, 'dpd-pt': dpdPt, 'dpd-ro': dpdRo, 'dpd-uk': dpdUk, 'dpd-za': dpdZa, dpex, 'dragon-star-curier': dragonStarCurier, drop2shop, dropp, dsv, dtdc, dx, dynalogic,
  'e-commerce-international': eCommerceInternational, 'early-bird': earlyBird, 'easy-mail': easyMail,
  'ecms-express': ecmsExpress, 'ecom-logistics': ecomLogistics, econt, ecoscooting, ecourier, 'egypt-post': egyptPost, egxpress, ekart, elta, emile, 'emirates-post': emiratesPost, ems, 'ems-vietnam': emsVietnam, 'energia-tk': energiaTk, 'envia-colombia': enviaColombia,
  envialia, 'eparcel-kr': eparcelKr, 'epost-global': epostGlobal, equick, estafeta, estes, 'estes-forwarding': estesForwarding, eurodis, 'euroexpress-ba': euroexpressBa, europochta, eushipments,
  'evdemo-lojistik': evdemoLojistik, evri, 'evri-uk': evriUk, evropat, ewe, exelot,
  'exline-kz': exlineKz, exmate, 'express-one': expressOne, 'express-one-bg': expressOneBg, 'fan-courier': fanCourier, 'far-international': farInternational, 'fargo-courier': fargoCourier, 'fargo-uz': fargoUz, fastbox, fastdrop,
  fastfrate, fedex, 'fedex-freight': fedexFreight, 'fedex-international-connect': fedexInternationalConnect, 'fedex-pl': fedexPl, fermopoint, 'fg-delivery': fgDelivery, 'first-line': firstLine,
  'flash-express': flashExpress,
  'flash-express-ph': flashExpressPh,
  'flashbird-ca': flashbirdCa,
  fleetex, fleetoptics, flippost, fmx, followmont, 'fm-transportes': fmTransportes, 'forward-air': forwardAir, 'forza-delivery': forzaDelivery, 'four-px': fourPx, foxpost, 'franch-express': franchExpress, fukuyama, gaash, gati, gdex,
  'gebrueder-weiss': gebruederWeiss, geis, 'geniki-taxydromiki': geniki, geodis, 'geodis-pl': geodisPl, 'gig-logistics': gigLogistics, 'global-delivery-network': globalDeliveryNetwork, 'gls-ch': glsCh, 'gls-de': glsDe, 'gls-es': glsEs, 'gls-fr': glsFr, 'gls-it': glsIt,
  globalpost, 'gms-worldwide': gmsWorldwide, 'go-express': goExpress, 'go-logistics-au': goLogisticsAu, go4, gobolt, gofo, 'gofo-ca': gofoCa, 'gofo-es': gofoEs, 'gofo-fr': gofoFr, 'gofo-it': gofoIt, 'gofo-nl': gofoNl, 'gogo-xpress': gogoXpress,
  'grand-slam-express': grandSlamExpress, 'gs-postbox': gsPostbox, 'gsi-express': gsiExpress, 'gta-airskip': gtaAirskip, 'gtl-goto': gtlGoto, guatex, gzyl,
  hanjin, 'happy-post': happyPost, haypost, 'hct-logistics': hctLogistics, helthjem, heppner, hepsijet, hermes, 'hermes-at': hermesAt, 'hermes-de': hermesDe, hitch, hispapost, homexpress, 'hongkong-post': hongkongPost,
  horoz, 'houng-ah-loun': houngAhLoun, hovership, 'hr-parcel': hrParcel, 'hrvatska-posta': hrvatskaPosta, huahan, 'huaya-express': huayaExpress, 'hunter-express': hunterExpress, hywl,
  'icc-worldwide': iccWorldwide, 'ics-courier': icsCourier, 'ids-logistik': idsLogistik, 'ilyang-logis': ilyangLogis, imile,
  'indah-logistik': indahLogistik, 'india-post': indiaPost, inpost, instabox, 'integral-pack': integralPack, 'intel-valley': intelValley, intelcom, 'internet-express': internetExpress, interrapidisimo,
  'intex-paketdienst': intexPaketdienst, 'israel-post': israelPost, 'j-and-t': jAndT, 'j-and-t-au': jAndTAu, 'j-and-t-de': jAndTDe, 'j-and-t-uk': jAndTUk, 'j-and-t-cargo': jntCargo,
  'j-and-t-middle-east': jAndTMiddleEast, janio, 'japan-post': japanPost, jcex, 'jd-logistics': jdLogistics, jeebly, 'jersey-post': jerseyPost, 'jet-logistic': jetLogistic, 'jetline-couriers': jetlineCouriers,
  jhgj, jifan, jitsu, jne, 'jordan-post': jordanPost, jrt, 'js-express': jsExpress, jumppoint, kazpost, kex, 'kex-express-hk': kexExpressHk,
  'kit-tk': kitTk, 'komon-express': komonExpress, 'korea-post': koreaPost, 'kolay-gelsin': kolayGelsin, 'kuehne-nagel': kuehneNagel, 'kun-express': kunExpress, kunyoung, kyoungdong, 'kyrgyz-post': kyrgyzPost, 'l-post': lPost, 'la-poste': laPoste,
  'la-poste-burkina-faso': laPosteBurkinaFaso, 'la-poste-senegal': laPosteSenegal, 'laar-courier': laarCourier, labaih,
  'landmark-global': landmarkGlobal, 'last-one-mile-coop': lastOneMileCoop, 'latvijas-pasts': latvijasPasts, 'lbc-express': lbcExpress, 'lex-id': lexId, 'lex-my': lexMy, 'leopards-courier': leopardsCourier, liccardi, 'linear-logistics': linearLogistics,
  'lietuvos-pastas': lietuvosPastas, 'lightning-express': lightningExpress,
  'line-clear': lineClear, lingdong, linhan, 'lion-parcel': lionParcel, logen, loggi, logisimple, logistiq, logoix, 'loomis-express': loomisExpress,
  'lotte-global': lotteGlobal, 'm-and-p': mAndP, 'm-one': mOne, 'madhur-courier': madhurCourier, 'magyar-posta': magyarPosta, mailamericas, 'mailplus-au': mailplusAu, mainfreight,
  'maersk-ecommerce': maerskEcommerce, 'makati-express': makatiExpress, maltapost, 'maritime-ontario': maritimeOntario, 'maruti-air': marutiAir, matkahuolto, 'mauritius-post': mauritiusPost, mayiyinfu,
  'mds-collivery': mdsCollivery, meest, 'meihoo-pegasus': meihooPegasus, 'meso-global': mesoGlobal, 'messenger-cz': messengerCz, 'metropolitan-warehouse': metropolitanWarehouse, mhi, 'micro-express': microExpress,
  'midland-transport': midlandTransport, 'mng-kargo': mngKargo, 'mondial-relay': mondialRelay, 'mongol-infinity-post': mongolInfinityPost, 'morning-global': morningGlobal, 'mrl-global': mrlGlobal, mrw, mtscn, mylerz, nacex, naqel, nationex,
  'next-level-delivery': nextLevelDelivery, 'nim-express': nimExpress, 'ninja-van': ninjaVan, nipost, 'nippon-express': nipponExpress, 'no-limit': noLimit, noest, 'norsk-global': norskGlobal,
  northline, 'nova-global': novaGlobal, 'nova-poshta': novaPoshta, 'now-couriers': nowCouriers, nox, 'nz-couriers': nzCouriers, 'nz-post': nzPost, 'oak-harbor': oakHarbor, oca, ocasa, 'ocs-ana': ocsAna,
  'old-dominion': oldDominion, 'olva-courier': olvaCourier, omgo, omniva,
  'one-world-express': oneWorldExpress, ontrac, 'optima-overnight': optimaOvernight, 'orlen-paczka': orlenPaczka, 'osm-worldwide': osmWorldwide, 'ozon-logistics': ozonLogistics, paack, 'pack-man': packMan, packeta, packlink, packs, pactic,
  'pakistan-post': pakistanPost, palletways, 'pandu-logistics': panduLogistics, paperfly, paquetexpress, parcelabc, parcelpoint, passport,
  'pathao-courier': pathaoCourier, pbt, 'pcp-express': pcpExpress, 'pcs-logistics-vn': pcsLogisticsVn, 'pdn-express': pdnExpress,
  'pdq-chile': pdqChile, pecom, pengyou, 'pfc-express': pfcExpress, phlpost, pflogistics, 'pilot-freight': pilotFreight, 'pin-ag': pinAg,
  'pitney-bowes': pitneyBowes, 'pitt-ohio': pittOhio, planzer, 'poczta-polska': pocztaPolska, 'pos-indonesia': posIndonesia,
  'pos-malaysia': posMalaysia, 'post-haste': postHaste, 'post-luxembourg': postLuxembourg, 'posta-faroe': postaFaroe, 'posta-kenya': postaKenya, 'posta-north-macedonia': postaNorthMacedonia, 'posta-romana': postaRomana,
  'posta-shqiptare': postaShqiptare,
  'posta-slovenije': postaSlovenije, 'posta-srbije': postaSrbije, 'poste-italiane': posteItaliane, postex, posti, postlogistics, 'postmedia-parcel-services': postmediaParcelServices,
  postnord, posturinn, ppl, 'precision-deliveries': precisionDeliveries,
  'pro-carrier': proCarrier, 'prompt-xpress': promptXpress, proships, 'pts-worldwide-express': ptsWorldwideExpress, ptt, 'pullman-cargo': pullmanCargo, purolator, 'quantium-solutions': quantiumSolutions,
  'quick-rabbit': quickRabbit, 'quicksilver-sa': quicksilverSa, quiqup, qwintry, raben, 'ram-hand-to-hand': ramHandToHand, redpack, redur, 'rex-indonesia': rexIndonesia, redx, 'relais-colis': relaisColis, relaytech,
  rivigo, 'rl-carriers': rlCarriers, roadrunner, 'royal-express-mm': royalExpressMm, 'royal-mail': royalMail,
  'rpx-indonesia': rpxIndonesia, 'safeway-express-cargo': safewayExpressCargo, sagawa, safexpress, 'sagawa-global': sagawaGlobal, saia, sailpost, sameday, 'sapx-express': sapxExpress,
  'sat-ukraine': satUkraine, 'saudi-post': saudiPost, seino, seko, sendex, sendle, sending, serpost, servientrega, seur, 'sf-express': sfExpress, sfc, shadowfax, shipa, shipblu, shipentegra, shiprocket, 'shipglobal-in': shipglobalIn, shouwu,
  'shree-anjani': shreeAnjani, 'shree-maruti': shreeMaruti, 'singapore-post': singaporePost, 'skroutz-last-mile': skroutzLastMile,
  skybox, skyking, 'skynet-sa': skynetSa, 'skynet-worldwide': skynetWorldwide, skypostal, slgtrax,
  'slovak-parcel-service': slovakParcelService,
  'slovenska-posta': slovenskaPosta, 'smsa-express': smsaExpress, 'south-african-post-office': southAfricanPost,
  'southeastern-freight-lines': southeasternFreightLines, 'sp-express': spExpress, 'spee-dee': speeDee, 'speed-and-safe': speedAndSafe, speedaf, speedex, speedpak, speedx, speedy, 'spring-gds': springGds, 'spx-br': spxBr, 'spx-id': spxId, 'spx-my': spxMy, 'spx-sg': spxSg,
  'spx-ph': spxPh, 'spx-th': spxTh, 'spx-tw': spxTw, 'spx-vn': spxVn, 'st-courier': stCourier, 'stallion-express': stallionExpress, 'starex-az': starexAz, starken, 'starlinks-global': starlinksGlobal, sto, stone3pl, straightship, 'sundarban-courier': sundarbanCourier, sunyou, swiftx, 'swiss-post': swissPost, 'swiss-post-cargo': swissPostCargo,
  't-cat': tCat, 't-group': tGroup, 'tanzania-posts': tanzaniaPosts, taxydema, 'taqbin-hk': taqbinHk, 'tcc-co': tccCo, 'tci-express': tciExpress, 'tcs-pakistan': tcsPakistan, tdn, tealca,
  'team-express-ae': teamExpressAe, 'team-global-express': teamGlobalExpress, 'team-worldwide': teamWorldwide, techlink, teleship, 'tfm-express': tfmExpress, 'tforce-freight': tforceFreight,
  'thailand-post': thailandPost, 'the-courier-guy': theCourierGuy, thhy, tiki, 'timely-titan': timelyTitan, tipsa, 'tirupati-courier': tirupatiCourier, 'tmm-express': tmmExpress, tnt, 'tnt-au': tntAu, 'tnt-it': tntIt, 'today-kr': todayKr, tonami, toptrans, topyou, torrestir, 'total-express': totalExpress, toyou,
  trackon, 'tracx-logis': tracxLogis, transaher, transcorp, transmission, 'trendyol-express': trendyolExpress, tsjy, 'tst-cf-express': tstCfExpress, tufesa, 'tws-express': twsExpress,
  'ubi-smart-parcel': ubiSmartParcel, 'ukp-worldwide': ukpWorldwide, ukrposhta,
  'united-delivery-service': unitedDeliveryService, uniuni, upaya, ups, urbano, urvaam, usps,
  'uzbekistan-post': uzbekistanPost, valmo, 'vasp-expresso': vaspExpresso, veloces, venipak, 'via-cargo': viaCargo, viadireta, 'viettel-post': viettelPost,
  vimenpaq, 'vinted-go': vintedGo, vozovoz, 'vrl-logistics': vrlLogistics, wanbexpress, 'we-world-express': weWorldExpress, whistl, 'whiz-delivery': whizDelivery, wiio, winit, 'xde-logistics': xdeLogistics, xdp, xgs, 'xinghe-freight': xingheFreight, xlcourier, 'xpo-ltl': xpoLtl, xpressbees,
  yalidine, yamato, yanwen, 'ycs-logistics': ycsLogistics, ydh, 'yilong-logistics': yilongLogistics, yto, yunexpress, yunda, ywe, yypost, zto, 'zto-international': ztoInternational,
  'yurtici-kargo': yurticiKargo, zajil, zeleris, 'zoom-ve': zoomVe, 'zr-express': zrExpress,
};

/** The carrier the app files the universal providers' scans under. */
const UNIVERSAL_CARRIER = 'unknown';

/** One scan as the app observed it. */
export interface ObservedStatus {
  /**
   * The catalog carrier that served the scan, the prefix of the app's provider
   * event id: `unknown` for a scan a universal provider relayed.
   */
  readonly carrier: string;
  readonly providerCode?: string | null;
  /** The scan's wording, as the carrier sent it or already normalized. */
  readonly description: string;
}

/**
 * What the carrier's map says about a scan: it gives the scan a stage, it
 * leaves it without one on purpose, or it does not know it.
 */
export type StatusMapAnswer =
  | { readonly kind: 'mapped'; readonly stage: Stage }
  | { readonly kind: 'intentional_gap'; readonly note: string }
  | { readonly kind: 'unknown' };

const UNKNOWN: StatusMapAnswer = { kind: 'unknown' };

function carrierStatusMap(carrier: string): CarrierStatusMap | undefined {
  if (carrier === UNIVERSAL_CARRIER) return universal;
  const adapter = Object.hasOwn(CARRIER_DEFINITIONS, carrier)
    ? CARRIER_DEFINITIONS[carrier as CarrierId].tracking.adapter
    : null;
  return adapter && Object.hasOwn(STATUS_MAPS, adapter) ? STATUS_MAPS[adapter] : undefined;
}

/**
 * What the carrier's map says about one observed scan, keyed as the app keys
 * its observations: carrier, provider code and `normalizeStatusWording`
 * wording. A gap without a code covers only wording that came without one; a
 * gap without wording covers every wording of its code; the map's `gapNote`
 * names the gaps it cannot list. A scan a universal provider relayed is
 * `mapped` with the stage the providers' reading gives it, as the sync does,
 * and `unknown` when neither its code nor a rule stages it.
 */
export function statusMapAnswer(observed: ObservedStatus): StatusMapAnswer {
  const map = carrierStatusMap(observed.carrier);
  const wording = normalizeStatusWording(observed.description);
  if (!map || !wording) return UNKNOWN;
  const code = observed.providerCode || null;
  const stage = map.stage(code, wording);
  if (stage) return { kind: 'mapped', stage };
  const key = code === null ? null : map.codeKey?.(code) ?? code;
  const gap = map.gaps.find((candidate) => (candidate.code ?? null) === key
    && (candidate.wording === undefined || candidate.wording === wording));
  const note = gap?.note ?? map.gapNote?.(code, wording);
  return note ? { kind: 'intentional_gap', note } : UNKNOWN;
}

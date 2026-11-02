/**
 * What the universal providers share once a payload has been read: the
 * tracking-number guard, the text and notice filters, the event builders with
 * their timezone policy, and the result projection that sorts, deduplicates
 * and summarizes a history.
 *
 * The wording -> stage logic below is provider vocabulary (Ship24, ParcelsApp,
 * 17TRACK and Postal Ninja all render the same aggregated scans), not a
 * carrier status map. Its decisions retain their wording-rule provenance.
 */
import { DateTime } from 'luxon';
import { trackingLanguageStage } from '../../core/status/index.js';
import { countryCode, countryKeepsOffset, usStateTimeZone } from '../../core/time/index.js';
import { CHINESE_CITIES, CHINESE_PROVINCES } from './china.js';
import { deliveryForecastRemainder, nonterminalEnglishReturn } from '../../core/status/language.js';
import type { Stage } from '../../generated/catalog.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { IndeterminateError, InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { PROGRESS } from '../../core/result/partial.js';
import { isPostiAbroadLabel } from '../../carriers/posti/identity.js';
import { anPostWordingStage } from '../../carriers/an-post/status.js';
import { CHRONOPOST_NOTIFICATION } from '../../carriers/chronopost/status.js';
import { chinaPostRelayedStage } from '../../carriers/china-post/status.js';
import { postaShqiptareScanStage } from '../../carriers/posta-shqiptare/status.js';
import { sunYouWording } from '../../carriers/sunyou/identity.js';
import { ESTIMATE as FLIGHT_ESTIMATE } from '../../carriers/tsjy/status.js';
import { FLIGHT_BOOKED as DHLINK_FLIGHT } from '../../carriers/dhlink/status.js';
import { flightBooked as intelValleyFlight } from '../../carriers/intel-valley/status.js';
import { FLIGHT_BOOKED as MAYIYINFU_FLIGHT } from '../../carriers/mayiyinfu/status.js';

export type UniversalSource = '17TRACK' | 'ParcelsApp' | 'Postal Ninja' | 'Ship24' | 'Track718' | 'Track123' | 'UPU';
const STAGES: Record<string, Stage> = {
  InfoReceived: 'registered', InTransit: 'in_transit', AvailableForPickup: 'ready_for_pickup',
  OutForDelivery: 'out_for_delivery', DeliveryFailure: 'failed_attempt', Delivered: 'delivered',
};

export function numberOf(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?=.*\d)[A-Z0-9]{4,40}$/.test(number)) throw new InvalidInputError('Tracking', 'Invalid tracking number');
  return number;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
}

// Universal sites mix carrier events with UI notices and data updates. Notices must not
// manufacture a shipment timestamp or make an electronic announcement look like movement.
// DHL's detail line "Keine weiteren Details erforderlich" ("no further details required"),
// which ParcelsApp relays as a row of its own beside DHL's scans, says nothing either.
export function isNotice(description: string): boolean {
  return /enter .*?(?:postal|post|zip|phone)|select (?:a |the )?(?:carrier|destination country)|no information about your (?:package|parcel|shipment)|tracking (?:is |temporarily )?unavailable|tracking number (?:not found|is incorrect|must (?:only )?(?:contain|consist|be)\b)|check that (?:the |your )?tracking number is correct|no tracking (?:information|data)|delivery preference|captcha|verify (?:you|your)|enable javascript|try again later|by tapping the button|^(?:shipment parameters|recipient information) updated[.!]?$|^a preferred drop-off location was booked\b|^keine weiteren details erforderlich[.!]?$/i.test(description);
}

// Raw text, so accented and plain spellings are both listed. A carrier receiving the
// parcel ("Recibido por Estafeta") and German "Firma" (a business) are not private.
export function hasPrivateDeliveryDetails(description: string): boolean {
  return /\bpin\s*:|(?:access|security|pickup|collection) code|(?:door|house) (?:no\b|number)|signed (?:for )?by|signature|numero civico|firmato da|signe par|signé par|code (?:de retrait|d['’]acc[eè]s)|num[eé]ro de (?:rue|maison)|abholcode|zugangscode|hausnummer|unterschrieben von|codice (?:di ritiro|di accesso)|c[oó]digo (?:pin|secreto|de (?:recogida|retirada|retiro|acceso|acesso|entrega|seguridad|seguran[cç]a|levantamento|recolha|desbloqueo|desbloqueio|apertura|abertura))|firmad[oa] por|firma del destinatari|assinad[oa] por|assinatura|n[uú]mero (?:de (?:portal|puerta|casa|piso|vivienda|pol[ií]cia)|da (?:porta|casa))|(?:porta|puerta) n\.?\s?[º°]|n\.?\s?[º°] (?:de |da )?porta/i.test(description);
}

// Labels providers put where a place belongs: a feed's system user ("US, SYSTEM, SYSTEM"),
// an order system's data centre, a line-haul agent, GLS Italy's unnamed sorting hub, Poczta
// Polska's "International Postal System" for a scan relayed from abroad and China Post's "目的国"
// ("destination country"), which its feed gives an airline's arrival where it names no country's code.
const NOT_PLACES = /^(?:(?:[A-Z]{2}, )?system(?:, system)*|(?:uni )?data cent(?:er|re)|linehaul agent|centro di smistamento(?: - hub)?|international postal system|the carrier|目的国)$/i;
// JCEX's places as 17TRACK relays them, followed by the row's UTC offset: a town in the United
// States with its state and postcode, "Example Town;CA;99999;-07:00", or the country JCEX files
// the row under, "US+08:00".
const OFFSET_PLACE = /^(?:([^;]{1,80});([A-Z]{2})?;[A-Z\d -]{0,10};|([A-Z]{2}))([+-]\d{2}:\d{2})$/;
// China Post's feed, as 17TRACK relays it, gives a US facility's town and state, then a town with
// the ZIP code, which can be another town's name: "Example Town, NC, Example Town 99999".
const US_FACILITY_PLACE = /^([^,]{1,60}), ([A-Z]{2}), [^,]{1,60} \d{5}(?:-\d{4})?$/;
// A postcode after the country, as 17TRACK also relays JCEX's places in the United States:
// "Example Town,CA,US,99999".
const POSTCODE_AFTER_COUNTRY = /^(.+,\s*([A-Z]{2}))\s*,\s*\d{4,6}(?:-\d{4})?$/;
// Poste Italiane delivers "dalla sede operativa di" the depot's town, which providers also translate.
const DEPOT_PREFIX = /^(?:dalla sede operativa di|from the operational headquarters in)\s+/i;
// Royal Mail appends a Post Office branch's postcode in brackets ("Example Post Office [ZZ9 9ZZ]"), which providers copy.
const BRACKETED_POSTCODE = /\s*\[\s*[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\s*\]$/i;
// China Post follows a town with its office's eight-digit code ("示例市 99999999"), which providers copy.
const OFFICE_CODE = /(?<=\p{Script=Han})\s+\d{8}$/u;
// Correios Brazil labels a unit abroad with "País", which providers translate: "Country, CHILE".
const COUNTRY_LABEL = /^(?:country|pa[ií]s)\s*[,:-]\s*/i;
// China Post's feed, which providers relay, can give a scan's status where its place belongs,
// at times with the place after it in 【】: "Departure from【Example】", "Out For Delivery",
// "99999 DELIVERED". The feed cuts long values, and an unclosed 【 holds a cut name.
const STATUS_PLACE = /^(?:arri[vy]al at|departure from|dispatching|received by carrier|in transit|out for delivery|(?:(?:export|import) )?customs clearance completed|(?:\d[\d ]*(?:[A-Z]{2} )?)?delivered)(?: (?:destination )?airport| processing cent(?:er|re))?\s*(?:【(?:([^【】]*)】.*|[^【】]*))?$/i;
// The same feed's arrival given with its country's airport, "Arrival at Example Airport".
const AIRPORT_PLACE = /^(?:arri[vy]al at|departure from) (\p{L}[\p{L} .'-]{1,60}?) airport$/iu;
// A full Canadian or British postcode after a town, which can narrow down a recipient's area.
const FULL_POSTCODE = /\s+(?:[A-Z]\d[A-Z] ?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/i;
// A post's posting office given by its postcode alone, after its country's code or not ("PL99999", "99999"),
// as providers relay UPU scans: a sender's area, which names the country at most.
const POSTCODE_ONLY = /^(?:([A-Z]{2})[- ]?)?\d{4,6}$/;
const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
// Codes Intl names that are no country: the EU, the eurozone, the UN, Outlying Oceania, the unknown region and private use.
const NOT_COUNTRIES = /^(?:EU|EZ|QO|UN|ZZ|X[A-Z])$/;

/** The country a postcode given alone as a place names by its code, '' when none, or undefined for any other place. */
function postcodeCountry(location: string): string | undefined {
  const postcode = POSTCODE_ONLY.exec(location);
  if (!postcode) return undefined;
  const code = postcode[1] && countryCode(postcode[1]) === postcode[1] && !NOT_COUNTRIES.test(postcode[1]) ? postcode[1] : undefined;
  return code ? ENGLISH_REGIONS.of(code) ?? '' : '';
}

// Countries whose places can be written in Chinese characters.
const HAN_COUNTRIES = new Set(['CN', 'HK', 'MO', 'TW', 'JP', 'KR', 'SG']);

/**
 * A place without a country a feed added: the destination's, which lines
 * append to their warehouses in China ("广州,US") and ParcelsApp spells out
 * ("Shanghai, United States"), or a country given twice ("Example State,
 * United States, United States").
 */
function withoutAddedCountry(location: string): string {
  const parts = location.split(',').map((part) => part.trim());
  const country = parts.length > 1 ? countryCode(parts.at(-1)) : null;
  if (!country) return location;
  const doubled = parts.length > 2 && countryCode(parts.at(-2)) === country;
  const key = (part: string) => part.toLowerCase().replace(/[^a-z0-9]/g, '');
  const chinese = !HAN_COUNTRIES.has(country) && parts.slice(0, -1).some((part) => /\p{Script=Han}/u.test(part)
    || CHINESE_PROVINCES.has(key(part)) || CHINESE_CITIES.has(key(part)));
  return doubled || chinese ? parts.slice(0, -1).join(', ') : location;
}

/**
 * A place with each part given once in a row ("SH,SH,CN"), except a country
 * after a town of its name ("Mexico, Mexico").
 */
function withoutRepeatedParts(location: string): string {
  const parts = location.split(',').map((part) => part.trim());
  const repeated = (part: string, at: number) => part !== '' && part.toLowerCase() === parts[at - 1]?.toLowerCase()
    && !(at === parts.length - 1 && countryCode(part));
  return parts.some(repeated) ? parts.filter((part, at) => !repeated(part, at)).join(', ') : location;
}

/** A place without a postcode given after its country. */
function withoutPostcodeAfterCountry(location: string): string {
  const match = POSTCODE_AFTER_COUNTRY.exec(location);
  return match && countryCode(match[2]) === match[2] && !NOT_COUNTRIES.test(match[2]) ? match[1]! : location;
}

/** A US facility's town and state, without the town and ZIP code after them, or undefined for any other place. */
function usFacilityPlace(location: string): string | undefined {
  const match = US_FACILITY_PLACE.exec(location);
  return match && usStateTimeZone(match[2]) ? `${match[1]!.trim()}, ${match[2]}` : undefined;
}

/** The place a status given as a location names in 【】 or before its airport, '' when it names none, or undefined for any other location. */
function statusPlace(location: string): string | undefined {
  const status = STATUS_PLACE.exec(location);
  if (!status) return AIRPORT_PLACE.exec(location)?.[1];
  const named = (status[1] ?? '').replace(FULL_POSTCODE, '').trim();
  return /\p{L}/u.test(named) ? named : '';
}

/**
 * A place given with its row's offset, as 17TRACK relays JCEX's: the town and state, without the
 * postcode; or the country the row is filed under, the destination, which names no place under an
 * offset that country never keeps (JCEX's rows in China at +08:00). Undefined for any other location.
 */
function offsetPlace(location: string): string | undefined {
  const match = OFFSET_PLACE.exec(location);
  if (!match) return undefined;
  const [, town, state, country, offset] = match;
  if (country) return countryKeepsOffset(country, offset!) === false ? '' : country;
  return [town!.trim(), state].filter(Boolean).join(', ');
}

/**
 * The place a provider reports for a scan, without the words before a depot's
 * town, a branch's postcode, which can narrow down a sender's or recipient's
 * area, a "Country" label or a status given before the place, unless it is a
 * label or placeholder ("--") that names no place, holds private delivery
 * details or is Posti's "abroad" label. A postcode given alone is the country
 * its code names, if any, and one given after the country goes. A place with its
 * row's offset after it is read without it (`offsetPlace`), and a US facility's town
 * and state without the town and ZIP code after them (`usFacilityPlace`). A part given twice in a
 * row is read once (`withoutRepeatedParts`)
 * and a country a feed added goes (`withoutAddedCountry`).
 */
export function place(value: unknown): string {
  const read = withoutRepeatedParts(text(value).slice(0, 200).replace(DEPOT_PREFIX, '').replace(BRACKETED_POSTCODE, '').replace(OFFICE_CODE, '').replace(COUNTRY_LABEL, ''));
  const location = statusPlace(read) ?? offsetPlace(read) ?? usFacilityPlace(read) ?? postcodeCountry(read)
    ?? withoutAddedCountry(withoutPostcodeAfterCountry(read));
  return /[\p{L}\p{N}]/u.test(location) && !NOT_PLACES.test(location) && !hasPrivateDeliveryDetails(location) && !isPostiAbroadLabel(location)
    ? location : '';
}

/** A place written in brackets after the wording, "Airline received【Hong Kong】": the wording before it and the place. */
export function trailingPlace(description: string): { wording: string; place: string } | undefined {
  const match = /^(.*\S)\s*(?:\[([^[\]]{1,60})\]|【([^【】]{1,60})】)$/u.exec(description.trim());
  const named = match ? place(match[2] ?? match[3]) : '';
  return match && named ? { wording: match[1]!, place: named } : undefined;
}

function sourceEventStage(description: string, includeBroadMovement = true): Stage | undefined {
  // Public aggregators retain the carrier's French wording even in English.
  const french = description.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (/colis en preparation chez l'expediteur/.test(french)) return 'registered';
  // Mondial Relay's hub scan, after the parcel was handed in at a relay or locker.
  if (/prise en charge de votre colis sur notre site logistique/.test(french)) return 'in_transit';
  // An Post's scans keep its own whole sentences, staged as its trace codes stage them.
  const anPost = anPostWordingStage(description);
  if (anPost) return anPost;
  // A sender's parcel left at a pick-up point for a courier to collect: an acceptance, not a parcel awaiting its recipient.
  if (/^the (?:parcel|package) has been delivered to the pick-?up point\. a courier will pick it up\b/i.test(description)) return 'accepted';
  // Posti's handling labels survive in aggregator histories. Registration is
  // a repeated physical scan here, and the reason can describe future customs
  // or delivery without making either the event's stage.
  if (/^(?:the )?item (?:accepted from transport(?:[.!]?$|[.!]? this is a transportation marking\b)|has arrived to destination country(?:[.!]?$|[.!]? the item has reached (?:the target country|finland)\b)|is ready for delivery in destination country[.!]?$|in process in office of exchange(?:[.!]?$|[.!]? the item is being processed\b))/i.test(description)
    || /^(?:the )?item has been registered(?:[.!]?$| the item can be registered several times during delivery\b)/i.test(description)) return 'in_transit';
  // A delivery still to come is no movement; only the rest of the text counts.
  const reported = deliveryForecastRemainder(description);
  if (reported !== undefined) return reported ? sourceEventStage(reported, includeBroadMovement) : undefined;
  if (nonterminalEnglishReturn(description)) return 'exception';
  if (/returned to (?:the )?sender/i.test(description)) return 'returned';
  if (/not delivered|could not.*deliver|unable to deliver|delivery failed/i.test(description)) return 'failed_attempt';
  // A notice card left for the recipient ends the attempt, as Canada Post reads it.
  if (/^notice (?:card )?left\b/i.test(description)) return 'failed_attempt';
  // A new attempt announced for the next round is no failure; the shared rules tell them apart.
  if (/delivery attempt/i.test(description) && [undefined, 'failed_attempt'].includes(trackingLanguageStage(description))) return 'failed_attempt';
  // Carrier-reported problems that are neither a missed attempt nor a return.
  // A new delivery date someone asked for moves on, even filed as an exception.
  if (/damaged|broken in transit|lost in transit|(?:package|parcel|shipment) (?:is )?lost|refused(?: by)?|rejected by (?:the )?recipient|(?:incorrect|incomplete|insufficient|unknown|invalid) address|address (?:incorrect|incomplete|insufficient|unknown|invalid)|addressee (?:unknown|cannot be located)|delivery exception|shipment exception|carrier exception|action required|awaiting instructions/i.test(description)
    && trackingLanguageStage(description) !== 'in_transit') return 'exception';
  // The shared rules tell a hold the recipient asked for, and a customs problem
  // already resolved, from a problem.
  if (/held (?:by|in|at) customs|customs (?:issue|problem)|(?:shipment|parcel) (?:held|on hold)/i.test(description)
    && [undefined, 'exception'].includes(trackingLanguageStage(description))) return 'exception';
  // A voided label was cancelled before shipping, even where a provider files
  // it as transit (17TRACK's generic code). Exact wording only, so a relabel
  // ("label voided, new label created") is not read as a cancellation.
  if (/^(?:parcel|package|shipment|(?:shipping )?label) (?:(?:has been|was|is) )?void(?:ed)?[.!]?$/i.test(description)) return 'exception';
  // Hand-overs on the way: also MailAmericas' airline delivering the bags in the destination
  // country ("Delivered by Airline") and its last-mile distributor taking the item ("Deliver to distributor").
  if (/deliver(?:ed)? to (?:the )?(?:local carrier|delivery partner|post office|distributor)|delivered by (?:the )?airline/i.test(description)) return 'in_transit';
  if (/will be available for (?:pickup|collection)/i.test(description)) return 'in_transit';
  // InPost's steps as aggregators relay them, as its own map reads them: a logistics centre taking the parcel in on
  // the way, after the courier's collection and again on each round trip, and its hand-over to the courier for delivery.
  if (/^accepted at the logistics cent(?:er|re)[.!]?$/i.test(description)) return 'in_transit';
  if (/^handed over for delivery[.!]?$/i.test(description)) return 'out_for_delivery';
  // Česká pošta's English, as aggregators relay it and its own map reads it: the sender's data, the posting, the
  // way to the delivery office, an item left for collection at a post office or Balíkovna, and one sent back unclaimed.
  if (/^receipt of data about consignment[.!]?$/i.test(description)) return 'registered';
  if (/^the consignment was sent for transportation[.!]?$/i.test(description)) return 'accepted';
  if (/^the consignment (?:left the logistics hub|is being prepared for delivery)[.!]?$/i.test(description)) return 'in_transit';
  if (/^the consignment was deposited(?: - addressee not at home| to balíkovna)[.!]?$/iu.test(description)) return 'ready_for_pickup';
  if (/^the consignment was sent back(?: to the sender)? - the consignment was not picked up by the addressee\b/i.test(description)) return 'exception';
  // Sender pre-advice such as Quickpac's "Shipment recorded by sender (data delivered)".
  if (/being prepared by the sender|recorded by (?:the )?(?:foreign )?sender|\bdata delivered\b|en route to .*awaiting processing/i.test(description)) return 'registered';
  // 17FEIA's customs broker taking the parcel to its warehouse after the flight, as Ship24 relays it with
  // 17FEIA's label or "OTHER" and as 17FEIA's map reads it.
  if (/^broker picked up shipment and delivered to warehouse\.(?:,\s*\S+)?$/i.test(description)) return 'customs';
  // The bare word also appears in handoffs, forecasts and negations ("delivered
  // to airline", "expected to be delivered", "not yet delivered"); those follow
  // the language rules instead of reading as a delivery.
  if (/\bdelivered\b|delivery completed/i.test(description)
    && [undefined, 'delivered'].includes(trackingLanguageStage(description))) return 'delivered';
  // An order ready for the courier to collect from its sender is a registration, and a parcel
  // ready for the customs agent is at customs, as the shared rules read them, whatever transit
  // code a provider files them under.
  if (/ready for (?:pickup|collection)|available for (?:pickup|collection)/i.test(description)) {
    const read = trackingLanguageStage(description);
    return read === 'registered' || read === 'customs' ? read : 'ready_for_pickup';
  }
  // Correos Express's way to the destination town, as Ship24 words it: "now out for delivery to
  // the destination facilities on one of our vehicles". Its own map reads it as transit.
  if (/^en route to the destination location\b/i.test(description)) return 'in_transit';
  // "The status will be updated once shipment is out for delivery" is not the round itself, nor is
  // Apple Express's "Parcel Received, Out for Delivery Soon".
  if (/out for delivery/i.test(description)
    && !/(?:once|when|as soon as) (?:the |your )?(?:shipment|parcel|package|item) is out for delivery|\bout for delivery soon\b/i.test(description)) return 'out_for_delivery';
  // Customs wording outranks a provider's own stage. The shared rules tell a
  // release or a completed clearance from customs still at work.
  if (/customs|clearance/i.test(description)) return trackingLanguageStage(description) === 'in_transit' ? 'in_transit' : 'customs';
  if (/instruction data.*provided.*electronically|instruction data transmitted\b|electronic information|information (?:received|submitted)|label (?:created|printed)|pre.?advice|shipment announced/i.test(description)) return 'registered';
  if (/will be transported to the destination country/i.test(description)) return 'in_transit';
  if (!includeBroadMovement) return undefined;
  const providerStage = providerWordingStage(description);
  if (providerStage) return providerStage;
  // A recipient collecting the parcel, a hand-over to an airline and one to the recipient's side are no acceptance.
  if (/package received at dhl ecommerce|^pick-up was successful[.!]?$|accepted|(?<!\byou(?: have|'ve|’ve)? )collected|picked up|handed over(?! to (?:the |an |a |your )?(?:airline|air carrier|recipient|addressee|consignee|customer|receiver|neighbou?r|you)\b)/i.test(description)) return 'accepted';
  if (/transit|arrived|departed|processed|processing completed at origin|sorting|sorted|transport|dispatched|en route|loaded to movement/i.test(description)) return 'in_transit';
  return undefined;
}

/**
 * Whole scans the aggregators relay in their own or a carrier's words, which
 * no shared rule reads: warehouse and terminal steps, order notices and
 * Chinese postal scans. Each is matched whole, so it says nothing about
 * other wording.
 */
function providerWordingStage(description: string): Stage | undefined {
  // Ship24 relays some feeds' scans with the feed's category or original wording
  // after the sentence: "Order confirmed., OTHER", "Warehouse receipt., 仓库收货".
  const value = description.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\.,\s*(?:other|\p{Script=Han}[\p{Script=Han}\s]*)$/iu, '.');
  // BRT's English status for a parcel on its delivery round reads "FOR DELIVERY" alone.
  if (/^for delivery[.!]?$|^delivery in progress, (?:first|second|third|\d+(?:st|nd|rd|th)) attempt\b|scanned for delivery[;,] ?the courier is\b|^delivery branch\. in the hands of the mailman[.!]?$|^przesyłka wydana do doreczenia kurierowi \w{2,20}[.!]?$|派送员派送途中/i.test(value)) return 'out_for_delivery';
  if (/^order confirmed[.!]?$|^order received(?: successfully)?[.!]?$|^creat(?:e|ed)\. (?:parcel|shipment(?: order)?) created\b|^pre-shipment info sent to\b|^the order has information pending customer confirmation[.!]?$|^waiting for (?:the )?carrier to collect the order[.!]?$|^registered in the system[.!]?$|^your order has been received[.!]?$|^tracking number assigned[.!]?$/i.test(value)) return 'registered';
  // Intelcom's first status and its pickup at the merchant, codes 0 and 105 as its own map reads them, with
  // the explanation providers relay after them.
  if (/^your package will be in good hands with (?:intelcom|dragonfly)!(?:\s|$)/i.test(value)) return 'registered';
  if (/^(?:intelcom|dragonfly) has your package!(?:\s|$)/i.test(value)) return 'accepted';
  // Cainiao's warehouse packing the order, between the order it received and the parcel leaving it, in
  // ParcelsApp's words and in Postal Ninja's.
  if (/^package finished[.!]?$|^package is ready for shipping from the warehouse[.!]?$/i.test(value)) return 'registered';
  if (/^export declaration in progress[.!]?$/i.test(value)) return 'customs';
  // KTD's steps as ParcelsApp relays them: the first carrier's local warehouse taking the parcel in and
  // sending it on to KTD's warehouse, the parcel leaving that, its export cleared and its flight taking off.
  if (/^package received and scanned at the carrier['’]s local warehouse[.!]?$/i.test(value)) return 'accepted';
  if (/^package leaves the carrier['’]s local warehouse[.!]?$|^your item has left the [a-z ]{1,40} warehouse[.!]?$|^export declaration completed[.!]?$|^take ?off[.!]?$/i.test(value)) return 'in_transit';
  // MRW's own wording for a parcel left at one of its pickup points, relayed by a provider,
  // and for its pickup from the sender still to come, as MRW's own map reads them.
  if (/^depositado en punto mrw[.!]?$/i.test(value)) return 'ready_for_pickup';
  if (/^pendiente de recoger[.!]?$/i.test(value)) return 'registered';
  // DPD Portugal's own wording, relayed by ParcelsApp without its code, as DPD Portugal's map reads
  // it: the sender's drop-off at a pickup point, the courier's collection, and a depot's intake.
  if (/^depositado pelo cliente\/expedidor[.!]?$|^encomenda recolhida[.!]?$/i.test(value)) return 'accepted';
  if (/^entrada em armaz[ée]m[.!]?$/i.test(value)) return 'in_transit';
  // Sameday's Bulgarian network before it has the parcel, as ParcelsApp relays it: a courier will collect the
  // parcel from the sender soon, as Sameday's own map reads its English, and the sender did not hand it over,
  // which stops the parcel.
  if (/^скоро ще вземем пратката ви от подателя[.!]?$/iu.test(value)) return 'registered';
  if (/^подателят не предаде пратката[.!]?$/iu.test(value)) return 'exception';
  // Russian Post's hand-over, as ParcelsApp relays it and Postal Ninja translates it: to the addressee, by any
  // means, delivers the parcel, and to the sender ends its return.
  if (/^вручение адресату(?: [\p{L} ]+)?[.!]?$|^вручено \d{1,2} \p{L}+[.!]?$|^handed over\. delivery to the addressee(?: [a-z ]+)?[.!]?$/iu.test(value)) return 'delivered';
  if (/^вручение отправителю(?: [\p{L} ]+)?[.!]?$|^handed over\. delivery to the sender(?: [a-z ]+)?[.!]?$/iu.test(value)) return 'returned';
  // Russian Post's steps on mail from abroad, as 17TRACK and ParcelsApp relay them: the shop's customs data, sent
  // before the parcel is posted, which ParcelsApp's English copy calls "Prepared for shipping"; the acceptance; the
  // office of exchange; and customs taking the parcel in, or clearing it with no outcome yet, as "Customs clearance"
  // reads. The wording has lost its diacritics: "приём" reads "прием", "торговой" reads "торговои".
  if (/^таможенное декларирование[,.:–—-]\s*данные от торговои площадки получены[.!]?$|^prepared for shipping[.!]?$/iu.test(value)) return 'registered';
  if (/^прием[.!]?$|^acceptance[.!]?$/iu.test(value)) return 'accepted';
  if (/^(?:обработка[,.:–—-]\s*)?(?:прибыло в|покинуло) место международного обмена[.!]?$/iu.test(value)) return 'in_transit';
  if (/^прием на таможню[.!]?$|^таможенное оформление[.!]?$/iu.test(value)) return 'customs';
  // The origin country a parcel left, as 17TRACK words the export.
  if (/^shipped from \p{L}[\p{L} .'-]{1,39}[.!]?$/iu.test(value)) return 'in_transit';
  // MRW's delivery address lacking details, as its own map reads it: the wording names no attempt.
  if (/^direccion entrega incompleta[.!]?$/i.test(value)) return 'exception';
  // A return on its way back to the sender, as other unfinished returns.
  if (/^the shipment is handled by a return consolidator[.!]?$/i.test(value)) return 'exception';
  // Relay's notices on Vinted parcels, from the label to the parcel in its hands.
  if (/^awaiting your vinted parcel[.!]?$|^expecting your parcel[.!]?$/i.test(value)) return 'registered';
  if (/^parcel received by relay[.!]?$|^received your parcel[.!]?$/i.test(value)) return 'accepted';
  // Relay's last notice, after its "Available for pickup": the recipient collected the parcel from the shop.
  if (/^collection complete[.!]?$/i.test(value)) return 'delivered';
  // UPS's scan as the parcel leaves the origin country, as UPS's own map reads it. The shared rules read its "Import Scan".
  if (/^export scan[.!]?$/i.test(value)) return 'in_transit';
  // A parcel at its local warehouse, after the central one; the promise of news that follows is no scan.
  if (/^the (?:package|parcel) is in the local warehouse(?:[.!]?$|\. we will come back with details about (?:the next steps|the delivery)[.!]?$)/i.test(value)) return 'in_transit';
  // Metropolitan Warehouse's furniture steps, as its own map reads them: the order, the vendor
  // pickup booked and done, and its hub, which ParcelsApp writes as Metro-<Warehouse>-Hub.
  if (/^order registered[.!]?$|^pickup scheduled for \d{1,2}\/\d{1,2}\/\d{2,4}[.!]?$/i.test(value)) return 'registered';
  if (/^pickup completed, no exceptions[.!]?$/i.test(value)) return 'accepted';
  if (/^furniture received by metro-(?:[^-]{1,40}-)?hub[.!]?$/i.test(value)) return 'in_transit';
  // SF Express's pickup notice, which goes on to name the courier.
  if (/^sf express has received your package\b/i.test(value)) return 'accepted';
  // iMile's scans as aggregators relay them, its 【】 place names cut or dropped.
  // "Your order has been received" after a centre's name, or after the relay's
  // "Received.", is the receipt at a centre in the destination country, as
  // iMile's own map reads it. A wrong address sends the parcel out again; a
  // recipient who cannot be reached closes the delivery and starts the return.
  if (/^order submit+ed[.!]?$/i.test(value)) return 'registered';
  if (/^we have received the shipment from the sender[.!]?$/i.test(value)) return 'accepted';
  // An export warehouse receiving the parcel after the origin's sorting centre has sent it on.
  if (/^received at (?:the )?origin warehouse[.!]?$/i.test(value)) return 'in_transit';
  // Scans aggregators relay in the network's words: a checkpoint passed, and the network's receipt of
  // the sender's confirmation that the shipment is being prepared.
  if (/^item has passed a checkpoint[.!]?$/i.test(value)) return 'in_transit';
  if (/^confirmation of preparation of the shipment received[.!]?$/i.test(value)) return 'registered';
  // Yanwen's scan after its pickup, as its own map reads it.
  if (/^processing information input[.!]?$/i.test(value)) return 'accepted';
  // Landmark Global's hand-over to the postal operator that carries the parcel on, as its own map reads it:
  // the shared rules would read "deposited" as a delivery.
  if (/^item deposited to (?:the )?local postal operator[.!]?$/i.test(value)) return 'in_transit';
  // Correios Brazil's scans in an aggregator's English or Correios' Portuguese for an item posted abroad. Correios'
  // receipt follows the posting and the export, so it is transit here; the recipient still owes customs their tax number.
  // Anjun words the sender's data the same way, under its code "forecast", which its own map reads as a registration.
  if (/^item posted[.!]?$|^objeto postado[.!]?$/i.test(value)) return 'accepted';
  if (/^item in transfer - please wait[.!]?$|^objeto em transferencia - por favor aguarde[.!]?$|^item received at the export unit in the country of origin[.!]?$|^item received by the brazilian post[.!]?$|^objeto recebido pelos correios do brasil[.!]?$/i.test(value)) return 'in_transit';
  if (/^need to inform (?:the )?recipient['’]?s cpf\/cnpj[.!]?$|^necessidade de informar (?:o )?cpf\/cnpj do destinatario[.!]?$/i.test(value)) return 'customs';
  if (/^(?:received\.|(?:\d\) )?[a-z ]{1,40} cent(?:er|re)) your order has been received[.!]?$|^(?:\S+ )?cent(?:er|re) (?:received|parcel shipped to \S+)[.!]?$|^origin port warehouse receive\b|^the flight has taken off[.!]?$|^(?:\S+ )?dispatch task assigned to da[.!]?$/i.test(value)) return 'in_transit';
  if (/^<bad address>$/i.test(value)) return 'failed_attempt';
  // Speedaf's issue scan ending a delivery round the recipient had moved to another day, as its own map reads it.
  if (/^cause of problem\s*【?\s*rescheduled delivery\s*】?[.!]?$/iu.test(value)) return 'failed_attempt';
  if (/^contact error,? need to return[.!]?$|^start returning\b|^\S*devolucion\S* order closed[.!]?$/i.test(value)) return 'exception';
  // A forwarder's arrival at the destination port, worded as a delivery, also after its Chinese
  // ("picked up at the destination port"), and its order data sent to the last-mile carrier.
  if (/^(?:目的港已提货\s*)?delivery has been made at the destination port[.!]?$|^目的港已提货$/iu.test(value)) return 'in_transit';
  if (/^order information has been sent to [a-z][a-z .-]{1,30}$/i.test(value)) return 'registered';
  // A shipment manifested, with a courier on the way to collect it from the sender: not in hand yet.
  if (/^manifested(?: - out for pick-?up)?[.!]?$/i.test(value)) return 'registered';
  // GZYL's destination processing centre taking the cleared parcel and sending it on, in GZYL's own spelling,
  // and a line's scan leaving the named city's centre after import clearance.
  if (/^internationall?i?y package received at processing cent(?:er|re)[.!]?$|^leave the (?:e?mail|[a-z][a-z .'-]{1,30}?) processing cent(?:er|re)[.!]?$/i.test(value)
    && !/^leave the return\b/i.test(value)) return 'in_transit';
  // Mayi Yinfu's parcel booked out of its operations centre, as its own map reads it.
  if (/^已出库(?:[,，]货物离开操作中心)?$/u.test(value)) return 'in_transit';
  // Hermes Germany's hub steps in an aggregator's English, and the aggregator's label for an inbound one.
  if (/^shipment added to loading unit[.!]?$|^received at hub: in motherbag[.!]?$|^shipment received[.!]?$|^the shipment (?:has been|was) prepared for (?:the )?further shipping\b/i.test(value)) return 'in_transit';
  // Hermes Germany's delivery to the safe place its recipient booked, which the aggregator pairs with its "Delivered".
  if (/^the shipment was left at a drop-off location[.!]?$/i.test(value)) return 'delivered';
  // A line carrier taking the parcel from the seller's or forwarder's warehouse, as GlobalEco's, ExMate's and Huiyi
  // Logistics' own maps read their "Received by Carrier".
  if (/^received by carrier[.!]?$/i.test(value)) return 'in_transit';
  // Landmark Global's hand-over to the destination's postal operator for the last mile, as Landmark's own map reads it.
  if (/^item deposited to local postal operator[.!]?$/i.test(value)) return 'in_transit';
  // Pitney Bowes's Global Shipping Program steps as aggregators relay them, as its own map reads them: the shipper's data,
  // then its hub measuring, labelling and loading the parcel and sending it abroad. Interpost, which carries it on, requests
  // the final-mile label at the hub's processing scan and hands the parcel to the destination's postal company.
  if (/^tracking details uploaded[.!]?$/i.test(value)) return 'registered';
  if (/^(?:first|second) dimension event[.!]?$|^processing at (?:the )?(?:global )?shipping cent(?:er|re)[.!]?$|^parcel documentation and labell?ing[.!]?$|^container (?:assignment|closed)[.!]?$|^shipped from (?:the )?(?:global )?shipping cent(?:er|re) to (?:international )?destination[.!]?$|^ready to ship\. fml label requested[.!]?$|^interpost handed item over to postal company[.!]?$/i.test(value)) return 'in_transit';
  // Austrian Post's hand-over to its partner on the way abroad, "Übergabe an Kooperationspartner" in its own map, and an
  // item from abroad posted in its country and sent on to Austria, "Postaufgabe im Ausland" and "Sendung ins Zielland
  // unterwegs", in ParcelsApp's English.
  if (/^item handed over to subcontractor[.!]?$/i.test(value)) return 'in_transit';
  if (/^item posted abroad[.!]?$/i.test(value)) return 'accepted';
  if (/^item forwarded to destination country[.!]?$/i.test(value)) return 'in_transit';
  // Huahan's hand-over to the delivering carrier, as its own map reads it.
  if (/^has been given to local carrier[.!]?$/i.test(value)) return 'in_transit';
  // InPost Spain's labels, as Mondial Relay's map reads them by their codes: the label registered, collected, and at
  // the last depot before the Punto Pack or locker shows it ready.
  if (/^en preparacion[.!]?$/iu.test(value)) return 'registered';
  if (/^recogido por el mensajero[.!]?$/iu.test(value)) return 'accepted';
  if (/^paquete en el destino[.!]?$/iu.test(value)) return 'in_transit';
  // USPS's status for incoming international mail before it scans the item, from the origin post's electronic notice,
  // as its own map reads it.
  if (/^origin post is preparing shipment[.!]?$/i.test(value)) return 'registered';
  // Hrvatska pošta's scans as its own map reads them: the sender's announcement, then the item
  // sent on and received by the post abroad.
  if (/^item announced[.!]?$/i.test(value)) return 'registered';
  if (/^item sent[.!]?$|^item received in destination country[.!]?$/i.test(value)) return 'in_transit';
  // Its office of exchange taking in an item from abroad, as ParcelsApp relays it.
  if (/^item received at exchange office[.!]?$/i.test(value)) return 'in_transit';
  // Poste Italiane's intake at a post office or Punto Poste and its delivery round in an aggregator's English,
  // as its own map reads "presa in carico presso il Punto Poste" and "la spedizione è in consegna".
  if (/^the shipment was taken care of at the post office[.!]?$/i.test(value)) return 'accepted';
  if (/^the shipment is on delivery[.!]?$/i.test(value)) return 'out_for_delivery';
  // An Post's item waiting at the post office it names (code 52), and GLS Italy's delivery round, as their own maps read them.
  if (/^your delivery is in [^,]{1,60}, post office[.!]?$/i.test(value)) return 'ready_for_pickup';
  // An item waiting for its recipient at a post office, as ParcelsApp relayed it for one bound for Slovenia.
  if (/^item prepared for pick-up at the post office[.!]?$/i.test(value)) return 'ready_for_pickup';
  if (/^delivery scheduled during the day[.!]?$/i.test(value)) return 'out_for_delivery';
  // Latvijas Pasts' acceptance at a post office, which ParcelsApp follows with the office's name.
  if (/^item posted \/ received from customer\b/i.test(value)) return 'accepted';
  // Its export steps after that, as ParcelsApp relays them: the logistics centre, the outward office of
  // exchange holding the item for dispatch, and the dispatch before the item leaves Latvia.
  if (/^received at the logistics cent(?:er|re)[.!]?$|^item held at outward office of exchange[.!]?$|^sending the package[.!]?$/i.test(value)) return 'in_transit';
  // BRT's TURMOIL, a public demonstration holding the parcel up (exception in its own map), as Ship24 relays it.
  if (/^turmoil[.!]?$/i.test(value)) return 'exception';
  // Lietuvos paštas' acceptance (ACCEPTED in its own map) as ParcelsApp relays it. The shared rules leave a
  // bare receipt unread, since it names no receiver.
  if (/^parcel received[.!]?$/i.test(value)) return 'accepted';
  // China Post's domestic steps as aggregators relay them, with the cities in Latin script: the mail flown from one city
  // to another, passing through one, landed in one and bound for an office, and its forecast to reach one.
  if (/^邮件已乘机由.{1,60}飞往|^您的邮件正途经|^邮件到达[^，,]{1,60}[，,]\s*准备发往|^预计【[^】]{1,20}】到达.{1,60}两地距离/u.test(value)) return 'in_transit';
  // ECMS's pre-alert, in English then Chinese: the parcel has yet to reach its origin warehouse.
  if (/^virtual manifest has been received[.!]?(?:\s*发货预报已收到[，,]?\s*正在等待货物到达我们的始发站仓库[。.]?)?$/iu.test(value)) return 'registered';
  // DHL's arrival in the destination country, relayed in German, as DHL's own map reads it.
  if (/^die sendung ist im zielland\/zielgebiet eingetroffen[.!]?$/i.test(value)) return 'in_transit';
  // InPost's refusal at the door (LMD.9006), as InPost's own map reads it.
  if (/^acceptance refusal[.!]?$/i.test(value)) return 'failed_attempt';
  // A postal item accepted abroad as the receiving post's map reads the UPU event (Canada Post's 4000), and
  // Deutsche Post's posting at a retail outlet, "in der Filiale eingeliefert" in German.
  if (/^international item mailed in originating country[.!]?$/i.test(value)) return 'accepted';
  if (/^the shipment has been posted by the sender at the retail outlet[.!]?$/i.test(value)) return 'accepted';
  // Canada Post's new label at a processing plant (0198), between two processing scans.
  if (/^label correction applied[.!]?$/i.test(value)) return 'in_transit';
  // SEUR's receipt at its origin facility (SX001) and Vinted Go's parcel dropped off by its sender, as their own maps read them.
  if (/^the shipment has been received at the seur facilities of origin[.!]?$|^parcel was dropped off at the (?:locker|parcel shop)[.!]?$/i.test(value)) return 'accepted';
  // Sending's collection and its departure on the national route, in ParcelsApp's English, as Sending's own map reads them.
  if (/^reception in the delegation[.!]?$/i.test(value)) return 'accepted';
  if (/^out in national route[.!]?$/i.test(value)) return 'in_transit';
  // Cainiao's origin sorting centre marking a parcel that holds a battery, between its inbound and outbound
  // scans, as ParcelsApp relays it: the parcel goes on.
  if (/^restricted item - battery item[.!]?$/i.test(value)) return 'in_transit';
  // FedEx's customs release, which its own map reads as a completed clearance.
  if (/^international shipment release - (?:import|export)[.!]?$/i.test(value)) return 'in_transit';
  // Straightship's shipper data, then its first scan in Canada and its stations, the town and province in brackets.
  if (/^package information is created in the system[.!]?$/i.test(value)) return 'registered';
  if (/^package received with origin scan warehouse(?: \([^()\d@]+\))?$/i.test(value)) return 'accepted';
  if (/^package is received at a straightship station(?: \([^()\d@]+\))?$/i.test(value)) return 'in_transit';
  // JS Express's steps at its Chinese warehouse between sorting and departure, and its hand-over to the
  // destination's last-mile carrier, as its own map reads them.
  if (/^domestic allocation has begun[.!]?$|^under domestic allocation[.!]?$/i.test(value)) return 'in_transit';
  if (/^delivery to local courier[.!]?$/i.test(value)) return 'in_transit';
  // Maersk's leg as ParcelsApp relays it after the first carrier's: the manifest announcing the parcel, then
  // Maersk taking it over in the destination country, the step the first carrier calls its local delivery
  // company's receipt. A parcel relabelled at a facility on the way moves on.
  if (/^shipment manifest received[.!]?$/i.test(value)) return 'registered';
  if (/^parcel received by maersk[.!]?$|^(?:package|parcel) relabell?ed[.!]?$/i.test(value)) return 'in_transit';
  // A consolidator's steps as aggregators relay them: the customer's data on its manifest, its origin
  // hub taking the parcel in, the parcel sent on, and a flight held up, for which results carry no delay flag.
  if (/^customer information manifested[.!]?$/i.test(value)) return 'registered';
  // A booking before any carrier has the parcel: a collection requested or booked, or a carrier still waiting for it.
  if (/^(?:pickup requested|booked|waiting for (?:the )?parcel)[.!]?$/i.test(value)) return 'registered';
  // A forwarder's warehouse scanning the parcel in or out, as aggregators relay SPT Express's rows.
  if (/^item (?:in|out)bound scanning[.!]?$/i.test(value)) return 'in_transit';
  // FedEx's scan status for a parcel it has taken in, with the details aggregators join to it, as FedEx's own map reads it.
  if (/^in fedex possession(?:[.!]?$|\s*[-—–:]\s)/i.test(value)) return 'accepted';
  if (/^checked in at origin hub[.!]?$|^parcel received and processing[.!]?$/i.test(value)) return 'accepted';
  if (/^parcel shipped[.!]?$|^(?:airline|flight) delay(?:ed)?[.!]?$/i.test(value)) return 'in_transit';
  // Quantium Solutions' hub steps, which aggregators relay for SingPost's cross-border parcels, as its own map reads them.
  if (/^shipment (?:under processing at origin hub|despatched to (?:transshipment hub|overseas)|received at (?:transshipment hub|delivery branch))[.!]?$/i.test(value)) return 'in_transit';
  // DHL eCommerce's US label awaiting the parcel, and the parcel handed to the last-mile partner, as its own map reads them.
  if (/^dhl ecommerce currently awaiting shipment\b/i.test(value)) return 'registered';
  if (/^tendered to (?:the )?delivery service provider\b/i.test(value)) return 'in_transit';
  // A bare "parcel handed" is a hand-over to a carrier, which 17TRACK files as a pickup.
  if (/^parcel handed[.!]?$/i.test(value)) return 'accepted';
  // A Chinese post's scans as a forwarder's English copies them, the place in brackets: a processing centre
  // taking the parcel in ("已收寄"), the parcel leaving one ("离开处理中心") and an airline receiving it ("航空公司接收").
  const unplaced = value.replace(/ ?(?:\[[^[\]]{1,60}\]|【[^【】]{1,60}】)$/u, '');
  if (/^[a-z ]{1,40} processing cent(?:er|re) has received it[.!]?$/i.test(unplaced)) return 'accepted';
  if (/^(?:(?:the )?(?:parcel|package|shipment) )?leaves (?:the )?processing cent(?:er|re)[.!]?$|^airline received[.!]?$/i.test(unplaced)) return 'in_transit';
  // Helthjem sending a home delivery on to a pickup point, as Ship24 relays it: the parcel prepared for
  // the pickup point, and sorted again before it goes there.
  if (/^pakken (?:din )?behandles for sending til (?:et )?hentested[.!]?$|^pakken sorteres pa nytt før den sendes til (?:et )?hentested[.!]?$/i.test(value)) return 'in_transit';
  if (/^warehouse receipt[.!]?$|^(?:package |parcel )?received by (?:the )?warehouse[.!]?$|^received in warehouse[.!]?$|^(?:package|parcel) (?:bulk )?received(?: (?:and|&) scanned)? at (?:the )?warehouse[.!]?$|^we['’]ve got it[.!]?$|^received at evri[.!]?$|^received by our network[.!]?$|^acceptance, sent to [a-z ]+$|^shipment received from (?:the )?sender[.!]?$|^china post has received the mail\b|^envio recogido en origen[.!]?$|^first parcel scan along poste italiane['’]s logistic network\b|已收寄|^仓库收货$|^rfid confirmed pick-?up$|^usps in possession of (?:the )?item\b/i.test(value)) return 'accepted';
  if (/^goods leave the operation cent(?:er|re)[.!]?$|^the shipment has left (?:the )?origin country[.!]?$|^(?:delivery\. )?your order has been shipped from (?:\d\) )?[a-z ]{1,40} cent(?:er|re)[.!]?$|^nuevo reparto(?:\. concertacion entrega flexible)?[.!]?$|^new delivery, flexible delivery arrangement[.!]?$|^inventory in a warehouse[.!]?$|^hand over to airline[.!]?$|^in lavorazione[.!]?$|^uscita centro postale[.!]?$|^przesyłka w oddziale \w{2,20}[.!]?$|^(?:package |parcel )?(?:left|leaves?|shipped from) the warehouse[.!]?$|^we['’]re processing your parcel at our hub\b|^warehouse\. (?:inbound warehouse|delivery in last mile facilities|ready to hand over to last-mile supplier)[.!]?$|^hand over to last mile[.!]?$|^at destination country\/region[.!]?$|^(?:beladung|entladung)$|^entrance to the terminal from the driver$|^outbou?n?d from pickup terminal to the line ?h[ao]u?l$|^inbound from l?ine ?h[ao]u?l to (?:the )?terminal$|^[\w ]+ warehouse, .{1,80}? processing,? (?:order has been (?:in|out)bounded|assembling operation)$|^received in site[- ]|^exported[.!]?$|^(?:the )?plane has landed[.!]?$|^received by (?:the )?airline[.!]?$|^flight delay(?:ed)?[.!](?:$| the flight scheduled\b)|^wi\s*[–-]\s*intermediate warehouse\. (?:container received|package received at intermediate warehouse)[.!]?$|^delivery branch\. received at distribution branch[.!]?$|^receiving destination mail\. received by distributor[.!]?$|^container reception[.!]?$|(?:邮件|快件)(?:到达|离开)处理中心|航空公司接收|已交承运商运输|已完成分拣|^出口海关\/放行|^启运|^干线中转/i.test(value)) return 'in_transit';
  // Posta Shqiptare's Albanian rows, its own and those it relays from the foreign post, as its own map reads them.
  return chinaPostRelayedStage(value) ?? postaShqiptareScanStage(value);
}

export function eventStage(description: string): Stage | undefined {
  const classified = classifyEvent(description);
  return classified.stage_source === 'none' ? undefined : classified.stage;
}

/** Retain the decision before delivery wording is redacted or a stage is projected. */
export function classifyEvent(description: string, declared?: Stage): { stage: Stage; stage_source: string } {
  const specific = sourceEventStage(description, false);
  if (specific) return { stage: specific, stage_source: 'wording:provider' };
  if (declared) return { stage: declared, stage_source: 'carrier_map' };
  const translated = trackingLanguageStage(description);
  if (translated) return { stage: translated, stage_source: 'wording:language' };
  const broad = sourceEventStage(description);
  return { stage: broad ?? 'pending', stage_source: broad ? 'wording:provider' : 'none' };
}

// ParcelsApp appends the message type and medium to Chronopost's notice to the recipient
// ("… Type du message : Retard Média utilisé : E-mail"). Chronopost's own tracker lists the notice alone.
const NOTICE_DETAILS = /^\.?\s*Type du message\s*:/i;

function relayedNotice(label: string): string {
  return label.startsWith(CHRONOPOST_NOTIFICATION) && NOTICE_DETAILS.test(label.slice(CHRONOPOST_NOTIFICATION.length))
    ? CHRONOPOST_NOTIFICATION : label;
}

// ParcelsApp heads Interpost's import clearance with Interpost's status code, "B2C Clearance 4. Customs Import
// cleared". Interpost's own tracker shows the caption alone, as Pitney Bowes's map words it.
const CLEARANCE_STATUS = /^B2C Clearance ?(?:Status ?)?\d{1,3}\. +(?=\S)/i;

const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_WALL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

// A flight written before it leaves is still to come: no scan, as the lines' own trackers drop it.
// 17FEIA's estimated departure, and the flight DHLink, Intel-Valley and Mayi Yinfu book.
const flightToCome = (label: string): boolean =>
  FLIGHT_ESTIMATE.test(label) || DHLINK_FLIGHT.test(label) || intelValleyFlight(label) || MAYIYINFU_FLIGHT.test(label);

// A carrier's schedule, as 17TRACK relays it beside the milestones: an ocean line's estimated vessel departure and
// arrival, each again once updated, and its cargo cut-off, and a flight's ETD or ETA. Each is dated when it is due,
// often weeks ahead, so it is no scan.
const SCHEDULE = /^(?:estimated vessel (?:departure|arrival)|cfs\/cy cut-off date)(?: \(last updated\))?$|^flight et[ad]\b/i;

// A time or date in brackets with no words, as 17TRACK relays a Juxi Express row between the flight
// being arranged at the airport and the departure, and ParcelsApp one dated by month and day ("(10.20)")
// between its departure and arrival: it says nothing happened, so it is no scan.
const BARE_TIME = /^[(（]\s*\d{1,2}\s*[:：.．]\s*\d{1,2}\s*[)）]$/;
// A language's label with nothing after it, as 17TRACK relayed a JCEX row beside the warehouse's receipt.
const EMPTY_LABEL = /^[(（]\s*(?:中文|英文|chinese|english)\s*[:：]\s*[)）]$/i;

function describe(description: unknown, stage?: unknown): { description: string; stage: Stage; stage_source: string } | null {
  // A copy of SunYou's departure drops the last-mile number, as SunYou's own result does.
  const label = sunYouWording(relayedNotice(text(description)).replace(CLEARANCE_STATUS, ''));
  if (!label || isNotice(label) || flightToCome(label) || SCHEDULE.test(label) || BARE_TIME.test(label)
    || EMPTY_LABEL.test(label)) return null;
  const declared = typeof stage === 'string' && Object.hasOwn(STAGES, stage) ? STAGES[stage] : undefined;
  // Established source semantics (e.g. handoff/negation) remain first. A real
  // provider stage outranks the new intuitive translation fallback.
  const classified = classifyEvent(label, declared);
  if (classified.stage !== 'delivered' && hasPrivateDeliveryDetails(label)) return null;
  // Delivery descriptions can include signatures, access codes or door numbers.
  return { description: classified.stage === 'delivered' ? 'Delivered' : label, ...classified };
}

export function event(time: unknown, description: unknown, stage?: unknown): CarrierEvent | null {
  const described = describe(description, stage);
  if (!described) return null;
  // Require an explicit offset: universal events can originate in any timezone.
  if (typeof time !== 'string' || !EXPLICIT_OFFSET.test(time)) {
    throw new TypeError('Tracking event has no valid timezone');
  }
  const date = DateTime.fromISO(time, { setZone: true });
  if (!date.isValid) throw new TypeError('Tracking event has an invalid timestamp');
  return { time: date.toUTC().toISO(), ...described };
}

/**
 * Like event(), but a scan without an offset keeps its wall time as local_time
 * instead of failing the whole shipment. Never invents a UTC instant.
 */
export function localEvent(time: unknown, description: unknown, stage?: unknown): CarrierEvent | null {
  if (typeof time === 'string' && EXPLICIT_OFFSET.test(time)) return event(time, description, stage);
  const described = describe(description, stage);
  if (!described) return null;
  if (typeof time !== 'string' || !LOCAL_WALL_TIME.test(time) || !DateTime.fromISO(time, { zone: 'UTC' }).isValid) {
    throw new TypeError('Tracking event has an invalid timestamp');
  }
  return { local_time: time, ...described };
}

// Providers stamp their own notices with the moment they answer. An entry whose wording no
// rule reads, dated that close to the lookup, is a notice whatever its words; a real scan
// that new is kept by the next lookup.
const NOTICE_WINDOW_MS = 5 * 60_000;

function lookupNotice(value: CarrierEvent, now: number): boolean {
  return value.stage_source === 'none' && typeof value.time === 'string'
    && Math.abs(Date.parse(value.time) - now) <= NOTICE_WINDOW_MS;
}

// Steps that can come dated after the lookup, when nothing has happened yet, so the entry
// keeps no time: Cainiao's "Pending shipping by the seller", by its look the time the seller
// has to ship by, and the sentence of GLS's progress bar that points to the detailed tracking
// below, dated by GLS's delivery estimate.
const AHEAD_STEPS = [/^pending shipping by the seller[.!]?$/i, /\bplease see the detailed shipment tracking below[.!]?$/i];

function aheadStep(value: CarrierEvent, now: number): CarrierEvent {
  if (!AHEAD_STEPS.some((step) => step.test(value.description ?? '')) || typeof value.time !== 'string'
    || Date.parse(value.time) - now <= NOTICE_WINDOW_MS) return value;
  const undated = { ...value };
  delete undated.time;
  return undated;
}

// GLS's ParcelShop scan as Postal Ninja relays it, which the wording alone leaves open.
const PARCELSHOP_SCAN = /^the parcel has reached the parcelshop[.!]?$/i;
const PAST_LABEL = (stage: Stage | undefined) => !!stage && stage !== 'pending' && stage !== 'registered';

/**
 * GLS's ParcelShop scan read by the scans around it: after a carrier scan, the parcel waits for
 * collection; before one, with none earlier, it is the sender's drop-off. Alone it stays unread.
 */
function parcelShopScan(value: CarrierEvent, events: readonly CarrierEvent[]): CarrierEvent {
  const at = instantOf(value);
  if (value.stage_source !== 'none' || !PARCELSHOP_SCAN.test(value.description ?? '') || at === null) return value;
  const carried = (before: boolean) => events.some((other) => {
    const when = instantOf(other);
    return when !== null && (before ? when < at : when > at) && PAST_LABEL(other.stage as Stage | undefined);
  });
  const stage: Stage | undefined = carried(true) ? 'ready_for_pickup' : carried(false) ? 'accepted' : undefined;
  return stage ? { ...value, stage, stage_source: 'wording:provider' } : value;
}

// A timeline written to a schedule rather than scanned: rows a fixed time apart, each to within a
// second of the one before, four or more. The step is an hour or more and not a whole number of
// hours, which a copy of one scan read on other clocks, or a row written at one time each day,
// would be. Rows on whole minutes alone are not counted.
const SCHEDULE_ROWS = 4;
const HOUR_MS = 3_600_000;
const SCHEDULE_SLACK_MS = 1_000;

function instantOf(value: CarrierEvent): number | null {
  const clock = value.time ?? (typeof value.local_time === 'string' && value.local_time.length > 10 ? `${value.local_time}Z` : '');
  const at = clock ? Date.parse(clock) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** The instants of the rows a timeline written to a schedule holds, other rows between them or not. */
function scheduled(events: readonly CarrierEvent[]): Set<number> {
  const instants = [...new Set(events.map(instantOf).filter((at): at is number => at !== null))].sort((a, b) => a - b);
  const bySecond = new Map(instants.map((at) => [Math.round(at / 1_000), at]));
  const near = (target: number) => [0, -1, 1].map((shift) => bySecond.get(Math.round(target / 1_000) + shift))
    .find((at) => at !== undefined && Math.abs(at - target) <= SCHEDULE_SLACK_MS);
  const written = new Set<number>();
  instants.forEach((first, index) => {
    for (const second of instants.slice(index + 1)) {
      const step = second - first;
      const offHour = step % HOUR_MS;
      if (step < HOUR_MS || offHour <= SCHEDULE_SLACK_MS || HOUR_MS - offHour <= SCHEDULE_SLACK_MS) continue;
      const chain = [first, second];
      for (let next = near(second + step); next !== undefined; next = near(next + step)) chain.push(next);
      if (chain.length >= SCHEDULE_ROWS && chain.some((at) => at % 60_000)) chain.forEach((at) => written.add(at));
    }
  });
  return written;
}

const GENERIC_TRANSIT = /^on the way[.!]?$/i;

function moment(value: CarrierEvent): string {
  return value.time ?? (typeof value.local_time === 'string' ? value.local_time : '');
}

const dayAlone = (value: CarrierEvent) => !value.time && typeof value.local_time === 'string' && value.local_time.length === 10;

/**
 * Newest first, scans of one instant in the order the provider listed them. A
 * step dated by its day alone, sorted below its day's timed scans, could be any
 * time that day: it goes above the newest of them at an earlier stage, as
 * FedEx's pickup above the shipment information sent that morning.
 */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  if (listsNewestFirst(events) === false) events.reverse();
  const sorted = events.sort((a, b) => moment(b).localeCompare(moment(a)));
  for (const step of sorted.filter(dayAlone)) {
    const rank = PROGRESS[step.stage as Stage];
    if (rank === undefined) continue;
    const earlier = sorted.find((other) => !dayAlone(other) && moment(other).startsWith(`${step.local_time}T`)
      && (PROGRESS[other.stage as Stage] ?? rank) < rank);
    if (!earlier) continue;
    sorted.splice(sorted.indexOf(step), 1);
    sorted.splice(sorted.indexOf(earlier), 0, step);
  }
  return sorted;
}

export function result(events: CarrierEvent[], source: UniversalSource, preserveOrder = false): CarrierResult {
  // Wall times sort alongside UTC instants only approximately; providers that
  // omit offsets everywhere pass preserveOrder instead.
  const scans = new Map<string, CarrierEvent>();
  const now = Date.now();
  for (const entry of events) {
    const event = aheadStep(entry, now);
    if (lookupNotice(event, now)) continue;
    const key = `${moment(event)}|${event.description}`;
    const earlier = scans.get(key);
    // A carrier's copy can lack the place another copy of the same scan reported.
    scans.set(key, !event.location && earlier?.location ? { ...event, location: earlier.location } : event);
  }
  const written = scheduled([...scans.values()]);
  // A generic "On the way" beside a specific scan at its instant and place, as FedEx writes it
  // beside "Departed FedEx hub", is a second copy of that scan.
  const at = (event: CarrierEvent) => `${moment(event)}|${event.location ?? ''}`;
  const specific = new Set([...scans.values()].filter((event) => !GENERIC_TRANSIT.test(event.description ?? '')).map(at));
  const kept = [...scans.values()].filter((event) => !written.has(instantOf(event) ?? NaN)
    && !(GENERIC_TRANSIT.test(event.description ?? '') && specific.has(at(event))));
  const ordered = (preserveOrder ? kept : newestFirst(kept)).slice(0, 100);
  const unique = ordered.map((event) => parcelShopScan(event, ordered));
  if (!unique.length && written.size) {
    throw new NoHistoryError(source, `${source} relays only a timeline written to a schedule`, { reason: 'written_ahead' });
  }
  // A well-formed reply with no scan left after notices and private details proves nothing about the parcel.
  if (!unique.length) throw new IndeterminateError(source, 'No usable tracking events');
  const currentEvent = unique.find((e) => e.stage && e.stage !== 'pending');
  const current = currentEvent?.stage as Stage | undefined;
  // Unknown wording can be displayed, but must not imply movement.
  const status: CarrierStatus = current === 'delivered' ? 'delivered'
    : current === 'registered' || !current ? 'pending'
      : current === 'out_for_delivery' || current === 'ready_for_pickup' ? 'out_for_delivery'
        : ['returned', 'failed_attempt', 'exception'].includes(current) ? 'exception' : 'in_transit';
  return {
    status, current_stage: current ?? 'pending', current_stage_source: currentEvent?.stage_source ?? 'none',
    last_status_text: unique[0]!.description,
    last_update: unique[0]!.time ?? null, expected_delivery: null, timezone: 'UTC',
    tracking_provider: source, events: unique,
  };
}

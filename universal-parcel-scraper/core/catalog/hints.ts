import { CARRIER_DEFINITIONS, carrierTimezone } from './definitions.js';
import { TRACKING_LINK_RULES, matchesDomain } from './linkRules.js';
import { countryTimeZone } from '../time/index.js';
import { NETWORK_BRANDS, carrierBrand } from './networks.js';
import type { CarrierId } from '../../generated/catalog.js';

export { carrierBrand };

// Accents fold to their letter, so "Turkiye" reads as the catalog's "Türkiye".
// Letters of every script and digits; Latin letters outside a–z drop out. A name
// in another script keys on its own letters, never on its Latin part alone.
const key = (name: string) => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}0-9]/gu, '').replace(/(?![a-z])\p{Script=Latin}/gu, '');

// These brands have several regional/service adapters. Providers write plain
// "CTT" for both Portugal's post and CTT Express. Plain "Cirro" covers GOFO's
// French, Italian and Dutch networks and Cirro's own cross-border line, which
// hands parcels to national posts under their numbers.
const AMBIGUOUS_BRANDS = ['dhl', 'dpd', 'gls', 'hermes', 'gofo', 'post', 'ctt', 'cirro'];
// An alias also gives the name its carrier's clock, which moves the stored
// instants, and so the event ids, of past scans under that name. Providers
// name Evri International in full or by its GlobalEco tracker; plain "Evri"
// has Evri UK's scans, on London time.
const NAME_ALIASES: Readonly<Record<string, string>> = {
  ups: 'ups', swisspost: 'swiss-post', laposte: 'la-poste', colissimo: 'la-poste',
  dhlecommerce: 'dhl-ecommerce', cainiao: 'aliexpress', postnl: 'spring-gds',
  asendiausa: 'asendia', asendiaunitedstates: 'asendia', finlandpost: 'posti', spainpost: 'correos-spain',
  portugalctt: 'ctt', portugalpostportugalctt: 'ctt', postennorgenorwaypost: 'bring-posten',
  italypost: 'poste-italiane', italysda: 'poste-italiane', deutschepostdhlpaket: 'dhl', austriapost: 'austrian-post',
  evri: 'evri-uk', chilepost: 'correos-chile', chilecorreos: 'correos-chile', correoschilecorreoschile: 'correos-chile',
  // La Poste's names for its delivery partners abroad, in French or as the postal union lists them.
  posteitalienne: 'poste-italiane', posteirlandaise: 'an-post', postegb: 'royal-mail',
  directiondespostesalgerie: 'algerie-poste', organismenationaldespostesegypt: 'egypt-post',
  baridalmaghribmaroc: 'barid-al-maghrib', societenationalelapostesenegal: 'la-poste-senegal',
  officenationaldesposteslapostetunisienne: 'la-poste-tunisienne',
  entreprisefederaleunitairedetatpostederussie: 'russian-post', entreprisedetatpostamoldovei: 'posta-moldovei',
  eurbelpochtabelarus: 'belpost', haypostcjsc: 'haypost', correooficialdelarepublicaargentinasa: 'correo-argentino',
  empresabrasileiradecorreiosetelegrafos: 'correios-br', empresacorreosdechile: 'correos-chile',
  jordanpostcompany: 'jordan-post', serpostsaperu: 'serpost', publicenterprisepostofserbia: 'posta-srbije',
  publicjointstockcompanyukrposhta: 'ukrposhta', southafricapostofficelimited: 'south-african-post-office',
  postur: 'posturinn', singaporepostlimited: 'singapore-post', malaysiapost: 'pos-malaysia',
  departmentofpostsindia: 'india-post', israelpostalcompanyltd: 'israel-post', turkishpttcorporation: 'ptt',
  cameronpostalservicescampost: 'campost', servicopostalmexicano: 'correos-de-mexico',
};
// The postal union's shared feed, which aggregators list among a parcel's carriers.
const FEED_NAMES = ['upu', 'universalpostalunion'];
const CATALOG_NAMES = new Set([
  ...Object.entries(CARRIER_DEFINITIONS).filter(([id]) => id !== 'unknown')
    .flatMap(([, definition]) => [definition.displayName, ...(definition.aliases ?? [])].map(key)),
  ...Object.keys(NAME_ALIASES), ...AMBIGUOUS_BRANDS,
]);

// Postal lookup candidates, not proof of which operator delivers a shipment.
// Only operators whose dedicated adapter looks up mail from abroad by its S10
// number are useful here: India Post's takes only numbers of its own. Poste
// Italiane's tracker follows some mail from abroad under the sending post's
// number and does not know the rest. Pos Malaysia's tracker answers any S10
// number, but it leaves the scans of mail from abroad undated, so it is not the
// hand-off for mail to Malaysia. Poczta Polska dates scans at its
// delivery office, and other inward scans when they name a Polish office; those
// relayed from the origin keep its wall clock. Ukrposhta dates its scans in
// Ukraine. Its status API misses some mail from abroad, and its portal then
// needs a browser session, so a hand-off lookup there can hold a browser for
// the rest of its budget: forty-five seconds by default, a minute at most.
// Barid Al-Maghrib dates scans to the day: its clocks lack AM or PM. Algérie
// Poste's tracker, EMS Champion Post Algérie's, was seen answering for EMS
// from abroad, not for registered mail. Posta Kenya dates only scans it places
// in Kenya by name. Correo Uruguayo's clocks name no zone, and those relayed
// from abroad keep the sender's. Posta dates only scans at a Faroese place.
// Correos de El Salvador's clocks name no zone either, nor do Correos de
// Cuba's, whose tracker finds an item only in the current year and the one
// before. Correios Brazil names each row's zone. An Post shows only its own
// scans of mail from abroad, on
// Irish time; bpost dates the scans that name Belgium. Hrvatska pošta, Latvijas
// Pasts, Slovenská pošta and Lietuvos paštas date a scan abroad on its
// country's clock when that country keeps one zone, and their own on theirs.
// Česká pošta dates its rows to the day, and ELTA's clocks name no zone.
// PostNord's and Bring's carry offsets. Chunghwa Post follows mail from abroad
// under the sending post's number for six months and dates its own scans on
// Taiwan time; its notes say the posts of the United States, Canada, Australia,
// Denmark, South Africa, the Netherlands, Italy, the United Kingdom, Bahrain,
// Yemen, Romania, Brazil and France no longer give online tracking of
// registered letters. Pošta Srbije, Pošta
// Slovenije, Cyprus Post, MaltaPost, POST Luxembourg and Magyar Posta follow mail
// from abroad under the sending post's number; Magyar Posta's lookup opens a
// browser. Omniva's tracker carries the scans in Estonia of mail from abroad,
// on UTC clocks. Kyrgyz Post and Pakistan Post follow mail from abroad under the
// sending post's number and relay that post's scans on its clocks beside their
// own; no clock names a zone. Serpost shows only its own scans of such mail,
// and Pos Indonesia its scans once it handles the item, on clocks in three zones
// that name none. NZ Post follows mail from abroad under the sending post's
// number; its own scans carry UTC instants, and it relays the origin post's on
// Auckland's reading, which its adapter gives back. Israel Post's tracker says
// it follows EMS and ECO POST items sent from abroad, and dates scans to the
// day. The host also checks adapter availability and required inputs before
// making a request.
const NATIONAL_POSTS: ReadonlyMap<string, CarrierId> = new Map([
  ['AM', 'haypost'], ['AR', 'correo-argentino'], ['AT', 'austrian-post'], ['AU', 'australia-post'], ['BD', 'bangladesh-post'],
  ['BE', 'bpost'], ['BG', 'bulgarian-posts'], ['BR', 'correios-br'], ['BY', 'belpost'], ['CA', 'canada-post'],
  ['CH', 'swiss-post'], ['CU', 'correos-cuba'], ['CY', 'cyprus-post'], ['CZ', 'ceska-posta'], ['DE', 'dhl'], ['DK', 'postnord'], ['DZ', 'algerie-poste'],
  ['EE', 'omniva'], ['EG', 'egypt-post'], ['ES', 'correos-spain'], ['FI', 'posti'], ['FO', 'posta-faroe'], ['FR', 'la-poste'],
  ['GB', 'royal-mail'], ['GR', 'elta'], ['HR', 'hrvatska-posta'], ['HU', 'magyar-posta'], ['ID', 'pos-indonesia'], ['IE', 'an-post'], ['IL', 'israel-post'], ['IS', 'posturinn'],
  ['IT', 'poste-italiane'], ['JO', 'jordan-post'], ['JP', 'japan-post'], ['KE', 'posta-kenya'], ['KG', 'kyrgyz-post'], ['LT', 'lietuvos-pastas'],
  ['LU', 'post-luxembourg'], ['LV', 'latvijas-pasts'], ['MA', 'barid-al-maghrib'], ['MK', 'posta-north-macedonia'], ['MT', 'maltapost'],
  ['NL', 'spring-gds'],
  ['NO', 'bring-posten'], ['NZ', 'nz-post'], ['PE', 'serpost'], ['PH', 'phlpost'], ['PK', 'pakistan-post'], ['PL', 'poczta-polska'], ['PT', 'ctt'], ['RO', 'posta-romana'], ['RS', 'posta-srbije'],
  ['SA', 'saudi-post'], ['SE', 'postnord'], ['SI', 'posta-slovenije'], ['SK', 'slovenska-posta'], ['SV', 'correos-el-salvador'], ['TW', 'chunghwa-post'], ['UA', 'ukrposhta'],
  ['US', 'usps'], ['UY', 'correo-uruguayo'], ['UZ', 'uzbekistan-post'], ['ZA', 'south-african-post-office'],
]);
const englishCountries = new Intl.DisplayNames(['en'], { type: 'region' });
// Deprecated codes carry their successor's name, so fold them into it ("FX" is France).
const currentRegion = (code: string) => new Intl.Locale(`und-${code}`).region ?? code;
// Every region's English name, plus the common short forms, by name key.
const COUNTRY_CODES: ReadonlyMap<string, string> = new Map([
  ...Array.from({ length: 26 * 26 }, (_, index) =>
    String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)))
    .map((code) => [key(englishCountries.of(code) ?? ''), currentRegion(code)] as const)
    .filter(([name, code]) => name !== '' && name !== code.toLowerCase()),
  ['uk', 'GB'], ['usa', 'US'],
]);

/** Accept ISO codes or exact English country names supplied by a provider. */
export function nationalPostCandidate(country: unknown): CarrierId | undefined {
  if (typeof country !== 'string') return undefined;
  const value = country.trim().toUpperCase();
  const direct = NATIONAL_POSTS.get(value);
  if (direct) return direct;
  return [...NATIONAL_POSTS].find(([code]) => englishCountries.of(code)?.toUpperCase() === value)?.[1];
}

function catalogCarrier(normalized: string): string | undefined {
  if (AMBIGUOUS_BRANDS.includes(normalized)) return undefined;
  if (Object.hasOwn(NAME_ALIASES, normalized)) return NAME_ALIASES[normalized];
  const matches = Object.entries(CARRIER_DEFINITIONS)
    .filter(([id, definition]) => id !== 'unknown' && [definition.displayName, ...(definition.aliases ?? [])].some(name => key(name) === normalized));
  return matches.length === 1 ? matches[0]![0] : undefined;
}

/** "Chronopost France", "Royal Mail (UK)": the name before a trailing country, and its ISO code. */
function countryQualified(name: string): { base: string; country: string } | undefined {
  const words = name.replace(/[()]/g, ' ').trim().split(/\s+/);
  for (let size = Math.min(3, words.length - 1); size > 0; size--) {
    const tail = words.slice(-size).join(' ');
    const country = COUNTRY_CODES.get(key(tail))
      ?? (/^[A-Z]{2}$/.test(tail) && englishCountries.of(tail) !== tail ? currentRegion(tail) : undefined);
    if (country) return { base: words.slice(0, -size).join(' '), country };
  }
  return undefined;
}

// DPD's networks share one guest service that answers for any DPD parcel, and
// 17TRACK writes "DPD (BE)" for parcels DPD places in the Netherlands. Only
// recognition, from DPD's current country for the parcel, names the network.
const GROUP_LOOKUP_BRANDS = ['dpd'];

/**
 * A brand's one network in a country ("GLS (FR)"). None when a network of the
 * brand works worldwide, as DHL Express does, or several share the country.
 */
function brandNetwork(brand: string, country: string): string | undefined {
  const ids = brandCarrierIds(brand);
  if (ids.some((id) => GROUP_LOOKUP_BRANDS.includes(carrierBrand(id) ?? ''))) return undefined;
  const networks = ids.map((id) => [id, CARRIER_DEFINITIONS[id as CarrierId].countries ?? []] as const);
  if (networks.some(([, countries]) => !countries.length)) return undefined;
  const local = networks.filter(([, countries]) => countries.includes(country));
  return local.length === 1 ? local[0]![0] : undefined;
}

/** A name is only a lookup hint; the destination adapter still has to verify the parcel. */
export function carrierIdFromName(name: string): string | undefined {
  const exact = catalogCarrier(key(name));
  if (exact) return exact;
  // The carrier's own country names the same carrier; another country can be a
  // different company under the brand, and a multi-zone country cannot tell. A
  // brand with several networks names its network there. A carrier whose scans
  // are instants keeps no clock of its country, so its home country decides.
  const qualified = countryQualified(name);
  const carrier = qualified && (catalogCarrier(key(qualified.base)) ?? brandNetwork(qualified.base, qualified.country));
  const zone = qualified && countryTimeZone(qualified.country);
  const definition = carrier ? CARRIER_DEFINITIONS[carrier as CarrierId] : undefined;
  return carrier && zone && (definition?.timezone === zone || definition?.countries?.[0] === qualified.country)
    ? carrier : undefined;
}

/**
 * Whether a reported carrier name is already in the catalog: a carrier or alias,
 * another network of a brand that has several ("DHL Express", "GLS Italy"), or
 * one of those followed by a country. A name it does not know is a carrier new
 * to us or a feed (`isCarrierFeedName`).
 */
export function isKnownCarrierName(name: string): boolean {
  const qualified = countryQualified(name);
  return [key(name), ...(qualified ? [key(qualified.base)] : [])].some((candidate) =>
    CATALOG_NAMES.has(candidate) || NETWORK_BRANDS.some((brand) => candidate.startsWith(brand)));
}

/**
 * Whether a reported name is the postal union's shared feed ("UPU", "Universal
 * Postal Union"). The feed relays every postal operator's scans and names no
 * carrier: it has no catalog id and is not a known carrier name, so a reply
 * that names only the feed says nothing about whose parcel it is.
 */
export function isCarrierFeedName(name: string): boolean {
  return FEED_NAMES.includes(key(name));
}

/**
 * The single clock of the country after a known carrier or brand network
 * ("DPD UK", "GLS Italy", "DHL Parcel Netherlands"), for scans that carry no
 * zone of their own. A zone only, never a carrier. Null for a country with
 * several zones and for names new to the catalog, whose last word need not be
 * a place. The name can be a branch rather than where the scan happened
 * ("Cainiao (China)"), so a scan's own location comes first.
 */
export function carrierNameCountryZone(name: string): string | null {
  const qualified = countryQualified(name);
  return qualified && isKnownCarrierName(name) ? countryTimeZone(qualified.country) : null;
}

/**
 * The catalog networks of a brand named bare or as a group ("DPD", "DPD
 * Group", "GLS", "Hermes"): every carrier whose id is the brand or starts with
 * it and a dash. Empty for other names. The name alone cannot say which
 * network it means; only the tracking number can narrow it.
 */
export function brandCarrierIds(name: string): string[] {
  const normalized = key(name);
  const brand = NETWORK_BRANDS.find((candidate) => normalized === candidate || normalized === `${candidate}group`);
  if (!brand) return [];
  return Object.keys(CARRIER_DEFINITIONS).filter((id) => carrierBrand(id) === brand);
}

/**
 * The catalog zones of a brand's networks (`brandCarrierIds`). The name cannot
 * say which network scanned, so use them only when they all read the scan's
 * clock as one instant (`sharedClockZone`). Empty for other names, and when
 * any network has no local clock (DHL, whose eCommerce network is UTC). The
 * set follows the catalog: a new network of a brand on another clock turns the
 * brand's zone off, which moves the stored instants, and so the event ids, of
 * that brand's past scans.
 */
export function brandTimeZones(name: string): string[] {
  const zones = brandCarrierIds(name).map((id) => carrierTimezone(id));
  return zones.includes('UTC') ? [] : [...new Set(zones)];
}

/**
 * Known portal hosts only. This identifies a lookup hint; it never follows the
 * URL. With `byPath`, a rule limited to some paths of its host covers only
 * those paths, and one there that reads the link's number from its query names
 * the carrier: FedEx's worldwide tracking link holds FedEx Poland's thirteen digits.
 */
function carriersFromUrl(raw: string, byPath: boolean): string[] {
  let url: URL;
  let query: string;
  try { url = new URL(raw); query = decodeURIComponent(url.search.slice(1)); } catch { return []; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return [];
  // Arrival notices also use the Swiss Post homepage instead of its tracking subdomain.
  if (['post.ch', 'www.post.ch'].includes(url.hostname)) return ['swiss-post'];
  const rules = TRACKING_LINK_RULES.filter((rule) => rule.domains.some((domain) => matchesDomain(url.hostname, domain))
    && (!byPath || !rule.pathPattern || rule.pathPattern.test(url.pathname)));
  if (!byPath) return [...new Set(rules.map((rule) => rule.carrier))];
  // A rule that reads its number from the query covers a link without one only when no other rule does.
  const reading = rules.filter((rule) => rule.query?.test(query));
  const others = rules.filter((rule) => !rule.query);
  const covering = reading.length ? reading : others.length ? others : rules;
  return [...new Set(covering.map((rule) => rule.carrier))];
}

/**
 * Reconcile a structured partner name and optional official link, without
 * country guesses. A named partner stands unless its link is on another
 * carrier's host: partners often give a home page, not a tracking path. Only a
 * link without a name uses the path to choose among the carriers of its host.
 */
export function carrierIdFromPartner(name: string, url = ''): string | undefined {
  const named = carrierIdFromName(name);
  if (named) {
    const hosted = carriersFromUrl(url, false);
    return !hosted.length || hosted.includes(named) ? named : undefined;
  }
  const linked = carriersFromUrl(url, true);
  return linked.length === 1 ? linked[0] : undefined;
}

/** Retain ambiguity so weaker hints cannot override conflicting partner links. */
export function carrierIdsFromPartnerLinks(descriptions: (string | null | undefined)[], origin: string): string[] {
  const candidates = new Set(descriptions.flatMap((description) =>
    [...String(description ?? '').matchAll(/https?:\/\/[^\s<>"')]+/gi)]
      .flatMap(([url]) => carriersFromUrl(url, true)).filter((carrier) => carrier !== origin),
  ));
  return [...candidates];
}

/** An unambiguous partner link in carrier wording may propose one confirmation lookup. */
export function carrierIdFromPartnerLinks(descriptions: (string | null | undefined)[], origin: string): string | undefined {
  const candidates = carrierIdsFromPartnerLinks(descriptions, origin);
  return candidates.length === 1 ? candidates[0] : undefined;
}

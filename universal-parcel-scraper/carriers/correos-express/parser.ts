import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { calendarDay, firstOccurrence, regionHasTown } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  FAILED_ROUND, FAILED_ROUND_PT, classifyCorreosExpressStatus, correosExpressCodeLabel, correosExpressSituationKey, isCorreosExpressCode,
  isCorreosExpressFailedRound, type CorreosExpressLanguage,
} from './status.js';

const PROVIDER = 'Correos Express';
const MONTHS: Record<string, number> = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
/** The form's no-history message, in Spanish and in Portuguese. */
const NO_HISTORY: ReadonlySet<string> = new Set(['Lo sentimos, no se ha encontrado ningún envío con el número indicado.',
  'Desculpe, não foi encontrado nenhum envio com o número indicado.']);
/** The history's column headings, which tell the page's language. */
const COLUMNS: Readonly<Record<CorreosExpressLanguage, string>> = { es: 'Fechas/hora|Población|Estado', pt: 'Datas/hora|Cidade|Estado' };
const FAILED_NOTE = /^\.?\s*(?:Su env[ií]o no ha podido ser entregado|Não foi poss[ií]vel entregar o seu envio)\b/iu;
const MAX_SCANS = 500;
const MAX_EVENTS = 100;
const MADRID = 'Europe/Madrid';
const LISBON = 'Europe/Lisbon';
// The locality of the head office's scans: the pre-advice, and some pickup-point scans.
const HEAD_OFFICE = 'CENTRAL';
/**
 * Places of mainland Spain, the Balearic Islands, Ceuta and Melilla the form
 * names depots after: each province and its capital, in Castilian and in the
 * regional language, and the other towns its depots are named for.
 */
const SPAIN: ReadonlySet<string> = new Set([
  'A CORUNA', 'LA CORUNA', 'CORUNA', 'ALAVA', 'ARABA', 'VITORIA', 'GASTEIZ', 'ALBACETE', 'ALICANTE', 'ALACANT', 'ALMERIA',
  'ASTURIAS', 'OVIEDO', 'AVILA', 'BADAJOZ', 'BALEARES', 'PALMA', 'PALMA DE MALLORCA', 'MALLORCA', 'MENORCA', 'IBIZA', 'EIVISSA',
  'BARCELONA', 'BIZKAIA', 'VIZCAYA', 'BILBAO', 'BURGOS', 'CACERES', 'CADIZ', 'CANTABRIA', 'SANTANDER', 'CASTELLON', 'CASTELLO',
  'CIUDAD REAL', 'CORDOBA', 'CUENCA', 'GIPUZKOA', 'GUIPUZCOA', 'SAN SEBASTIAN', 'DONOSTIA', 'GIRONA', 'GERONA', 'GRANADA',
  'GUADALAJARA', 'HUELVA', 'HUESCA', 'JAEN', 'LA RIOJA', 'LOGRONO', 'LEON', 'LLEIDA', 'LERIDA', 'LUGO', 'MADRID', 'MALAGA',
  'MURCIA', 'NAVARRA', 'PAMPLONA', 'OURENSE', 'ORENSE', 'PALENCIA', 'PONTEVEDRA', 'SALAMANCA', 'SEGOVIA', 'SEVILLA', 'SORIA',
  'TARRAGONA', 'TERUEL', 'TOLEDO', 'VALENCIA', 'VALLADOLID', 'ZAMORA', 'ZARAGOZA', 'CEUTA', 'MELILLA',
  'ALGECIRAS', 'BENAVENTE', 'ESTACION DE ESPELUY', 'JEREZ DE LA FRONTERA', 'SANTIAGO DE COMPOSTELA', 'VIGO',
]);
/** The district capitals of mainland Portugal, less Vila Real, whose name a Spanish town also writes. */
const PORTUGAL: ReadonlySet<string> = new Set([
  'AVEIRO', 'BEJA', 'BRAGA', 'BRAGANCA', 'CASTELO BRANCO', 'COIMBRA', 'EVORA', 'FARO', 'GUARDA', 'LEIRIA', 'LISBOA',
  'PORTALEGRE', 'PORTO', 'SANTAREM', 'SETUBAL', 'VIANA DO CASTELO', 'VISEU',
]);

/**
 * The sentences that explain a situation, the same for every shipment, as the
 * form and the localizador write them in Spanish and in Portuguese. Whatever
 * else follows a label, such as a pickup point's name and address, a reason
 * that names the recipient or a courier's note, is dropped.
 */
const EXPLANATIONS: readonly string[] = [
  'Ya hemos recibido la información de su envío, en breve dispondremos de su mercancía',
  'Si necesita información adicional por favor póngase en contacto con su remitente',
  'Si necesita más información por favor contacte con su remitente',
  'Su envío está en uno de nuestro vehículos siendo transportado a la localidad de destino',
  'Su envío está en uno de nuestros vehículos siendo transportado a la localidad de destino',
  'Lo recibirá en la fecha de entrega prevista',
  'Su envío está en nuestras instalaciones de destino y lo estamos clasificando',
  'Su envío se encuentra en reparto',
  'Su envío no ha podido ser entregado porque la dirección que tenemos es incompleta o incorrecta',
  'Su envío no ha podido ser entregado por no localizar al destinatario en el momento de la entrega',
  'Su envío no ha podido ser entregado por una incidencia logística en nuestro reparto',
  'Su envío no ha podido ser entregado por haberse modificado la fecha de entrega de la mercancía',
  'Su envío no ha podido ser entregado por carecer de la documentación necesaria',
  'Si desea gestionar una nueva entrega por favor pulse la opción Gestionar nueva entrega',
  'Ya hemos gestionado su envío y lo recibirá en la fecha de entrega prevista',
  'Concertación entrega flexible',
  'Su envío está entregado',
  'Su envío está en proceso de gestión por nuestro departamento de Atención al cliente',
  'Hemos recibido instrucciones de nuestro cliente para entregar su envío al nuevo destino',
  'Su envío se ha devuelto al remitente',
  'Su envío se encuentra en el punto de conveniencia seleccionado y en breve recibirá las instrucciones para recogerlo',
  'Su envío ya está disponible en el punto de conveniencia seleccionado para poder ser recogido',
  'Tiempo de recogida finalizado en Punto de Conveniencia',
  // The Portuguese form's.
  'Já recebemos as informações do seu envio, em breve teremos a sua mercadoria na nossa posse',
  'Se precisar de informações adicionais, entre em contato com o expedidor',
  'Seu envio está em trânsito para a localidade destino nos nossos veículos',
  'Será entregue na data prevista',
  'Seu envio está nas nossas instalações de destino e estamos a classificá-lo',
  'Seu envio encontra-se em distribuição',
  'Não foi possivel entregar o seu envio porque a morada de destino está incompleta ou incorreta',
  'Não foi possivel entregar o seu envio porque não foi possivel localizar o destinatário no momento da entrega',
  'Não foi possivel entregar o seu envio devido a uma incidencia logistica na nossa distribuição',
  'Se deseja solicitar uma nova entrega por favor selecione Organizar Nova entrega',
  'Se deseja solicitar uma nova entrega por favor selecione Organizar nova entrega',
  'Já tomadas as ações necessárias e será entregue na data prevista',
  'Seu envio foi entregue',
  'Seu envio está em processo de gestão pelo nosso departamento de Apoio ao Cliente',
  'Seu envio foi devolvido ao expedidor',
  'Para mais informações por favor contacte o expedidor',
  'Sua remessa está no ponto de conveniência selecionado e em breve você receberá instruções para retirá-la',
  'Sua remessa já está disponível no ponto de conveniência selecionado para retirada',
  'O tempo de coleta terminou em Ponto de Conveniência',
  // The Portuguese localizador's.
  'Já recebemos as informações do seu envio, em breve teremos a sua encomenda',
  'Se precisar de mais informações, contacte o seu remetente',
  'O seu envio está num dos nossos veículos a caminho da localidade de destino',
  'O seu envio está num dos nossos veículos a ser transportado para a localidade de destino',
  'Recebê-lo-á na data de entrega prevista',
  'O seu envio está nas nossas instalações de destino e estamos a classificá-lo',
  'O seu envio encontra-se em distribuição',
  'O seu envio não pôde ser entregue porque a morada que temos está incompleta ou incorreta',
  'O seu envio não pôde ser entregue porque o destinatário não foi encontrado no momento da entrega',
  'O seu envio não pôde ser entregue devido a um problema logístico na nossa distribuição',
  'Se deseja gerir uma nova entrega por favor prima a opção Gerir nova entrega',
  'Já preparámos o seu envio e recebê-lo-á na data de entrega prevista',
  'Acordo entrega flexível',
  'O seu envio está entregue',
  'O seu envio está em tratamento pelo serviço de Apoio ao cliente',
  'O envio foi devolvido ao remetente',
  'O seu envio encontra-se no ponto de conveniência selecionado e em breve receberá as instruções para o recolher',
  'O seu envio já está disponível no ponto de conveniência selecionado para ser recolhido',
].map((sentence) => sentence.normalize('NFC')).sort((left, right) => right.length - left.length);

/**
 * The fixed sentences a text opens with, each ended by a period; empty when it
 * opens with anything else. The Portuguese form can leave the period out
 * before the next text, which then opens with a capital.
 */
export function fixedExplanation(text: string): string {
  let rest = text.normalize('NFC').replace(/­/g, '').replace(/\s+/g, ' ').replace(/^[.\s]+/, '');
  const kept: string[] = [];
  while (rest) {
    const sentence = EXPLANATIONS.find((candidate) => rest.startsWith(candidate)
      && (rest.length === candidate.length || rest[candidate.length] === '.' || /^\p{Lu}/u.test(rest.slice(candidate.length))));
    if (!sentence) break;
    kept.push(`${sentence}.`);
    rest = rest.slice(sentence.length).replace(/^[.\s]+/, '');
  }
  return kept.join(' ');
}

export function normalizeCorreosExpressNumber(raw: string): string {
  const number = raw.replace(/[\s.-]/g, '');
  // The public form tracks sixteen-digit shipment numbers and the twenty-three-digit
  // references of some marketplace senders. The longer one is not the shorter one extended.
  if (!/^(?:\d{16}|\d{23})$/.test(number)) throw new InvalidInputError(PROVIDER, 'Correos Express requires a 16-digit or 23-digit shipment number');
  return number;
}

/**
 * A twenty-three-digit parcel label opens with the shipment number less its
 * check digit, then gives the parcel's position, the destination postcode and
 * its own check digit. The page names the shipment it belongs to, and so
 * supplies the shipment's first digit: Spanish labels keep it, and one
 * Portuguese label opened with 6 for a shipment starting with 9. Only the next
 * fourteen digits must agree.
 */
function isLabelShipment(number: string, shipment: string | undefined): boolean {
  return number.length === 23 && hasGs1CheckDigit(number) && /^\d{16}$/.test(shipment ?? '')
    && hasGs1CheckDigit(shipment!) && shipment!.slice(1, 15) === number.slice(1, 15);
}

/** Calendar and clock digits as local time. UTC only validates them; no instant or offset is emitted. */
function localTime(digits: string, format: string): string | undefined {
  const date = DateTime.fromFormat(digits, format, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only digits that read back unchanged are kept.
  return date.isValid && date.toFormat(format) === digits
    ? date.toISO({ includeOffset: false, suppressMilliseconds: true }) ?? undefined : undefined;
}

function scanClock(raw: string): { local_time?: string; provider_time_text?: string } {
  const text = clean(raw, 64);
  const digits = /^(?:[\p{L}]{3},?\s+)?(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}(?::\d{2})?)$/u.exec(text)?.[1];
  const local = digits ? localTime(digits, digits.length === 19 ? 'dd/MM/yyyy HH:mm:ss' : 'dd/MM/yyyy HH:mm') : undefined;
  if (local) return { local_time: local };
  return text ? { provider_time_text: text } : {};
}

/** One scan of the localizador: its clock to the second, its situation code when it has one, and its fixed explanation. */
export interface CorreosExpressFeedScan {
  local_time: string;
  code?: string;
  explanation: string;
}

/** The localizador's history of a shipment, oldest first, and the shipment it names. */
export interface CorreosExpressFeed {
  shipment: string;
  scans: CorreosExpressFeedScan[];
}

/**
 * The Correos group's localizador reply for a Correos Express number. The
 * localizador knows a parcel label by its shipment, which it names, and lists
 * the label among the shipment's associated parcels. Null when it has no trace
 * of the number. Recipient, reference, cash-on-delivery and parcel details in
 * the reply are not read.
 */
export function parseCorreosExpressFeed(payload: unknown, raw: string): CorreosExpressFeed | null {
  const number = normalizeCorreosExpressNumber(raw);
  // A single-element array; a bare object is read the same way.
  const envelope: unknown = Array.isArray(payload) ? (payload.length === 1 ? payload[0] : undefined) : payload;
  if (!isRecord(envelope)) throw new SchemaError(PROVIDER, 'The Correos localizador returned an invalid reply');
  const shipment = cleanScalar(envelope.codEnvio, 40);
  const parcels: unknown = envelope.enviosAsociados;
  const labels = Array.isArray(parcels) ? parcels.filter(isRecord).map((parcel) => cleanScalar(parcel.codEnvio, 40)) : [];
  if (shipment !== number && !(isLabelShipment(number, shipment) && labels.includes(number))) {
    throw new SchemaError(PROVIDER, 'The Correos localizador returned a different shipment');
  }
  const error = envelope.error;
  const outcome = isRecord(error) ? cleanScalar(error.codError, 8) : '';
  // Sin Trazabilidad: the localizador has no trace of the number.
  if (outcome === '3') return null;
  if (outcome !== '0') throw new IndeterminateError(PROVIDER, 'The Correos localizador did not return the shipment history');
  const events: unknown = envelope.eventos;
  if (events !== null && events !== undefined && !Array.isArray(events)) throw new SchemaError(PROVIDER, 'The Correos localizador returned an invalid history');
  const list: unknown[] = Array.isArray(events) ? events : [];
  if (list.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'The Correos localizador returned too many scans');
  const scans = list.map((event): CorreosExpressFeedScan => {
    if (!isRecord(event)) throw new SchemaError(PROVIDER, 'The Correos localizador returned an invalid scan');
    const date = clean(event.fecEvento, 16), time = clean(event.horEvento, 16);
    const clock = /^\d{2}\/\d{2}\/\d{4}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time) ? localTime(`${date} ${time}`, 'dd/MM/yyyy HH:mm:ss') : undefined;
    const code = cleanScalar(event.codEvento, 32).toUpperCase();
    if (!clock || (code && !/^[A-Z0-9]{2,16}$/.test(code))) throw new SchemaError(PROVIDER, 'The Correos localizador returned an invalid scan');
    return { local_time: clock, ...(code ? { code } : {}), explanation: fixedExplanation(clean(event.desTextoAmpliado, 500)) };
  });
  return { shipment, scans };
}

/** A scan before its description is written: the label it shows and the fixed explanation that goes with it. */
interface Scan {
  event: CarrierEvent;
  label: string;
  explanation: string;
  mapped: ClassifiedStatus | undefined;
}

/** The description a scan keeps: its label and fixed explanation, or a neutral wording when the label is unknown. */
function described({ event, label, explanation, mapped }: Scan): CarrierEvent {
  const description = !mapped ? 'Tracking update' : mapped.status === 'delivered' ? 'Delivered'
    // A failed round's explanation opens with the label.
    : isCorreosExpressFailedRound(label) ? explanation || label : explanation ? `${label}. ${explanation}` : label;
  return { description, ...event };
}

const minute = (scan: Scan | CorreosExpressFeedScan) => {
  const local = 'event' in scan ? scan.event.local_time : scan.local_time;
  return typeof local === 'string' ? local.slice(0, 16) : undefined;
};

function grouped<T>(items: readonly T[], keyOf: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = keyOf(item);
    if (name !== undefined) groups.set(name, [...groups.get(name) ?? [], item]);
  }
  return groups;
}

/**
 * The localizador gives the form's scans their seconds and situation codes. A
 * coded scan pairs with the form row of the same minute and situation; a scan
 * without a code pairs with the one row left in its minute. Only a pairing
 * that is the only one possible is made. The localizador has no admission
 * scan, so the admission row is never paired. A coded scan in a minute the
 * form does not show is added without a locality.
 */
function enrich(scans: Scan[], feed: CorreosExpressFeed, language: CorreosExpressLanguage): Scan[] {
  const used = new Set<CorreosExpressFeedScan>();
  const paired = new Set<Scan>();
  const pair = (rows: Map<string, Scan[]>, found: Map<string, CorreosExpressFeedScan[]>, coded: boolean) => {
    for (const [name, matches] of found) {
      const candidates = rows.get(name)?.filter((scan) => !paired.has(scan)) ?? [];
      if (matches.length !== 1 || candidates.length !== 1) continue;
      const [scan] = candidates, [match] = matches;
      paired.add(scan!);
      used.add(match!);
      scan!.event.local_time = match!.local_time;
      if (coded) scan!.event.provider_code = match!.code!;
      scan!.explanation ||= match!.explanation;
    }
  };
  const situation = (scan: CorreosExpressFeedScan) => (scan.code ? correosExpressCodeLabel(scan.code) : undefined);
  pair(grouped(scans, (scan) => scan.mapped && minute(scan) && `${minute(scan)}\u0000${correosExpressSituationKey(scan.label)}`),
    grouped(feed.scans, (scan) => situation(scan) && `${minute(scan)}\u0000${correosExpressSituationKey(situation(scan)!)}`), true);
  pair(grouped(scans.filter((scan) => !paired.has(scan) && !correosExpressSituationKey(scan.label).startsWith('ADMITIDO')), minute),
    grouped(feed.scans.filter((scan) => !scan.code), minute), false);
  const shown = new Set(scans.map(minute));
  if (shown.has(undefined)) return scans;
  const added = feed.scans.filter((scan) => !used.has(scan) && situation(scan) && !shown.has(minute(scan)))
    .map((scan) => feedScan(scan, language)).reverse();
  const merged = [...scans];
  for (const scan of added) {
    const index = merged.findIndex((other) => minute(other)! < minute(scan)!);
    merged.splice(index < 0 ? merged.length : index, 0, scan);
  }
  return merged;
}

/** A localizador scan as the form would show it in `language`. */
function feedScan(scan: CorreosExpressFeedScan, language: CorreosExpressLanguage): Scan {
  const label = (scan.code && correosExpressCodeLabel(scan.code, language)) ?? '';
  const mapped = label ? classifyCorreosExpressStatus(label) : undefined;
  return { label, explanation: mapped ? scan.explanation : '', mapped,
    event: { ...(mapped ? { provider_status: label, stage: mapped.stage } : {}), local_time: scan.local_time,
      ...(scan.code ? { provider_code: scan.code } : {}) } };
}

/** A locality written for comparison: capitals without accents, words separated by single spaces. */
const placeKey = (text: string) => text.normalize('NFD').replace(/\p{Mn}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * The zone of a place the form names. A depot is written as its town, with a
 * number ("BARCELONA2"), and in Spain as a one-word town and one more word
 * ("VALENCIA SUR", "MADRID GETAFE"); a sender's town followed by its province
 * ("DOS HERMANAS - SEVILLA") is read by the province. A place naming a town or
 * island of the Canary Islands or the Azores, whose clocks differ from their
 * mainland's, and any other place have none.
 */
function placeZone(location: string): string | null {
  const parts = location.split(/\s+-\s+/).map(placeKey);
  if (parts.some((part) => regionHasTown('ES-CN', part) || regionHasTown('PT-20', part))) return null;
  const place = parts.at(-1)!;
  const town = place.replace(/ ?\d+$/, '');
  if (PORTUGAL.has(town)) return LISBON;
  return SPAIN.has(town) || (/^[A-Z]+ [A-Z0-9]+$/.test(place) && SPAIN.has(place.split(' ')[0]!)) ? MADRID : null;
}

/** A wall clock's instant in the zone; none for a clock the zone skips when its clocks go forward. */
function instant(wall: string, zone: string): string | null {
  const placed = firstOccurrence(DateTime.fromISO(wall, { zone }));
  return placed.isValid && placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall ? placed.toISO({ suppressMilliseconds: true }) : null;
}

const admission = (scan: Scan) => correosExpressSituationKey(scan.label).startsWith('ADMITIDO');

/**
 * The scans whose locality settles their clock, dated. A depot keeps the civil
 * time of the place it is named for: mainland Spain's, the Balearic Islands',
 * Ceuta's and Melilla's on Madrid's clock, mainland Portugal's on Lisbon's. The
 * head office keeps Madrid's clock, which settles its scans when every depot
 * the parcel passed keeps it too. An admission is recorded by the depot that
 * admits the parcel, which neither its row, naming the sender's town, nor the
 * scan beside it, which can name the hub the parcel is sent to, need name; the
 * scans of its minute are dated only when all their places keep one clock.
 * Every other scan keeps its wall clock. An instant is to the minute the form
 * shows: the localizador's seconds come and go with its availability, and a
 * scan must keep one instant from one check to the next.
 */
function dated(scans: Scan[]): Scan[] {
  const central = (scan: Scan) => placeKey(scan.event.location ?? '') === HEAD_OFFICE;
  const headOffice = scans.every((scan) => !scan.event.location || admission(scan) || central(scan)
    || placeZone(scan.event.location) === MADRID) ? MADRID : null;
  const zoneOf = (scan: Scan) => (!scan.event.location ? null : central(scan) ? headOffice : placeZone(scan.event.location));
  const admitted = new Set(scans.filter(admission).map(minute));
  return scans.map((scan) => {
    const { local_time: wall, ...event } = scan.event;
    if (typeof wall !== 'string') return scan;
    const zones = new Set(admitted.has(minute(scan)) ? scans.filter((other) => minute(other) === minute(scan)).map(zoneOf) : [zoneOf(scan)]);
    const zone = zones.size === 1 ? [...zones][0] : null;
    const time = zone ? instant(`${minute(scan)}:00`, zone) : null;
    return time ? { ...scan, event: { time, ...event } } : scan;
  });
}

const latestStatus = (event: CarrierEvent) => classifyCorreosExpressStatus(typeof event.provider_status === 'string' ? event.provider_status : '');

/** The result for scans newest first: the newest scan's instant is the last update, and the delivery's when it delivered. */
function project(events: CarrierEvent[], extra: CarrierResult = {}): CarrierResult {
  const latest = events[0]!;
  const mapped = latestStatus(latest);
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time ?? null }),
    ...(mapped?.status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    expected_delivery: null, ...extra, events: events.slice(0, MAX_EVENTS) };
}

/** The tracking form's page read, and whether a row shows a label the map does not read. */
export interface CorreosExpressRead {
  result: CarrierResult;
  unread: boolean;
}

/**
 * The tracking form's page, in Spanish or Portuguese, with the localizador's
 * history in the same language when it names the same shipment. A page that
 * names no shipment is the form's negative only with the server-selected
 * no-history code and the matching request echo.
 */
export function parseCorreosExpress(html: string, raw: string, feed?: CorreosExpressFeed | null): CarrierResult {
  return readCorreosExpress(html, raw, feed).result;
}

export function readCorreosExpress(html: string, raw: string, feed?: CorreosExpressFeed | null): CorreosExpressRead {
  const number = normalizeCorreosExpressNumber(raw);
  const $ = load(html);
  const tables = $('table.miyazaki');
  if (!tables.length) {
    const forms = $('#desktopHomeForm, #mobileHomeForm');
    const inputs = forms.find('input[name="shippingNumber"]').map((_, node) => String($(node).val())).get();
    const errors = forms.find('input[name="errorCode"]').map((_, node) => String($(node).val())).get();
    // All error messages exist in the initial page. Only the selected server
    // code and the matching request echo establish the observed negative.
    if (inputs.length && inputs.some((value) => value !== number)) throw new SchemaError(PROVIDER, 'Correos Express returned a different lookup');
    if (inputs.length === forms.length && errors.length === forms.length && forms.length >= 1 && forms.length <= 2
      && errors.every((code) => code === '2')
      && $('.errorMessage2 .errorMessage').toArray().some((node) => NO_HISTORY.has(clean($(node).text(), 300)))) {
      throw new NotFoundError(PROVIDER);
    }
    throw new IndeterminateError(PROVIDER, 'Correos Express did not return shipment history');
  }
  const heading = $('h3.status');
  const identities = heading.find('.shipping > span').map((_, node) => clean($(node).text(), 40)).get();
  const shipment = isLabelShipment(number, identities[0]) ? identities[0] : undefined;
  if (tables.length !== 1 || heading.length !== 1 || heading.find('.shipping').length !== 1 || identities.length !== 1
    || (identities[0] !== number && !shipment)
    || $('#shippingNumber').length !== 1 || $('#shippingNumber').val() !== number) {
    throw new SchemaError(PROVIDER, 'Correos Express returned a different or ambiguous shipment');
  }
  const headers = tables.find('thead th').map((_, node) => clean($(node).text(), 64)).get().join('|');
  const language = (Object.keys(COLUMNS) as CorreosExpressLanguage[]).find((name) => COLUMNS[name] === headers);
  if (!language) throw new SchemaError(PROVIDER, 'Correos Express history columns changed');
  const rows = tables.find('tbody tr');
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'Correos Express returned an empty history');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Correos Express returned too many scans');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  let unread = false;
  // The carrier renders newest first. Preserve its order when a newest clock
  // is unresolved; never promote an older dated delivery over that row.
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Correos Express returned an incomplete scan');
    const rawStatus = clean(cells.eq(2).text(), 500);
    if (!rawStatus) throw new SchemaError(PROVIDER, 'Correos Express returned an empty scan');
    // The carrier sometimes leaves the label blank and puts a free-form
    // incident note after the first period. Only known labels and the fixed
    // explanations are retained. A failed round's note opens with a fixed
    // phrase and then gives the reason, which can name the recipient; only a
    // fixed reason is kept.
    const failed = FAILED_NOTE.test(rawStatus);
    const label = failed ? (language === 'pt' ? FAILED_ROUND_PT : FAILED_ROUND) : rawStatus.split('.')[0]!.trim();
    const explanation = fixedExplanation(failed ? rawStatus : rawStatus.slice(rawStatus.indexOf('.') + 1 || rawStatus.length));
    const clock = scanClock(cells.eq(0).text());
    const location = clean(cells.eq(1).text(), 200);
    const mapped = classifyCorreosExpressStatus(label);
    const key = `${clock.local_time ?? clock.provider_time_text ?? ''}\u0000${rawStatus}\u0000${location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unread ||= !mapped && label !== '';
    scans.push({ label, explanation: mapped ? explanation : '', mapped,
      event: { ...(mapped ? { provider_status: label, stage: mapped.stage } : {}), ...clock, ...(location ? { location } : {}) } });
  }
  // The localizador names a label's shipment; the form may name it too, and then both must agree.
  const bound = feed && (feed.shipment === number || (shipment ? feed.shipment === shipment : isLabelShipment(number, feed.shipment)));
  const events = dated(bound ? enrich(scans, feed, language) : scans).map(described);
  const latest = events[0]!;
  const mapped = latestStatus(latest);
  // The estimate is read in Spanish only: how the Portuguese page words one is not known.
  const estimate = language === 'es' ? /Entrega prevista:\s*[\p{L}]+,?\s+(\d{1,2})\s+([\p{L}]{3})\s+(\d{4})/iu.exec(heading.text()) : null;
  const month = estimate && MONTHS[estimate[2]!.toLowerCase()];
  const day = estimate && month ? calendarDay(Number(estimate[3]), month, Number(estimate[1])) : null;
  // An instant is written in its scan's zone, so it opens with the scan's own day.
  const wall = latest.local_time ?? latest.time;
  const latestDay = typeof wall === 'string' ? wall.slice(0, 10) : null;
  const active = mapped && ['pending', 'in_transit', 'out_for_delivery'].includes(mapped.status);
  return { unread, result: project(events, { expected_delivery: active && day && latestDay && day >= latestDay ? day : null,
    ...(shipment ? { canonical_tracking_number: shipment } : {}) }) };
}

/**
 * The localizador's history alone, for a shipment the form no longer shows,
 * labelled as the form would label it in the language the localizador was
 * asked in. The localizador serves the whole Correos group, so its history
 * counts as Correos Express's only when every coded scan has a Correos Express
 * situation code. Its scans have no locality.
 */
export function correosExpressFeedResult(feed: CorreosExpressFeed, raw: string, language: CorreosExpressLanguage = 'es'): CarrierResult {
  const number = normalizeCorreosExpressNumber(raw);
  const codes = feed.scans.flatMap((scan) => (scan.code ? [scan.code] : []));
  if (!codes.length || !codes.every(isCorreosExpressCode)) {
    throw new IndeterminateError(PROVIDER, 'The Correos localizador did not return a Correos Express history');
  }
  const distinct = new Map(feed.scans.map((scan, index) => [`${scan.local_time}\u0000${scan.code ?? ''}\u0000${scan.explanation}`, { scan, index }]));
  // Oldest first; of two scans in the same second the later one is newer.
  const ordered = [...distinct.values()].sort((left, right) => (left.scan.local_time < right.scan.local_time ? 1
    : left.scan.local_time > right.scan.local_time ? -1 : right.index - left.index));
  const events = ordered.map(({ scan }) => described(feedScan(scan, language)));
  return project(events, feed.shipment === number ? {} : { canonical_tracking_number: feed.shipment });
}

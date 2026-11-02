import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { brandCarrierIds } from '../../core/catalog/hints.js';
import { isBrtCustomerParcelId, isBrtTrackingNumber } from '../../core/detection/brt.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierId } from '../../generated/catalog.js';
import { calendarDay, countryCode, countryTimeZone, isoTime, sharedClockZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { API_LABELS } from '../dpd/status.js';
import { DEPOT, isBrtCarrierDepot } from './depot.js';
import { brtEnglishLabel, classifyBrtStatus, DPD_INTAKE, DPD_TRANSIT } from './status.js';

export function normalizeBrtNumber(raw: string): string {
  const number = raw.replace(/\s/g, '').toUpperCase();
  if (!isBrtTrackingNumber(number)) {
    throw new InvalidInputError('BRT', 'BRT requires a twelve-digit shipment number, fourteen-digit BRTcode or parcel ID');
  }
  return number;
}

/**
 * A parcel ID ("ID collo"), searched through the form's customer parcel ID
 * route: fifteen digits, or a customer parcel ID of EOB and seventeen digits.
 */
export function isBrtParcelId(number: string): boolean {
  return /^\d{15}$/.test(number) || isBrtCustomerParcelId(number);
}

/** The label in a table's first cell of a row, as BRT prints it. */
function rowLabel($: CheerioAPI, row: Parameters<CheerioAPI>[0]): string {
  return clean($(row).children('td').first().text(), 40);
}

/**
 * The shipment's own detail table. A held parcel ("giacenza") adds a second
 * table of the same class, headed by its storage number, which is not shipment
 * identity.
 */
function shipmentTables($: CheerioAPI) {
  return $('table.table_dati_spedizione').filter((_, table) =>
    $(table).find('tr').toArray().some((row) => ['N. spedizione', 'BRTcode'].includes(rowLabel($, row))));
}

/**
 * The scan table, with its four columns. A shipment handed to DPD abroad adds a
 * two-column link box of the same class, which is not history.
 */
function scanTables($: CheerioAPI) {
  return $('table.table_stato_dati').filter((_, table) => $(table).find('tr').first().children('td, th').length === 4);
}

// BRT's reply for a shipment number it has not found, which also answers a
// shipment it has not processed yet, in English and in Italian. The parcel ID
// search replies without the code.
const NOT_FOUND_OR_PROCESSING = [
  'Shipment not found or still being processed in our systems. Correct the entered parameter or wait and then repeat the search',
  'Spedizione non trovata oppure ancora in elaborazione nei nostri sistemi. '
    + 'Correggere il parametro immesso oppure attendere e ripetere successivamente la ricerca',
];

/** The error the portal reports under its "Errori riscontrati" heading, or '' when it reports none. */
function portalError($: CheerioAPI): string {
  const scope = $('#box_tool_content');
  const heading = scope.children('h3.separatore');
  const errors = scope.children('#box_contenuti').clone();
  errors.find('script, style').remove();
  return scope.length === 1 && errors.length === 1 && heading.length === 1 && clean(heading.text(), 80) === 'Errori riscontrati'
    ? clean(errors.text(), 300) : '';
}

/** Explains a page without shipment details: BRT's own negative or not-found reply, else inconclusive. */
function throwPortalError($: CheerioAPI, number: string): never {
  const error = portalError($);
  if (number.length === 14 && [`TIS0868 Parcel Label number ${number} not found`, `TIS0868 Parcel label number ${number} non trovato`].includes(error)) {
    throw new NotFoundError('BRT');
  }
  if (NOT_FOUND_OR_PROCESSING.some((reply) => error === `TIS0564 ${reply}` || (isBrtParcelId(number) && error === reply))) {
    throw new IndeterminateError('BRT', 'BRT has not found the shipment or not processed it yet', { reason: 'portal_not_found' });
  }
  throw new IndeterminateError('BRT', 'BRT did not return shipment history');
}

/**
 * The link from a parcel-ID result to its list of parcels, which names each
 * parcel's BRT and customer IDs. Only a relative link to that list for the
 * same shipment is followed.
 */
export function brtParcelListPath(html: string, number: string): string {
  const $ = load(html);
  const shipments = shipmentTables($);
  // The search covers about two months, so an older parcel ID is not found either.
  if (!shipments.length && !scanTables($).length) throwPortalError($, number);
  const shipment = shipments.length === 1
    ? shipments.find('tr').filter((_, row) => rowLabel($, row) === 'N. spedizione').children('td').last().text()
    : '';
  const href = $('a#aColli').attr('href') ?? '';
  const url = /^sped_colli_lista\.htm\?[^#\s]*$/.test(href) ? new URL(href, 'https://vas.brt.it/vas/') : null;
  if (!url || !/^\d{12}$/.test(clean(shipment, 20)) || url.searchParams.get('nspediz') !== clean(shipment, 20)) {
    throw new SchemaError('BRT', 'BRT returned no parcel list for the parcel ID');
  }
  url.searchParams.set('lang', 'en');
  return `${url.pathname}${url.search}`;
}

/** Whether BRT's parcel list for the shipment names the requested parcel ID. */
export function brtParcelListNames(html: string, number: string): boolean {
  const $ = load(html);
  const tables = $('table.table_spedizione').filter((_, table) =>
    $(table).find('tr').first().children('td, th').map((__, node) => clean($(node).text(), 40)).get().join('|') === 'ID collo BRT|ID collo cliente');
  if (tables.length !== 1) throw new SchemaError('BRT', 'BRT parcel list changed');
  const rows = tables.find('tr').slice(1).toArray();
  if (rows.length === 0 || rows.length > 500) throw new SchemaError('BRT', 'BRT parcel list changed');
  return rows.some((row) => $(row).children('td').toArray().some((cell) => clean($(cell).text(), 40) === number));
}

// BRT's depots in Italy keep Italian civil time: DPD's tracking of the same
// parcels gives their scans the same clocks with Italy's offset.
const HOME_ZONE = 'Europe/Rome';

/**
 * The zones of the countries a depot's name gives. The DPD network's depots
 * abroad, through which BRT sends and receives parcels, come in the same form
 * as BRT's, named after their country ("DPD-ROV-GERMANIA", "BELGIO/LUSSEMBURGO")
 * or DPD and their region ("DPD FR NORD"). Null for a place that is not a
 * depot or names a country of several zones; empty when it names none.
 */
function depotZones(place: string): string[] | null {
  const name = DEPOT.exec(place)?.[1];
  if (!name) return null;
  const words = name.split(/[^\p{L}]+/u).filter(Boolean);
  const zones = new Set<string>();
  // Every run of words, so that "REGNO UNITO" counts. Two letters would read as a country code.
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= words.length; end += 1) {
      const run = words.slice(start, end).join(' ');
      const country = run.length > 2 ? countryCode(run) : null;
      if (!country) continue;
      const zone = countryTimeZone(country);
      if (!zone) return null;
      zones.add(zone);
    }
  }
  return [...zones];
}

/**
 * The zones a depot's two-letter words give as country codes, as "FR" in
 * "CHR-FR SUD". BRT's own depots open with their province's two letters, which
 * can be another country's code ("NA-…" is Naples and Namibia). Null when a
 * word is no code of a single-zone country, or the name has none.
 */
function codeZones(place: string): string[] | null {
  const codes = DEPOT.exec(place)?.[1]?.split(/[^\p{L}]+/u).filter((word) => word.length === 2) ?? [];
  const zones = new Set<string>();
  for (const code of codes) {
    const zone = countryTimeZone(code);
    if (!zone) return null;
    zones.add(zone);
  }
  return zones.size ? [...zones] : null;
}

/**
 * The clocks a scan's place may keep. A depot named after a country keeps
 * that country's clock or BRT's own, Italy's. A depot naming none is one of
 * BRT's in Italy only where the caller knows it to be; elsewhere a two-letter
 * country code in its name counts as its country.
 */
function clockZones(place: string, inItaly: boolean): string[] | null {
  const zones = depotZones(place);
  if (!zones) return null;
  if (zones.length) return [HOME_ZONE, ...zones];
  if (inItaly && !/^DPD\b/i.test(place)) return [HOME_ZONE];
  const codes = codeZones(place);
  return codes ? [HOME_ZONE, ...codes] : null;
}

/**
 * A scan's date and clock. A clock that reads as the same instant on each of
 * its place's zones, and only once on Italy's, is that instant; other clocks
 * stay local times. A scan BRT dates by its day alone, as it does a delivery
 * round, keeps that day; any other date or clock stays provider text.
 */
function scanClock(date: string, clock: string, zones: readonly string[] | null): { time?: string; local_time?: string; provider_time_text?: string } {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  const day = match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  if (day && !clock) return { local_time: day };
  const time = /^(\d{2})\.(\d{2})$/.exec(clock);
  if (day && time && Number(time[1]) < 24 && Number(time[2]) < 60) {
    const wall = `${day}T${time[1]}:${time[2]}:00`;
    if (zones && DateTime.fromISO(wall, { zone: HOME_ZONE }).getPossibleOffsets().length === 1 && sharedClockZone(zones, wall)) {
      const placed = isoTime(wall, HOME_ZONE);
      if (placed?.iso.startsWith(wall)) return { time: placed.iso };
    }
    return { local_time: wall };
  }
  const raw = clean(`${date} ${clock}`, 64);
  return raw ? { provider_time_text: raw } : {};
}

/**
 * The DPD network that delivers a parcel BRT sent abroad: the one in the single
 * country that the DPD depot of its newest scan is named after ("DPD DE …",
 * "DPD-ROV-GERMANIA"). BRT copies that network's scans, often with their dates
 * alone; the network itself dates them.
 */
function dpdNetwork(place: string): string | undefined {
  const words = (/^DPD\b/.test(place) ? DEPOT.exec(place)?.[1] : undefined)?.split(/[^\p{L}]+/u).filter(Boolean) ?? [];
  const countries = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= words.length; end += 1) {
      const country = countryCode(words.slice(start, end).join(' '));
      if (country) countries.add(country);
    }
  }
  const [country] = countries;
  return countries.size === 1
    ? brandCarrierIds('DPD').find((id) => CARRIER_DEFINITIONS[id as CarrierId]?.countries?.[0] === country) : undefined;
}

/** A partner that brings parcels to BRT from abroad under BRT's own code. */
export type BrtOriginPartner = 'chronopost' | 'dpd';

/**
 * The partner that brought a shipment to BRT, named by the depot of its oldest
 * scan: Chronopost's import depots open with `CHR-` and the DPD network's with
 * `DPD`. A shipment that started at one of BRT's own depots has none.
 */
function brtOriginPartner(place: string): BrtOriginPartner | null {
  return /^CHR-/.test(place) ? 'chronopost' : /^DPD\b/.test(place) ? 'dpd' : null;
}

/**
 * A label's reading in a shipment. Where a partner brought the parcel from
 * abroad, BRT's collection is its hand-over from that partner, which had
 * already accepted and moved the parcel: in transit.
 */
function brtStatus(label: string, partner: BrtOriginPartner | null): ClassifiedStatus | undefined {
  const mapped = classifyBrtStatus(label);
  return mapped?.stage === 'accepted' && partner ? { status: 'in_transit', stage: 'in_transit' } : mapped;
}

/**
 * Projects one BRT detail page. A parcel ID's page does not repeat the ID, so
 * it is only read together with the shipment's parcel list naming that ID.
 */
export function parseBrt(html: string, raw: string, parcelList?: string): CarrierResult {
  return readBrt(html, raw, parcelList).result;
}

/** One BRT detail page with the partner that brought the shipment to BRT, if any. */
export function readBrt(html: string, raw: string, parcelList?: string): { result: CarrierResult; partner: BrtOriginPartner | null } {
  const number = normalizeBrtNumber(raw);
  const $ = load(html);
  const metadata = shipmentTables($);
  const history = scanTables($);
  if (!metadata.length && !history.length) throwPortalError($, number);
  if (metadata.length !== 1 || history.length > 1) throw new SchemaError('BRT', 'BRT returned ambiguous shipment details');
  const parcelId = isBrtParcelId(number);
  const identityLabel = number.length === 14 ? 'BRTcode' : 'N. spedizione';
  const identityRows = metadata.find('tr').filter((_, node) => rowLabel($, node) === identityLabel);
  const identity = identityRows.children('td');
  const shown = clean(identity.last().text(), 40);
  if (identityRows.length !== 1 || identity.length !== 2
    || (parcelId ? !/^\d{12}$/.test(shown) || parcelList === undefined || !brtParcelListNames(parcelList, number) : shown !== number)) {
    throw new SchemaError('BRT', 'BRT returned a different or incomplete shipment');
  }
  if (!history.length) throw new IndeterminateError('BRT', 'BRT returned no tracking scans');
  const rows = history.find('tr');
  if (rows.length > 501) throw new SchemaError('BRT', 'BRT returned too many tracking scans');
  const header = rows.first().children('td, th').map((_, node) => clean($(node).text(), 40)).get();
  if (header.join('|') !== 'Data|Ora|Filiale|Evento') throw new SchemaError('BRT', 'BRT tracking columns changed');
  const scans = rows.slice(1).toArray().map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError('BRT', 'BRT returned an incomplete scan');
    const label = clean(cells.eq(3).text(), 160);
    // The Italian page labels a missed delivery `Destin.Assente:LASCIATO AVVISO`.
    if (!label || !/^[\p{L}][\p{L}\p{N}\s().,:'/-]{1,159}$/u.test(label)) throw new SchemaError('BRT', 'BRT returned an invalid scan label');
    return { date: clean(cells.eq(0).text(), 40), clock: clean(cells.eq(1).text(), 24), location: clean(cells.eq(2).text(), 120), label };
  });
  if (!scans.length) throw new NoHistoryError('BRT', 'BRT lists the shipment without scans');
  // BRT names the depot that delivers a shipment in Italy. A shipment it hands
  // to a partner abroad names none, and of its depots naming no country only
  // the first, where the shipment started, is surely in Italy.
  const arrival = metadata.find('tr').filter((_, node) => rowLabel($, node) === 'Filiale di arrivo').children('td');
  const deliveredHome = arrival.length === 2 && clean(arrival.last().text(), 80) !== '';
  const origin = scans.at(-1)!.location;
  const broughtBy = brtOriginPartner(origin);
  const events = scans.map(({ date, clock, location, label }): CarrierEvent => {
    const mapped = brtStatus(label, broughtBy);
    const zones = clockZones(location, deliveredHome || location === origin);
    // A delivery reads as BRT's DELIVERED, or as its CONSEGNATA on the Italian page.
    const delivered = brtEnglishLabel(label) ? 'Consegnata' : 'Delivered';
    return { description: mapped?.status === 'delivered' ? delivered : label, provider_status: label,
      ...(mapped ? { stage: mapped.stage } : {}), ...(location && !isBrtCarrierDepot(location) ? { location } : {}),
      ...scanClock(date, clock, zones) };
  });
  // Source order also carries undated scans and clocks of several zones, so scans are never sorted.
  const latest = events[0]!;
  let mapped = brtStatus(String(latest.provider_status), broughtBy);
  // A shipment sent back reads DELIVERED once it reaches its sender again.
  if (mapped?.stage === 'delivered' && events.slice(1).some((event) => event.stage === 'returned')) {
    mapped = { status: 'exception', stage: 'returned' };
  }
  const goodsRows = metadata.find('tr').filter((_, node) => rowLabel($, node) === 'Natura merce');
  const weightText = goodsRows.length === 1 ? clean(goodsRows.children('td').last().text(), 300) : '';
  const weightLabels = weightText.match(/\bPeso \(kg\):/g) ?? [];
  const weightMatch = /\bPeso \(kg\):\s*(\d+(?:[,.]\d{1,4})?)(?=\s+Volume\b|$)/.exec(weightText);
  const weight = weightLabels.length === 1 && weightMatch ? Number(weightMatch[1]!.replace(',', '.')) : NaN;
  // A shipment of one parcel that BRT sent from Italy and DPD delivers abroad: the detail
  // names the parcel's DPD number. BRT's DPD import depots in Italy go by their province's letters.
  const parcels = [...weightText.matchAll(/\bColli:\s*(\d+)/g)];
  const dpdRow = metadata.find('tr').filter((_, node) => rowLabel($, node) === 'Parcel number dpd').children('td');
  const dpdNumber = dpdRow.length === 2 ? clean(dpdRow.last().text(), 40) : '';
  const partner = !deliveredHome && !/^DPD\b/.test(origin) && parcels.length === 1 && parcels[0]![1] === '1'
    && /^\d{14}$/.test(dpdNumber) ? dpdNetwork(scans[0]!.location) : undefined;
  return { result: { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    ...(mapped?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(Number.isFinite(weight) && weight > 0 && weight <= 100_000 ? { weight_kg: weight } : {}),
    ...(partner ? { delivery_carrier: partner, delivery_tracking_number: dpdNumber } : {}),
    events: events.slice(0, 100) }, partner: broughtBy };
}

// The fields of a result's current status.
const STATUS_FIELDS = ['status', 'current_stage', 'current_stage_source', 'last_status_text', 'last_update', 'last_update_local', 'delivered_at'] as const;

/**
 * The shipment with the leg its partner carried it on before BRT: the
 * partner's dated scans before BRT's first scan beyond the shipping data it was
 * sent, which may have come before them. A clock without an offset may be up
 * to 14 hours ahead of UTC, so a scan before one is dated more than 14 hours
 * before its reading as UTC. These scans and BRT's shipping data follow BRT's other
 * scans, in time order when all are dated. While BRT has only the shipping
 * data, the partner's newer scan gives the current status.
 */
export function withOriginLeg(result: CarrierResult, partner: CarrierResult): CarrierResult {
  const events = result.events ?? [];
  let handover = events.length - 1;
  while (handover >= 0 && events[handover]!.stage === 'registered') handover -= 1;
  const scan = events[handover];
  const before = !scan ? Infinity
    : scan.time ? Date.parse(scan.time)
      : typeof scan.local_time === 'string' ? Date.parse(`${scan.local_time}Z`) - 14 * 3_600_000 : NaN;
  const leg = (partner.events ?? []).filter((event) => event.time && Date.parse(event.time) < before);
  if (!leg.length) return result;
  const older = [...leg, ...events.slice(handover + 1)];
  if (older.every((event) => event.time)) older.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const merged: CarrierResult = { ...result, events: [...events.slice(0, handover + 1), ...older].slice(0, 100) };
  if (scan || older[0] !== partner.events![0]) return merged;
  for (const field of STATUS_FIELDS) delete merged[field];
  return { ...merged, ...Object.fromEntries(STATUS_FIELDS.flatMap((field) => partner[field] === undefined ? [] : [[field, partner[field]]])) };
}

// A place in Italy as the partners write it: Chronopost's "Town - IT (depot 82)", DPD's "Town, IT".
const ITALIAN_PLACE = /(?:^|, | - )(?:IT|Italy|Italia)(?: \(depot \d{1,6}\))?$/;

/**
 * A partner's answer for a BRTcode BRT has not processed yet, standing for
 * BRT's own when it shows the parcel bound for Italy, where the DPD group's
 * network is BRT: an Italian destination or a scan placed in Italy. Otherwise
 * null, and none of its scans are BRT's.
 */
export function partnerShipment(partner: CarrierResult): CarrierResult | null {
  const events = partner.events ?? [];
  if (!events.length || (partner.destination_country !== 'IT'
    && !events.some((event) => ITALIAN_PLACE.test(event.location ?? '')))) return null;
  return { ...Object.fromEntries(STATUS_FIELDS.flatMap((field) => partner[field] === undefined ? [] : [[field, partner[field]]])),
    destination_country: 'IT', events: events.slice(0, 100) };
}

/**
 * The DPD group's guest reply for a BRTcode it places in Italy, where the group's network is BRT:
 * each milestone once, staged as in DPD's leg. The hand-over is to BRT, as myBRT says.
 */
export function groupShipment(result: CarrierResult): CarrierResult {
  const staged = stagedDpdLeg(result);
  const handed = (text: string) => (text === API_LABELS.PARCEL_HANDED ? 'Parcel handed to BRT' : text);
  return { ...staged,
    ...(staged.last_status_text ? { last_status_text: handed(staged.last_status_text) } : {}),
    events: staged.events?.map((event) => (event.provider_code === 'PARCEL_HANDED' && event.description
      ? { ...event, description: handed(event.description) } : event)) };
}

/**
 * DPD's scans that its own map leaves without a stage (carriers/dpd): there an origin depot's
 * intake can follow an import's customs. In the leg that brought a parcel to BRT, all of it
 * before BRT's hand-over, the hand-over to DPD and its depot's intake are the acceptance, unless
 * DPD had already staged the parcel past it. The scans worded as moving it on are transit once
 * DPD has it; SPL, worded so, also comes before the origin depot, and stays unstaged there.
 */
export function stagedDpdLeg(result: CarrierResult): CarrierResult {
  if (!result.events?.length) return result;
  let taken = false;
  let moved = false;
  const events = [...result.events].reverse().map((event) => {
    const code = event.provider_code ?? '';
    const stage = event.stage
      ?? (DPD_INTAKE.has(code) ? (moved ? 'in_transit' : 'accepted') : DPD_TRANSIT.has(code) && taken ? 'in_transit' : undefined);
    if (stage && stage !== 'registered') taken = true;
    if (event.stage && event.stage !== 'registered' && event.stage !== 'accepted') moved = true;
    return stage === event.stage ? event : { ...event, stage };
  }).reverse();
  return { ...result, events };
}

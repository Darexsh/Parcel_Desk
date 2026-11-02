import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { comparable, tipsaStatus } from './status.js';

const PROVIDER = 'TIPSA';
const DETAIL_ORIGIN = 'https://dinapaqweb.tipsa-dinapaq.com';
const DETAIL_PATH = '/dinapaqweb/detalle_envio.php';
const SERVICE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const MAX_ROWS = 500;
export const TIPSA_ZONE = 'Europe/Madrid';
// A hub read names its hub: "LECTURA EN HUB BAILEN".
const HUB_READ = /^LECTURA EN HUB ([A-Z][A-Z .'-]{0,40})$/;
// TIPSA's central agency, whose town the Madrid hub's reads carry.
const CENTRAL_TOWN = 'SAN FERNANDO DE HENARES';
// A hub whose name in a read is not its town's whole name.
const HUB_TOWNS = new Map([['BARBERA', 'BARBERA DEL VALLES']]);

/**
 * A row's place: its POBLACIÓN, the town of the agency that recorded it. Reads
 * of hubs other than Madrid's, Bailén's and Barberà del Vallès's among them,
 * can carry the central agency's town, hundreds of kilometres from the hub;
 * such a read is placed at the hub its wording names.
 */
function rowPlace(description: string, place: string): string {
  const hub = HUB_READ.exec(comparable(description))?.[1];
  if (!hub || hub === 'MADRID' || comparable(place) !== CENTRAL_TOWN) return place;
  return HUB_TOWNS.get(hub) ?? hub;
}

/** The 22-digit reference: charge agency, origin agency and waybill, six, six and ten digits. */
export function normalizeTipsaNumber(raw: string): string {
  if (raw.length > 64) throw new InvalidInputError(PROVIDER, 'TIPSA tracking number is too long');
  const number = raw.replace(/[\s.-]/g, '');
  if (/^\d{22}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'TIPSA requires the full 22-digit reference');
}

/**
 * The shipment page a lookup redirects to. Only TIPSA's own detail page with
 * a service id and a `dd/MM/yy` date is followed.
 */
export function tipsaDetailUrl(location: string): string {
  let url: URL;
  try { url = new URL(location); } catch { throw new SchemaError(PROVIDER, 'TIPSA shipment page address is invalid'); }
  const keys = [...url.searchParams.keys()];
  if (url.origin !== DETAIL_ORIGIN || url.pathname.toLowerCase() !== DETAIL_PATH || url.username || url.password || url.hash
    || keys.length !== 2 || !keys.includes('servicio') || !keys.includes('fecha')
    || !SERVICE.test(url.searchParams.get('servicio')!) || !/^\d{2}\/\d{2}\/\d{2}$/.test(url.searchParams.get('fecha')!)) {
    throw new SchemaError(PROVIDER, 'TIPSA shipment page address changed');
  }
  return url.toString();
}

/**
 * Whether a lookup that did not redirect is TIPSA's answer for a reference it
 * cannot locate: a page that refreshes to its "envío no localizado" page.
 */
export function tipsaLookupNotFound(html: string): boolean {
  return /<meta\s+http-equiv=["']refresh["']\s+content=["']\s*\d+\s*;\s*URL=error_env\.html["']/i.test(html);
}

/**
 * The history table of TIPSA's shipment page, with the sender and weight of
 * its general data. Its clock is Madrid's for every agency, Portuguese ones
 * included. Recipient, reference, agency and proof of delivery blocks are
 * never read.
 */
export function parseTipsaDetail(html: string, raw: string): CarrierResult {
  const number = normalizeTipsaNumber(raw);
  if (/<title>\s*Just a moment|cf-chl-|challenge-platform|Attention Required! \| Cloudflare/i.test(html)) {
    throw new ChallengeError(PROVIDER, 'TIPSA returned a browser challenge');
  }
  const $ = load(html);
  const value = (selector: string) => clean($(selector).attr('value'), 32);
  const parts = value('#CodAgeCargo') + value('#CodAgeOri') + value('#Albaran');
  if (value('#envio-localizado') !== number || parts !== number) {
    throw new SchemaError(PROVIDER, 'TIPSA page does not identify the requested shipment');
  }
  const tables = $('table').filter((_, table) => $(table).find('thead th').map((__, th) => clean($(th).text(), 32)).get()
    .join('|') === 'FECHA/HORA|ESTADO|POBLACIÓN');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'TIPSA shipment history is missing');
  const rows = tables.find('tbody > tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TIPSA returned too many history rows');

  const events: (CarrierEvent & { time: string })[] = [];
  const seen = new Set<string>();
  rows.each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'TIPSA history row changed');
    // Each cell repeats its text in a tooltip span, which is skipped.
    const cellText = (index: number) => {
      const cell = cells.eq(index);
      const spans = cell.children('span').not('.mdl-tooltip');
      return clean((spans.length ? spans : cell).first().text(), 160);
    };
    const time = zonedTime(cellText(0), 'dd/MM/yy HH:mm', TIPSA_ZONE);
    const description = cellText(1);
    if (!time || !description) throw new SchemaError(PROVIDER, 'TIPSA history row has no time or status');
    const location = rowPlace(description, cellText(2));
    const key = JSON.stringify([time.iso, description, location]);
    if (seen.has(key)) return;
    seen.add(key);
    const stage = tipsaStatus(description)?.stage;
    events.push({ time: time.iso, description, ...(location ? { location } : {}), ...(stage ? { stage } : {}) });
  });
  if (!events.length) throw new IndeterminateError(PROVIDER, 'TIPSA shipment history is empty');
  // General data cells come in label and value pairs. A masked value (with
  // asterisks, as the page shows private names) is not kept.
  const general = (label: string) => {
    const cells = $('div.color-accent').filter((_, cell) => clean($(cell).text(), 40) === label);
    const text = cells.length === 1 ? clean(cells.first().next('div:not(.color-accent)').text(), 120) : '';
    return text.includes('*') ? '' : text;
  };
  const sender = general('Remitente');
  const kilos = general('Kilos');
  const weight = /^\d{1,6}(?:[.,]\d{1,3})?$/.test(kilos) ? Number(kilos.replace(',', '.')) : 0;
  // Newest first, as the page lists them; rows of one minute keep the page's order.
  events.sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
  const newest = events[0]!;
  const current = tipsaStatus(newest.description!);
  return {
    status: current?.status ?? 'unknown',
    ...(current ? { current_stage: current.stage } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: null,
    timezone: TIPSA_ZONE,
    ...(sender ? { sender_name: sender } : {}),
    ...(weight > 0 && weight <= 100_000 ? { weight_kg: weight } : {}),
    events,
  };
}

import { load, type CheerioAPI } from 'cheerio';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { courierCenterStage, courierCenterSummaryStage } from './status.js';

export const PROVIDER = 'Courier Center';
// A page is about 220 kB, most of it the site's own scripts.
export const COURIER_CENTER_MAX_BYTES = 1_500_000;
// Every station is in Greece or Cyprus, whose clocks agree all year.
const ZONE = 'Europe/Athens';
const WAYBILL = /^\d{12}$/;
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const SUMMARY = /^\((\d{1,4})\)\s*([A-Za-z]{2,40})$/;
// The notice for a number the tracker does not know, on its Greek and English pages.
const ABSENT = /^(?:Δεν βρέθηκε φορτωτική με τον αριθμό|No shipments found with identifier) (\S+)$/u;
// The notice over a list of the waybills one number matched.
const SEVERAL = /Βρέθηκαν \d+ φορτωτικές με αυτόν τον αριθμό|\d+ shipments with the same number were found/u;
// A firewall or bot check's page in place of the tracker, which can come with HTTP 200.
// Every page of the site loads Cloudflare's challenge-platform script, so that alone is no block.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|cf-turnstile|cf-error-details|Sorry, you have been blocked/i;
const MAX_ROWS = 300;

/** A Courier Center waybill, twelve digits; anything else is not one it issues. */
export function normalizeCourierCenterNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!WAYBILL.test(number)) throw new InvalidInputError(PROVIDER, 'Courier Center waybills are twelve digits');
  return number;
}

/** Whether a page is a firewall's or bot check's instead of the tracker's. */
export function isCourierCenterBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

// The site's prefix on some messages' wording.
const ENTRY = /^Msg_History_Entry_\d+\|/i;
// A message to the recipient: the masked phone it went to, then its subject.
const MESSAGE = /^ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ ΣΤΟ ΤΗΛΕΦΩΝΟ:\s*\[[^\]]*\]\s*ΜΕ ΘΕΜΑ:\s*\[([\s\S]*)\]$/u;
// The rest of a delivery's wording names who took the parcel, then the delivery's date and time.
const DELIVERY = /^((?:Η αποστολή )?παραδόθηκε στον παραλήπτη)(?:[\s:.,][\s\S]*)?$/iu;
// The notice number of a failed delivery, and all after it.
const NOTICE_NUMBER = /\s*,?\s*Αρ\.?\s*Ειδοποίησης\s*:[\s\S]*$/iu;
// A recipient's request to reroute names the point, then the charge and the amount.
const REROUTE = /^(ΑΙΤΗΜΑ ΑΝΑΔΡΟΜΟΛΟΓΗΣΗΣ ΑΠΟ ΠΑΡΑΛΗΠΤΗ ΣΕ CLEVER POINT:\s*\[[^\]]*\])[\s\S]*$/iu;
// Where a message went: a phone or an email address, and all after it.
const CONTACT = /\s*ΣΤΟ\s+(?:ΤΗΛΕΦΩΝΟ|EMAIL)\s*:[\s\S]*$/iu;
// A link a message carries, with the words that lead to it, and all after it.
const LINK = /\s*(?:με επιλογή σημείου μέσω|ΠΛΗΡΟΦΟΡΙΕΣ ΕΔΩ)?\s*https?:\/\/[\s\S]*$/iu;
// The masked phone a message went to, as "[*******12345]".
const MASKED = /\[\*+\d*\]/g;
// A Greek phone number: ten digits from 2 (fixed) or 6 (mobile), maybe after +30.
const PHONE = /(?<![\dA-Z])(?:\+?30)?[26]\d{9}(?![\dA-Z])/g;
const EMAIL = /\S+@\S+\.\S+/g;

/**
 * A scan's wording without what it says about the recipient. A message keeps
 * only its subject, without the masked phone it went to and the link it
 * carried; a delivery loses who took the parcel; a failed delivery loses its
 * notice number; a reroute request loses its charge; every line loses phone
 * numbers and email addresses.
 */
export function courierCenterWording(raw: string): string {
  let text = clean(raw, 1_000).replace(ENTRY, '');
  const message = MESSAGE.exec(text);
  if (message) text = message[1]!.replace(LINK, '');
  text = text.replace(DELIVERY, '$1').replace(NOTICE_NUMBER, '').replace(REROUTE, '$1').replace(CONTACT, '').replace(LINK, '');
  return clean(text.replace(MASKED, '').replace(EMAIL, '').replace(PHONE, '').replace(/\s+([,.:;)])/g, '$1'), 300)
    .replace(/^[\s,.:;(-]+|[\s,:;(-]+$/g, '');
}

/**
 * A scan's place: a branch or hub ("CC HUB ΑΘΗΝΑ") or, on ELTA's leg, an ELTA
 * office after its postcode, which is dropped. The web shop's booking and the
 * head office's system rows name no place the parcel is.
 */
function placeOf(area: string): string {
  const place = clean(area, 120).replace(/^\d{5}\s*-\s*/, '');
  return /^(?:WEB STATION|CC ΔΙΟΙΚΗΣΗ)$/iu.test(place) || !/\p{L}/u.test(place) ? '' : place;
}

/** A scan's clock: the station's wall clock to the minute, in Greece, as an instant. */
function clockOf(day: string, time: string): { iso: string; timestamp: number } {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  const pad = (value: string) => value.padStart(2, '0');
  const parsed = date && clock && Number(clock[1]) < 24
    ? isoTime(`${date[3]}-${pad(date[2]!)}-${pad(date[1]!)}T${pad(clock[1]!)}:${clock[2]}:00`, ZONE) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Courier Center returned an invalid scan time');
  return parsed;
}

interface Scan {
  readonly index: number;
  readonly timestamp: number;
  readonly event: CarrierEvent;
}

function scansOf($: CheerioAPI): Scan[] {
  const rows = $('.track-result .track-table > .tr').not('.header').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Courier Center returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const [index, row] of rows.entries()) {
    const cell = (name: string) => $(row).children(`.td.${name}`);
    if (cell('date').length !== 1 || cell('time').length !== 1 || cell('action').length !== 1) {
      throw new SchemaError(PROVIDER, 'Courier Center returned a scan without its fields');
    }
    const { iso, timestamp } = clockOf(clean(cell('date').text(), 20), clean(cell('time').text(), 10));
    const description = courierCenterWording(cell('action').text());
    if (!description) throw new SchemaError(PROVIDER, 'Courier Center returned a scan without wording');
    const location = placeOf(cell('area').first().text());
    const stage = courierCenterStage(description);
    const identity = JSON.stringify([iso, description, location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push({ index, timestamp, event: {
      time: iso,
      ...(location ? { location } : {}),
      description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } });
  }
  // Newest first, as the page lists them; scans of one minute keep the page's order.
  return scans.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
}

/**
 * The partner that took the parcel over and its number, which the page gives
 * after the waybill as "{waybill} / {number}": an ELTA item code, or a BOX
 * NOW parcel id when the scans name BOX NOW. Another number is not read.
 */
function partnerOf(number: string, events: readonly CarrierEvent[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (/^[A-Z]{2}\d{9}GR$/.test(number) && isValidS10TrackingNumber(number)) return { delivery_carrier: 'elta', delivery_tracking_number: number };
  if (/^\d{10}$/.test(number) && events.some((event) => /box now/i.test(event.description ?? ''))) {
    return { delivery_carrier: 'box-now', delivery_tracking_number: number };
  }
  return {};
}

/** The service, without the number the page puts before its name. */
function serviceOf($: CheerioAPI): string {
  return clean($('.track-header .info .service span').first().text(), 120).replace(/^\d+\s+/, '').slice(0, 80);
}

/**
 * Courier Center's result page for one number: the shipment's details, its
 * status and its scans, newest first, rendered on the server. A number the
 * tracker does not know gets its "no waybill" notice. The tracker also finds
 * a shipment by a partner's number or a reference, and then shows that
 * shipment's own waybill, so the waybill must be the number asked.
 */
export function parseCourierCenter(html: string, raw: string): CarrierResult {
  const number = normalizeCourierCenterNumber(raw);
  const $ = load(html);
  if ($('.track .track-header').length !== 1) {
    if (isCourierCenterBlockPage(html)) throw new ChallengeError(PROVIDER, 'Courier Center answered with a block page');
    throw new SchemaError(PROVIDER, 'Courier Center did not return its tracking page');
  }
  const error = $('.track-result h4.error');
  if (error.length) {
    const absent = ABSENT.exec(clean(error.nextAll('p').first().text(), 200));
    if (!absent) throw new IndeterminateError(PROVIDER, 'Courier Center did not complete the lookup');
    if (normalizeTrackingNumber(absent[1]!) !== number) throw new IndeterminateError(PROVIDER, 'Courier Center answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (SEVERAL.test(clean($('.track').text(), 200_000))) {
    throw new IndeterminateError(PROVIDER, 'Courier Center found several shipments under the number');
  }
  const ids = $('.track-header .info .id span');
  if (ids.length !== 1) throw new SchemaError(PROVIDER, 'Courier Center returned a shipment without its waybill');
  const [waybill = '', partner = ''] = clean(ids.text(), 120).split('/').map((part) => normalizeTrackingNumber(part.trim()));
  if (waybill !== number) throw new IndeterminateError(PROVIDER, 'Courier Center answered for another shipment');

  const summary = SUMMARY.exec(clean($('.track-header .info .status span').first().text(), 80));
  const summaryStage = summary ? courierCenterSummaryStage(summary[2]!) : undefined;
  const events = scansOf($).map((scan) => scan.event);
  const service = serviceOf($);
  if (!events.length) {
    if (!summary || !summaryStage) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(summaryStage.stage), current_stage: summaryStage.stage, current_stage_source: 'carrier_map',
      last_status_text: summary[2]!, provider_code: summary[1]!, last_update: null, expected_delivery: null,
      ...(service ? { service_name: service } : {}), summary_only: true, events: [],
    };
  }

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The summary settles a delivery, a return, a compensation or a parcel at a
  // Clever Point; otherwise the newest scan with a stage, else the summary.
  const stage = (summaryStage?.settles ? summaryStage.stage : scanned?.stage ?? summaryStage?.stage) as Stage | undefined;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time! } : {}),
    ...(service ? { service_name: service } : {}),
    ...(partner ? partnerOf(partner, events) : {}),
    events,
  };
}

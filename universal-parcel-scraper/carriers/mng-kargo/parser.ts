import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { mngKargoStage } from './status.js';

export const PROVIDER = 'DHL eCommerce Türkiye';

// The tracker asks for the twelve-digit shipment number; returns get one too.
const NUMBER = /^\d{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{40,400}$/;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
// The F5 web application firewall in front of the site, and its JavaScript bot defence.
const BLOCK = /<title>\s*Request Rejected\s*<\/title>|The requested URL was rejected|\/TSPD\/|\bbobcmn\b/i;
// "Teslimat Şube : DİKMEN", the delivering branch of a scan.
const BRANCH_FIELD = /^Teslimat Şube\s*:\s*(.+)$/u;
// What follows a branch name in bold where the scan happened there: "<b>X</b> şubemize ulaşmıştır",
// "<b>X</b> şubesinde ... hazırlanmaktadır". A branch the parcel will leave from or is sent to is no scan place.
const BRANCH_HERE = /^\s*şube(?:mize ulaşmıştır|sinde\s)/u;
// What may follow any bold name in a reason the adapter keeps: a branch or unit of the carrier.
const BRANCH_AFTER = /^\s*(?:şube|birim)/u;
const BRANCH_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .()'/&-]{0,79}$/u;
const PHONE = /\d{3}\s?\d{3}\s?\d{2}\s?\d{2}/;
// Labels whose sentence gives the reason a delivery did not happen. The sentence of any
// other label is the page's own explanation, or names whoever received the parcel.
const REASONED = new Set(['Teslim Edilemedi', 'Teslimat Denemesi Başarısız', 'Teslimat Denemesi Planlandı']);
const TEXT = 3;
const COMMENT = 8;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

type Selection = ReturnType<CheerioAPI>;

/** A twelve-digit DHL eCommerce Türkiye shipment number, as its tracker takes it. */
export function normalizeMngKargoNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DHL eCommerce Türkiye tracks twelve-digit shipment numbers');
  return number;
}

/** A firewall page in place of the site's own. */
export function assertNotBlocked(html: string): void {
  if (BLOCK.test(html.slice(0, 20_000))) throw new ChallengeError(PROVIDER, 'DHL eCommerce Türkiye rejected the request at its firewall');
}

/** The anti-forgery token of the tracking form, which the lookup posts back with its cookie. */
export function parseMngKargoForm(html: string): string {
  assertNotBlocked(html);
  const $ = load(html);
  const forms = $('form#shipmentFormStandard[action="/gonderi-takip"]');
  if (forms.length !== 1) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Türkiye did not return its tracking form');
  const tokens = forms.find('input[name="__RequestVerificationToken"]');
  const token = tokens.length === 1 ? tokens.attr('value') ?? '' : '';
  if (!TOKEN.test(token)) throw new SchemaError(PROVIDER, 'DHL eCommerce Türkiye tracking form changed');
  return token;
}

/** The page's date ("08.10.2026"), a calendar day without a time. */
function dayOf(text: string): string | undefined {
  const match = DAY.exec(text);
  return (match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]))) || undefined;
}

function branchName(text: string): string {
  const name = clean(text, 80);
  return BRANCH_NAME.test(name) ? name : '';
}

/** Each child node of an element with the text right after it, up to the next element. */
function childNodes($: CheerioAPI, element: Selection) {
  const nodes = element.contents().toArray();
  return nodes.map((node, index) => {
    const next = nodes[index + 1];
    return { node, after: next && next.nodeType === TEXT ? $(next).text() : '' };
  });
}

/** The branch a scan happened at: the delivering branch field, else the branch the sentence places it in. */
function scanBranch($: CheerioAPI, fields: Selection, sentence: Selection): string {
  for (const field of fields.toArray()) {
    const match = BRANCH_FIELD.exec(clean($(field).text(), 120));
    if (match) return branchName(match[1]!);
  }
  for (const { node, after } of childNodes($, sentence)) {
    if ($(node).is('b') && BRANCH_HERE.test(after)) return branchName($(node).text());
  }
  return '';
}

/**
 * The reason in a failed delivery's sentence ("Devir", or why the courier could not deliver),
 * or '' when it holds anything but text and the names of the carrier's branches.
 */
function reasonOf($: CheerioAPI, sentence: Selection): string {
  let text = '';
  for (const { node, after } of childNodes($, sentence)) {
    if (node.nodeType === TEXT) text += $(node).text();
    else if ($(node).is('b') && BRANCH_AFTER.test(after)) text += $(node).text();
    else if ($(node).is('br')) text += ' ';
    else if (node.nodeType !== COMMENT) return '';
  }
  const reason = clean(text, 300);
  return reason && !/Teslim Alan/iu.test(reason) && !PHONE.test(reason) ? reason : '';
}

/** The page's field with this title in each of its two layouts, desktop and mobile. */
function fieldValues($: CheerioAPI, title: string): string[] {
  return $('.cargoTrackingPost .listBox .textBox').filter((_, node) => clean($(node).children('.title').first().text(), 80) === title)
    .toArray().map(node => clean($(node).children('.desc').first().text(), 80));
}

/**
 * The tracker's page for one shipment, bound to the number it shows. The scans
 * carry a date, a status label and a sentence. Recipient, sender and branch
 * contact details on the page are never read.
 */
export function parseMngKargo(html: string, raw: string): CarrierResult {
  const number = normalizeMngKargoNumber(raw);
  assertNotBlocked(html);
  const $ = load(html);
  const panels = $('section.contentDetail .cargoTrackingPost');
  if (!panels.length) {
    throw new IndeterminateError(PROVIDER, $('form#shipmentFormStandard').length
      ? 'DHL eCommerce Türkiye returned its form instead of the shipment' : 'DHL eCommerce Türkiye did not return a shipment');
  }
  if (panels.length !== 1) throw new SchemaError(PROVIDER, 'DHL eCommerce Türkiye repeated the shipment panel');
  // The labels are mapped in Turkish, the page's only language.
  if (!/^tr(?:-|$)/i.test($('html').attr('lang') ?? '')) throw new SchemaError(PROVIDER, 'DHL eCommerce Türkiye tracking page changed language');
  const shown = fieldValues($, 'Gönderi Numarası');
  if (!shown.length || shown.some(value => normalizeTrackingNumber(value) !== number)) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce Türkiye returned a different shipment');
  }
  const histories = panels.find('.trackBox .rightBox');
  if (!histories.length) throw new NoHistoryError(PROVIDER);
  // A shipment of several parcels may list one history each; which parcel a scan belongs to is not read.
  if (histories.length > 1) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Türkiye listed several parcel histories', { reason: 'several_parcels' });
  const rows = histories.children('ul').children('li');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DHL eCommerce Türkiye returned too many scans');

  const scans: { event: CarrierEvent; day: string; index: number }[] = [];
  const seen = new Set<string>();
  rows.each((index, row) => {
    const node = $(row);
    const label = clean(node.children('.left').children('.title').first().text(), 120);
    if (!label) throw new SchemaError(PROVIDER, 'DHL eCommerce Türkiye returned a scan without a status');
    const detail = node.children('.right');
    const sentence = detail.children('.title').first();
    // Every scan carries its day; one without means the page changed.
    const day = dayOf(clean(detail.children('.dateBox').first().text(), 32));
    if (!day) throw new SchemaError(PROVIDER, 'DHL eCommerce Türkiye returned a scan without a date');
    const location = scanBranch($, detail.children('.desc'), sentence);
    const reason = REASONED.has(label) ? reasonOf($, sentence) : '';
    const description = reason ? `${label}: ${reason}` : label;
    const identity = `${day}\u0000${description}\u0000${location}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const stage = mngKargoStage(description);
    scans.push({ event: { description, local_time: day, ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) }, day, index });
  });
  // Newest first, as the page lists them; scans of one day keep the page's order.
  scans.sort((left, right) => right.day > left.day ? 1 : right.day < left.day ? -1 : left.index - right.index);
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  const status = stage ? languageStageStatus(stage) : 'unknown';

  // The estimate is a calendar day; it stops counting once the parcel is delivered, back or stuck.
  const [estimateText] = fieldValues($, 'Tahmini Teslimat Tarihi');
  const estimate = dayOf(estimateText ?? '');
  const newestDay = scans[0]!.day;
  const active = ['pending', 'in_transit', 'out_for_delivery'].includes(status);

  return {
    status,
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newestDay,
    expected_delivery: active && estimate && estimate >= newestDay ? estimate : null,
    events: events.slice(0, MAX_EVENTS),
  };
}

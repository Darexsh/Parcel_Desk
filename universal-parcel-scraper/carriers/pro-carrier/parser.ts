import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { proCarrierStage } from './status.js';

export const PROVIDER = 'Pro Carrier';
// A parcel's page is about 30 kB, most of it the page's own markup.
export const PRO_CARRIER_MAX_BYTES = 1024 * 1024;
const PAGE = 'https://tracking.weareprocarrier.com/';
// Pro Carrier's own numbers: DG and eleven digits from the DG years, UBG and nine digits on a recent parcel.
const NUMBER = /^(?:DG\d{11}|UBG\d{9})$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile/i;
// The page's notice for a number the tracker has no shipment for, which echoes the number.
const NOT_FOUND = /^Shipment not found \(([^()]{1,64})\)$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const WEIGHT = /^(\d{1,4}(?:\.\d{1,3})?)\s*kg$/i;
// A partner's number in the Carrier Tracking Number field.
const PARTNER_NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
// The buttons to the partner's own tracker: "Track your delivery on partner site", "See tracking on delivery partner site".
const PARTNER_BUTTON = /\bpartner site\b/i;
const MAX_ROWS = 300;

/** A Pro Carrier number in capitals; anything else is not one it issues. */
export function normalizeProCarrierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Pro Carrier numbers are DG and eleven digits, or UBG and nine digits');
  return number;
}

/** The tracker's page for one number. */
export function proCarrierTrackingUrl(raw: string): string {
  return `${PAGE}?${new URLSearchParams({ tn: normalizeProCarrierNumber(raw) })}`;
}

/** The Shipment Details list, by its labels in lower case. */
function fields($: CheerioAPI, details: Cheerio<AnyNode>): Map<string, string> {
  const values = new Map<string, string>();
  details.find('.shipment-details__details-container dl.detail-list').each((_, list) => {
    const label = clean($(list).children('dt').text(), 60).toLowerCase();
    if (label && !values.has(label)) values.set(label, clean($(list).children('dd').text(), 200));
  });
  return values;
}

/** A scan's wall clock to the second. The page names no zone, so it stays local. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Pro Carrier returned an invalid scan time');
  }
  return local;
}

/**
 * The Shipment History list, newest first: each row has a clock and the
 * tracker's event name, then the comments below it, which are not read.
 */
function scans($: CheerioAPI, details: Cheerio<AnyNode>): CarrierEvent[] {
  const lists = details.find('ul.accordion--shipping');
  if (lists.length !== 1) throw new SchemaError(PROVIDER, 'Pro Carrier returned a shipment without its history');
  const rows = lists.children('li.accordion-item').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pro Carrier returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const title = $(row).children('a.accordion-title').children('dl.detail-list');
    if (title.length !== 1) throw new SchemaError(PROVIDER, 'Pro Carrier returned an invalid scan');
    const local = wallClock(clean(title.children('dt').text(), 40));
    const description = clean(title.children('dd').text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Pro Carrier returned a scan without wording');
    const key = JSON.stringify([local, description.toLowerCase()]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = proCarrierStage(description);
    events.push({ local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  return events;
}

/**
 * The carrier whose tracker the partner buttons open. Only the link's host and
 * path name it: its query can hold the recipient's postcode, as Colis Privé's does.
 */
function partnerCarrier($: CheerioAPI): string | undefined {
  const links = new Set($('a.button[href]').toArray()
    .filter((link) => PARTNER_BUTTON.test(clean($(link).text(), 120))).map((link) => clean($(link).attr('href'), 2000)));
  if (links.size !== 1) return undefined;
  let url: URL;
  try { url = new URL([...links][0]!); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  // InPost's UK tracker is not among InPost's tracking links, which are Polish.
  const host = url.hostname.toLowerCase();
  if (host === 'inpost.co.uk' || host.endsWith('.inpost.co.uk')) return 'inpost';
  const carrier = carrierIdFromPartner('', `${url.origin}${url.pathname}`);
  return carrier === 'pro-carrier' ? undefined : carrier;
}

/**
 * Pro Carrier's tracker, `tracking.weareprocarrier.com/?tn={number}`, for one
 * number. A shipment's page echoes the number in its details and lists its
 * scans; an unknown number gets the page's search form and an error notice that
 * repeats the number.
 */
export function parseProCarrier(html: string, raw: string): CarrierResult {
  const number = normalizeProCarrierNumber(raw);
  const $ = load(html);
  if (!$('form.track-shipment-form input[name="tn"]').length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pro Carrier answered with a browser check');
    throw new SchemaError(PROVIDER, 'Pro Carrier did not return its tracking page');
  }
  const details = $('section.shipment-details');
  if (!details.length) {
    const notices = $('.callout.alert');
    const notice = clean(notices.children('p').text(), 200);
    const missing = NOT_FOUND.exec(notice);
    if (notices.length === 1 && missing) {
      if (returnedTrackingNumber(missing[1]).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Pro Carrier answered for another number');
      throw new NotFoundError(PROVIDER);
    }
    if (notice) throw new IndeterminateError(PROVIDER, 'Pro Carrier answered with another notice');
    throw new SchemaError(PROVIDER, 'Pro Carrier returned a page without a shipment');
  }
  if (details.length > 1) throw new SchemaError(PROVIDER, 'Pro Carrier returned several shipments');

  const values = fields($, details);
  const echoed = values.get('tracking number');
  if (!echoed) throw new SchemaError(PROVIDER, 'Pro Carrier returned a shipment without its number');
  if (returnedTrackingNumber(echoed).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Pro Carrier answered for another number');

  const events = scans($, details);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // The partner that moves or delivers the parcel, under its own number.
  const partner = partnerCarrier($);
  const reference = returnedTrackingNumber(values.get('carrier tracking number') ?? '').toUpperCase();
  // Colis Privé's number opens its tracker only with the recipient's postcode, which a longer value may carry.
  const handoff = reference !== number && PARTNER_NUMBER.test(reference)
    && (partner !== 'colis-prive' || reference.length === 12) ? reference : '';
  const service = values.get('service') ?? '';
  const weight = Number(WEIGHT.exec(values.get('weight') ?? '')?.[1]);
  // "Town, FR": only the country is kept.
  const country = countryCode((values.get('destination') ?? '').split(',').at(-1));

  // Clocks come from several countries and keep no zone, so the page's order stands.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(service && service !== '-' ? { service_name: service } : {}),
    ...(weight > 0 ? { weight_kg: weight } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(handoff ? { ...(partner ? { delivery_carrier: partner } : {}), delivery_tracking_number: handoff } : {}),
    events,
  };
}

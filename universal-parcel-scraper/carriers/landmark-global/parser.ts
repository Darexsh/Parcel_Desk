import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type ClassifiedStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { landmarkStatus } from './status.js';

const ABSENT = "We couldn't find a match for this value. Please try a different value.";

const LTN = /^LTN\d{8,9}(?:N1)?$/;
/**
 * A merchant's or shipper's own reference, which the page also finds. The page searches every
 * merchant, so a short value could be another merchant's order reference. One starting LTN
 * must be a whole LTN.
 */
const MERCHANT_REFERENCE = /^(?!LTN)(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;

export function normalizeLandmarkNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!LTN.test(number) && !MERCHANT_REFERENCE.test(number)) throw new InvalidInputError('Landmark Global', 'Landmark requires an LTN parcel reference or a merchant reference');
  return number;
}

/** The page writes every scan's clock in US Central time and names its offset beside it. */
const CENTRAL_OFFSETS: Readonly<Record<string, string>> = { CDT: '-05:00', CST: '-06:00' };

function clock(raw: string, shown: string): Pick<CarrierEvent, 'time'> & { local_time?: string; provider_time_text?: string } {
  const validated = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(raw)
    ? DateTime.fromFormat(raw, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }) : null;
  if (!validated?.isValid) return raw ? { provider_time_text: raw } : {};
  const wall = validated.toISO({ includeOffset: false, suppressMilliseconds: true });
  const offset = CENTRAL_OFFSETS[/ (C[DS]T)$/.exec(shown)?.[1] ?? ''];
  // The named offset must be Chicago's at that clock, which also settles the hour repeated in autumn.
  if (offset && DateTime.fromISO(`${wall}${offset}`).setZone('America/Chicago').toISO({ includeOffset: false, suppressMilliseconds: true }) === wall) return { time: `${wall}${offset}` };
  return { local_time: wall };
}

export function parseLandmark(html: string, rawNumber: string): CarrierResult {
  const number = normalizeLandmarkNumber(rawNumber);
  const merchant = !LTN.test(number);
  const $ = load(html);
  if (/just a moment|verify.*human|captcha/i.test($('title').text()) || $('.g-recaptcha,.h-captcha').length) throw new ChallengeError('Landmark Global');
  $('script,style,noscript').remove();
  const identities = $('.delivery-details-col h6').filter((_, node) => clean($(node).text()) === 'Landmark Tracking Number');
  const tables = $('.event-summary .event-table table');
  const errors = $('.error-text').map((_, node) => clean($(node).text())).get().filter(Boolean);
  if (!identities.length && !tables.length && $('#search').length === 1 && $('#search').val() === number
    && errors.length && errors.every(error => error === ABSENT) && $('title').text().trim() === 'Landmark Global | Landmark Tracking') {
    // A reference arrives without the spaces, dots and hyphens the user may have written, and the
    // page found no parcel by an order reference holding a hyphen, as printed or without it.
    if (merchant) throw new IndeterminateError('Landmark Global', 'Landmark found no parcel for this reference, but its search misses references written with punctuation', { reason: 'portal_not_found' });
    throw new NotFoundError('Landmark Global');
  }
  const canonical = identities.length === 1 ? clean(identities.next('div').text(), 64) : '';
  // The partner's page link carries its number, or a form field does.
  const partner = $('.delivery-details-col h6').filter((_, node) => clean($(node).text()) === 'Delivery Partner').next('div');
  const links = partner.find('a.track');
  const inputs = partner.find('input[name="id"]');
  const partnerNumber = partner.length !== 1 ? '' : clean(links.length === 1 ? links.text() : inputs.length === 1 ? inputs.val() : '', 64).toUpperCase();
  // A merchant reference must be the parcel's order or package reference, or its delivery
  // partner's number; its LTN then names the parcel.
  const references = $('.shipment-details-col h6').filter((_, node) => ['Order Reference', 'Package Reference'].includes(clean($(node).text())))
    .map((_, node) => returnedTrackingNumber($(node).next('div').text())).get();
  if (identities.length !== 1 || (merchant ? !/^LTN\d{8,9}$/.test(canonical) || !(references.includes(number) || partnerNumber === number)
    : canonical !== number.replace(/N1$/, ''))) throw new SchemaError('Landmark Global', 'Landmark returned a different or ambiguous parcel');
  if (tables.length !== 1 || tables.find('thead th').map((_, node) => clean($(node).text())).get().join('|') !== 'Description|Date/Time|Location') throw new SchemaError('Landmark Global');
  const rows = tables.find('tbody > tr');
  if (!rows.length) throw new IndeterminateError('Landmark Global', 'Landmark returned no parcel history');
  if (rows.length > 500) throw new SchemaError('Landmark Global', 'Landmark returned excessive parcel history');
  const firstCells = rows.first().children('td');
  const summary = $('.current-status');
  // Before a scan has a wording, and after a return, the summary shows no scan wording: only
  // the stage, or a link to the return's own tracking.
  const heading = summary.find('h3');
  const headline = heading.find('a').length ? '' : clean(heading.text());
  if (summary.length !== 1 || (headline && headline !== clean(firstCells.eq(0).text()))
    || summary.find('.time').attr('data-time') !== firstCells.eq(1).attr('data-time')) throw new IndeterminateError('Landmark Global', 'Landmark latest summary does not match its first scan');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 3 || cells.filter('[colspan]').length) throw new SchemaError('Landmark Global');
    const wording = clean(cells.eq(0).text(), 500);
    if (!wording) throw new SchemaError('Landmark Global', 'Landmark returned an empty scan');
    const mapped = landmarkStatus(wording);
    const event: CarrierEvent = { ...clock(clean(cells.eq(1).attr('data-time') ?? cells.eq(1).text(), 64), clean(cells.eq(1).text(), 64)),
      description: mapped?.stage === 'delivered' ? 'Delivered' : wording, location: clean(cells.eq(2).text(), 200),
      ...(mapped ? { stage: mapped.stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!;
  // A parcel sent back travels under a new reference; its own history stops before that.
  const returned = heading.find('a').length > 0 && clean(summary.find('h2').text()) === 'Returned';
  const current = returned ? { status: 'exception' as const, stage: 'returned' as const } : currentStatus(clean(firstCells.eq(0).text(), 500));
  const partnerName = clean(partner.clone().find('form').remove().end().text(), 100);
  const partnerCarrier = carrierIdFromPartner(partnerName, clean(partner.find('form').attr('action'), 500));
  // Only the country of the ship-to place is read; the town is the recipient's.
  const shipTo = clean($('.shipping-details h6').filter((_, node) => clean($(node).text()) === 'Shipping To').first().next('p').text(), 200);
  const destination = /,\s*([A-Z]{2})$/.exec(shipTo)?.[1];
  return { status: current.status, ...(current.stage ? { current_stage: current.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null, expected_delivery: null,
    ...(number !== canonical ? { canonical_tracking_number: canonical } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(/^[A-Z0-9]{4,40}$/.test(partnerNumber) && partnerNumber !== number && partnerNumber !== canonical ? { delivery_tracking_number: partnerNumber,
      ...(partnerCarrier && partnerCarrier !== 'landmark-global' ? { delivery_carrier: partnerCarrier } : {}) } : {}), events: events.slice(0, 100) };
}

/** The newest scan's stage: Landmark's own wording first, then the shared wording rules that
 * stage the scan itself. Partners' wording reaches the page as they wrote it. */
function currentStatus(wording: string): { status: ClassifiedStatus['status']; stage?: ClassifiedStatus['stage'] } {
  const mapped = landmarkStatus(wording);
  if (mapped) return mapped;
  const classified = classifyWording(wording);
  return classified.source === 'none' ? { status: 'unknown' } : { status: languageStageStatus(classified.stage), stage: classified.stage };
}

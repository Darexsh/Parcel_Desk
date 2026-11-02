import { load } from 'cheerio';
import { DateTime, IANAZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { citiStage } from './status.js';

export const PROVIDER = 'Citilogistics';
export const CITI_PAGE = 'https://tracking.citilogistics.ca/';
export const CITI_MAX_BYTES = 1_000_000;
const BLOCKED = /_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

export function normalizeCitiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  // A delivery partner's number needs a verified relationship, not an echoed query.
  if (/^\d{16}$/.test(number)) throw new IndeterminateError(PROVIDER, 'Citilogistics has no verified native partner-number lookup');
  if (!/^(?:\d{11}|CAM\d{9})$/.test(number)) throw new InvalidInputError(PROVIDER, 'Citilogistics needs its own consignment code');
  return number;
}

/** Validate the guest form before submitting its current state. */
export function citiForm(html: string): { nonce: string; number: string } {
  if (new TextEncoder().encode(html).byteLength > CITI_MAX_BYTES) throw new SchemaError(PROVIDER, 'Citilogistics returned an oversized tracking page');
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Citilogistics answered with browser verification');
  const $ = load(html), forms = $('form.track-submit');
  if (forms.length !== 1 || forms.attr('method')?.toLowerCase() !== 'get') throw new SchemaError(PROVIDER, 'Citilogistics returned no unique guest form');
  let action: URL;
  try { action = new URL(forms.attr('action') ?? '', CITI_PAGE); } catch { throw new SchemaError(PROVIDER, 'Citilogistics returned an invalid form target'); }
  if (action.href !== CITI_PAGE) throw new SchemaError(PROVIDER, 'Citilogistics changed its guest form target');
  const fields = forms.find('input[name="n"]'), tracking = forms.find('input[name="trackid"]');
  const nonce = fields.attr('value') ?? '';
  if (fields.length !== 1 || fields.attr('type')?.toLowerCase() !== 'hidden' || tracking.length !== 1 || !/^[a-f0-9]{32}$/i.test(nonce)) throw new SchemaError(PROVIDER, 'Citilogistics returned invalid guest form state');
  return { nonce, number: tracking.attr('value') ?? '' };
}

function clock(day: string, time: string, zone: string): { local: string; instant: string; timestamp: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
    || zone.length > 80 || !/^(?:[A-Za-z_]+\/[A-Za-z0-9_+/-]+|UTC)$/.test(zone) || !IANAZone.isValidZone(zone)) {
    throw new SchemaError(PROVIDER, 'Citilogistics returned an invalid stated scan clock');
  }
  const value = day + ' ' + time;
  const at = firstOccurrence(DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm', { zone }));
  if (!at.isValid || at.year < 1000 || at.toFormat('yyyy-MM-dd HH:mm') !== value) throw new SchemaError(PROVIDER, 'Citilogistics returned an invalid scan calendar');
  return { local: day + 'T' + time + ':00', instant: at.toISO({ suppressMilliseconds: true }), timestamp: at.toMillis() };
}

/** The single-code guest lookup; the result form must echo the whole code. */
export function parseCiti(html: string, raw: string): CarrierResult {
  const number = normalizeCitiNumber(raw), form = citiForm(html), $ = load(html);
  if (normalizeTrackingNumber(form.number) !== number) throw new IndeterminateError(PROVIDER, 'Citilogistics answered another tracking query');
  const tables = $('table.table.table-hover'), alerts = $('.alert');
  if (alerts.length) {
    if (alerts.length !== 1 || tables.length || !alerts.hasClass('alert-danger')) throw new SchemaError(PROVIDER, 'Citilogistics returned conflicting lookup results');
    const notice = alerts.clone(); notice.find('button').remove();
    if (clean(notice.text()) === 'Invalid tracking number or No tracking info available.') throw new NoHistoryError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Citilogistics did not complete the tracking lookup');
  }
  if (!tables.length) throw new IndeterminateError(PROVIDER, 'Citilogistics returned no tracking result');
  if (tables.length !== 1) throw new IndeterminateError(PROVIDER, 'Citilogistics returned several histories');
  if (tables.find('thead th').toArray().map(node => clean($(node).text())).join('|') !== 'Event Date|Time|Location|Description|Time Zone') {
    throw new SchemaError(PROVIDER, 'Citilogistics changed its history columns');
  }
  const rows = tables.children('tbody').children('tr');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Citilogistics returned excessive history');
  const scans: { event: CarrierEvent; timestamp: number }[] = [], seen = new Set<string>();
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 5 || cells.toArray().some(cell => $(cell).text().length > 2000)) throw new SchemaError(PROVIDER, 'Citilogistics returned an invalid scan row');
    const day = cells.eq(0).text().trim(), time = cells.eq(1).text().trim(), zone = cells.eq(4).text().trim();
    const at = clock(day, time, zone), description = clean(cells.eq(3).text(), 500), location = clean(cells.eq(2).text(), 160);
    if (!description) throw new SchemaError(PROVIDER, 'Citilogistics returned an unnamed scan');
    const key = JSON.stringify([at.timestamp, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const mapped = citiStage(description);
    scans.push({ timestamp: at.timestamp, event: { time: at.instant, local_time: at.local, time_zone: zone, time_zone_basis: 'carrier',
      description, ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage, stage_source: mapped.source } : {}) } });
  }
  scans.sort((a, b) => b.timestamp - a.timestamp);
  const events = scans.map(scan => scan.event), stage = events.find(event => event.stage)?.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description!, last_update: events[0]!.time!, expected_delivery: null, events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { trendyolStage } from './status.js';

export const PROVIDER = 'Trendyol Express';
export const TRENDYOL_MAX_BYTES = 1_000_000;
const CHALLENGE = /_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

export function normalizeTrendyolNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{16}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Trendyol Express shipment numbers have sixteen digits');
  return number;
}

export function trendyolTrackingUrl(number: string): string {
  return `https://kargotakip.trendyol.com/?${new URLSearchParams({ orderNumber: normalizeTrendyolNumber(number) })}`;
}

function clock(text: string): string {
  if (!/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(text)) throw new SchemaError(PROVIDER, 'Trendyol Express returned an invalid scan clock');
  const date = DateTime.fromFormat(text, 'dd.MM.yyyy HH:mm', { zone: 'UTC' });
  // UTC validates the calendar digits only; the carrier supplies no offset.
  if (!date.isValid || date.toFormat('dd.MM.yyyy HH:mm') !== text) throw new SchemaError(PROVIDER, 'Trendyol Express returned an invalid scan day');
  return date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The entire timeline is in the DOM even when its expand control hides it. */
export function parseTrendyol(html: string, raw: string): CarrierResult {
  const number = normalizeTrendyolNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Trendyol Express answered with a browser check');
  const $ = load(html);
  if ($('#root > .preloader').length) throw new IndeterminateError(PROVIDER, 'Trendyol Express has not finished loading its result');
  const missing = $('section.not-found-wrapper');
  if (missing.length) {
    const quoted = missing.find('p b');
    if (missing.length !== 1 || quoted.length !== 1 || quoted.text().trim() !== number) {
      throw new IndeterminateError(PROVIDER, 'Trendyol Express did not identify the missing shipment');
    }
    if (!/Sonuç Bulunamadı/.test(missing.find('h1').text()) || $('[id=history-list-item]').length) {
      throw new SchemaError(PROVIDER, 'Trendyol Express returned conflicting tracking results');
    }
    throw new NotFoundError(PROVIDER);
  }
  // Despite the URL parameter's name, the shipment is the page's delivery number.
  // Its order number is the marketplace reference and cannot confirm this lookup.
  const own = $('[id=delivery-number-list-item-value]');
  if (own.length !== 1) throw new SchemaError(PROVIDER, 'Trendyol Express returned no unique shipment number');
  if (own.text().trim() !== number) throw new IndeterminateError(PROVIDER, 'Trendyol Express answered for another shipment');
  const rows = $('[id=history-list-item]');
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Trendyol Express returned too many scans');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows.toArray()) {
    const status = $(row).children('[id=history-list-item-status]');
    const stamp = status.children('time');
    if (status.length !== 1 || stamp.length !== 1) throw new SchemaError(PROVIDER, 'Trendyol Express changed its scan layout');
    const local = clock(clean(stamp.text(), 40));
    const label = status.clone();
    label.children('time').remove();
    const description = clean(label.text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Trendyol Express returned an unnamed scan');
    const location = clean($(row).children('[id=history-list-item-city]').text(), 160);
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = trendyolStage(description);
    events.push({ local_time: local, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The page lists newest first; the progress rail also contains future steps.
  const staged = events.find(event => event.stage);
  const stage = staged ? trendyolStage(staged.description!) : null;
  return {
    status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: clean($('#delivery-state').text(), 200) || events[0]!.description!,
    last_update: null, last_update_local: events[0]!.local_time!, expected_delivery: null,
    timezone: 'Europe/Istanbul', events,
  };
}

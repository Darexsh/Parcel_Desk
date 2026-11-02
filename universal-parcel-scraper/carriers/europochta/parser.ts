import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { europochtaStage, europochtaWording } from './status.js';

export const PROVIDER = 'Europochta';
export const EUROPOCHTA_MAX_BYTES = 512 * 1024;
const CHALLENGE = /_cf_chl_opt|cf-error-details|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|enable JavaScript and cookies|checking your browser/i;

export function normalizeEuropochtaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^BY08\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Europochta numbers start with BY08 followed by ten digits');
  return number;
}

/** JSON is served with a text/html content type by the public tracker. */
export function europochtaJson(body: string): unknown {
  if (!body.trim()) throw new IndeterminateError(PROVIDER, 'Europochta returned an empty reply');
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Europochta answered with a browser check');
    throw new SchemaError(PROVIDER, 'Europochta returned a reply that is not JSON');
  }
}

function clock(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new SchemaError(PROVIDER, 'Europochta returned an invalid scan clock');
  }
  const local = value.replace(' ', 'T');
  const date = DateTime.fromISO(local, { zone: 'UTC' });
  if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Europochta returned an invalid scan day');
  return local;
}

/**
 * A single-number GET returns the same rows the official page renders. It
 * has no identity envelope: the exact request binds the rows, while any
 * number quoted in a notification must agree with the requested number.
 */
export function parseEuropochta(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEuropochtaNumber(raw);
  // This is also used for a failed upstream read, so it cannot prove absence.
  if (isRecord(payload) && payload.Error === 404 && payload.ErrorDescription === 'Failed to fetch data') {
    throw new IndeterminateError(PROVIDER, 'Europochta could not retrieve tracking data');
  }
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Europochta returned an invalid history');
  if (!payload.length) throw new NoHistoryError(PROVIDER);
  if (payload.length > 500) throw new SchemaError(PROVIDER, 'Europochta returned too many scans');
  const events: CarrierEvent[] = [];
  const seen = new Map<string, CarrierEvent>();
  const arrivalNotices = new Set<CarrierEvent>();
  for (const row of payload) {
    if (!isRecord(row) || (row.client_info != null && typeof row.client_info !== 'string')) throw new SchemaError(PROVIDER, 'Europochta returned an invalid scan');
    if (!row.client_info || row.employee_info === 'Статус изменен на 80') continue;
    if (row.client_info.length > 10_000) throw new SchemaError(PROVIDER, 'Europochta returned excessive scan text');
    const text = load(row.client_info, null, false).text().replace(/\s+/g, ' ').trim();
    const identities = text.match(/\bBY\d+\b/gi) ?? [];
    if (identities.some(identity => identity.toUpperCase() !== number)) throw new IndeterminateError(PROVIDER, 'Europochta answered for another shipment');
    const wording = europochtaWording(text);
    const arrivalNotice = wording !== text && wording === 'Почтовое отправление прибыло на ОПС выдачи';
    const description = clean(wording, 500);
    if (!description) throw new SchemaError(PROVIDER, 'Europochta returned a scan without wording');
    const local = clock(row.timeX);
    const key = JSON.stringify([local, description]);
    const duplicate = seen.get(key);
    if (duplicate) {
      if (!arrivalNotice) arrivalNotices.delete(duplicate);
      continue;
    }
    const staged = europochtaStage(description);
    const event: CarrierEvent = { local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    seen.set(key, event);
    if (arrivalNotice) arrivalNotices.add(event);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Ties retain the response's order; only wall clocks are supplied.
  events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  // Arrival messages can be sent after collection. These delayed duplicates
  // establish no new movement and must not undo the actual terminal scan.
  const terminal = events.find(event => event.stage === 'delivered' || event.stage === 'returned');
  const history = terminal ? events.filter(event => !arrivalNotices.has(event) || event.local_time! < terminal.local_time!) : events;
  const current = history.find(event => event.stage);
  return {
    status: current?.stage ? languageStageStatus(current.stage as Stage) : 'unknown',
    ...(current?.stage ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
    last_status_text: history[0]!.description!, last_update: null,
    last_update_local: history[0]!.local_time!, expected_delivery: null, events: history,
  };
}

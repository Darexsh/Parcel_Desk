import { load } from 'cheerio';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { dpdPlScanStage, isDpdPlCollection, isDpdPlNotice } from './status.js';

export const PROVIDER = 'DPD Poland';

// The history's heading, columns and package label on the English page and on the Polish one.
const PAGES = [
  { heading: 'Parcel history', columns: 'Date|Time|Description|Depot', pack: 'Package' },
  { heading: 'Historia przesyłki', columns: 'Data|Godzina|Opis|Oddział', pack: 'Paczka' },
];
// The page's answer for a number it does not know, in English and in Polish.
const ABSENT = [/^There is no trace for this parcel \(([^()]{1,40})\)$/, /^Wprowadzono błędny numer przesyłki \(([^()]{1,40})\)$/];
// A Polish depot code, alone or with a pickup point, or a pickup point alone.
const POLISH_DEPOT = /^(?:[A-Z]{2}[A-Z0-9](?:\/PL\d{3,8})?|\/PL\d{3,8})$/;
// A scan's wording in plain words. A row whose first line reads otherwise,
// empty or with an email or markup, is left out.
const WORDING = /^[\p{L}\d][\p{L}\d\s,.;()'’"„”/&+!?%-]{1,149}$/u;

/** A domestic waybill (thirteen digits and a letter) or a DPD parcel number, without its check character. */
export function normalizeDpdPlNumber(raw: string): string {
  const value = normalizeTrackingNumber(raw);
  const number = /^\d{13}[A-Z]$/.test(value) ? value : dpdParcelNumber(value);
  if (!number) throw new InvalidInputError(PROVIDER, 'DPD Poland requires a thirteen-digit waybill with its letter or a fourteen-digit DPD parcel number');
  return number;
}

function challenged(html: string): boolean {
  return /<title>\s*Just a moment|\bcf[-_]chl/i.test(html);
}

/** The anonymous search form whose session the parcel lookup reuses. */
export function validateDpdPlBootstrap(html: string): void {
  const $ = load(html);
  const form = $('form#searchForm');
  if (form.length === 1 && form.attr('action') === './parcelDetails' && form.find('input[name="p1"]').length
    && form.find('input[name="typ"][value="1"]').length === 1) return;
  if (challenged(html)) throw new ChallengeError(PROVIDER, 'DPD Poland asked for a browser check');
  throw new SchemaError(PROVIDER, 'DPD Poland tracking form changed');
}

const text = (value: string | undefined, max = 200) => clean(value, max);

/** The first line of a description: the scan's wording, without the recipient, pickup point or links after it. */
function wordingOf(html: string): string {
  const first = html.split(/<br\b[^>]*>/i, 1)[0]!;
  return text(load(first, null, false).root().text()).replace(/\s*:.*$/, '');
}

/**
 * The page's parcel reply: the requested package's scans, newest first. A
 * parcel of several packages lists them all, and each has its own history.
 */
export function parseDpdPl(html: string, raw: string): CarrierResult {
  const number = normalizeDpdPlNumber(raw);
  const $ = load(html);
  const root = $('div.single-package');
  if (root.length !== 1) {
    if (challenged(html)) throw new ChallengeError(PROVIDER, 'DPD Poland asked for a browser check');
    throw new IndeterminateError(PROVIDER, 'DPD Poland did not return a parcel');
  }
  const table = root.find('table.table-track');
  if (!table.length) {
    const sections = root.children('fieldset');
    const message = text(sections.children('p').first().text());
    const named = ABSENT.map(pattern => pattern.exec(message)?.[1]).find(value => value !== undefined);
    if (sections.length === 1 && named !== undefined) {
      if (named === number) throw new NotFoundError(PROVIDER);
      throw new SchemaError(PROVIDER, 'DPD Poland answered for a different number');
    }
    throw new IndeterminateError(PROVIDER, 'DPD Poland did not return parcel history');
  }
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'DPD Poland returned ambiguous parcel history');
  // The session sets the language, English or Polish, and the page's heading
  // and columns are all in it.
  const headers = table.find('thead th').map((_, node) => text($(node).text(), 40)).get().join('|');
  const heading = text(root.find('h3').first().text(), 80);
  const language = PAGES.find(page => page.columns === headers && page.heading === heading);
  if (!language) throw new SchemaError(PROVIDER, 'DPD Poland history columns changed');
  // The package the history belongs to. A second package of a parcel keeps
  // the first one's number as the parcel's.
  const packages = root.find('input.js-waybill-paczki');
  const options = root.find('select[name="parcel"] option').map((_, node) => text($(node).attr('value'), 80)).get();
  const shown = root.find('.form-group').filter((_, node) => text($(node).children('.label').first().text(), 80) === language.pack);
  if (packages.length !== 1 || text(packages.attr('value'), 80) !== number || root.find('input.js-waybill').length !== 1
    || shown.length !== 1 || text(shown.find('.input-text').text(), 80) !== number
    || (options.length && !options.includes(number))) {
    throw new SchemaError(PROVIDER, 'DPD Poland returned a different parcel');
  }
  const rows = table.find('tbody > tr');
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'DPD Poland returned empty parcel history');
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'DPD Poland returned too many scans');
  const scans: { wording: string; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'DPD Poland history columns changed');
    const day = text(cells.eq(0).text(), 16);
    const time = text(cells.eq(1).text(), 16);
    const wording = wordingOf(cells.eq(2).html() ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) {
      throw new SchemaError(PROVIDER, 'DPD Poland returned an invalid scan');
    }
    if (!WORDING.test(wording)) continue;
    // A Polish depot or pickup point keeps Polish time. Rows without one, as
    // the parcel's registration and another country's scans, have no
    // established zone.
    const polish = POLISH_DEPOT.test(text(cells.eq(3).text(), 40));
    const clock = zonedTime(`${day} ${time}`, 'yyyy-MM-dd HH:mm:ss', polish ? 'Europe/Warsaw' : 'UTC');
    if (!clock) throw new SchemaError(PROVIDER, 'DPD Poland returned an invalid scan time');
    const event: CarrierEvent = {
      ...(polish ? { time: clock.iso } : { local_time: clock.iso.slice(0, 19), provider_time_text: `${day} ${time}` }),
      description: wording,
    };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push({ wording, event });
  }
  // Oldest first: a collection accepts the parcel unless an earlier scan
  // already moved it, and a notice keeps the stage of the scan before it.
  let previous: Stage | undefined;
  let moved = false;
  for (const { wording, event } of [...scans].reverse()) {
    if (isDpdPlNotice(wording)) {
      Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
      continue;
    }
    const stage: Stage | undefined = isDpdPlCollection(wording) ? (moved ? 'in_transit' : 'accepted') : dpdPlScanStage(wording);
    if (!stage) continue;
    Object.assign(event, { stage, stage_source: 'carrier_map' });
    previous = stage;
    moved ||= stage !== 'registered';
  }
  const events = scans.map(scan => scan.event);
  const decider = scans.find(scan => !isDpdPlNotice(scan.wording))?.event;
  if (!decider) throw new IndeterminateError(PROVIDER, 'DPD Poland returned no parcel scans');
  const stage = decider.stage as Stage | undefined;
  const latest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage } : {}),
    last_status_text: decider.description ?? null, last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    ...(stage === 'delivered' && decider.time ? { delivered_at: decider.time } : {}),
    events: events.slice(0, 100),
  };
}

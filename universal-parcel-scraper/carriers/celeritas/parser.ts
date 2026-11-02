import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { celeritasHeadingStage, celeritasStage } from './status.js';

export const PROVIDER = 'Celeritas';
// The page is about 170 kB of site around a few kilobytes of tracking.
export const CELERITAS_MAX_BYTES = 1_000_000;
export const CELERITAS_ORIGIN = 'https://celeritastransporte.com';

// The tracker's reference ("número de referencia"): nine digits.
const NUMBER = /^\d{9}$/;
// "14/10/2026 - 06:41"
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2})$/;
const KILOS = /^\d{1,5}(?:[.,]\d{1,3})?$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied)|_cf_chl_opt|cf-turnstile/i;
const NOT_FOUND = 'Esta referencia no existe';
const REFERENCE = 'Tu número de referencia:';
const WEIGHT = 'Kilos:';
const MAX_ROWS = 300;

/** A Celeritas reference as its tracker takes it: nine digits. */
export function normalizeCeleritasNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Celeritas tracks nine-digit references');
  return number;
}

/** A row's date and clock as one wall time. The page gives no offset. */
function wallClock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]) }, { zone: 'UTC' });
  return parsed.isValid && Number(match[4]) < 24 ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * The value of one line of the details list, by its label. The list also
 * names the shop, the shop's order number, the carrier that delivers, the
 * order date, the origin and destination towns, the Celeritas Point and the
 * parcel count; only the lines asked for are read.
 */
function detail($: CheerioAPI, lines: ReturnType<CheerioAPI>, label: string): string | null {
  const matches = lines.filter((_, line) => clean($(line).children('.first-column').text(), 80) === label);
  if (matches.length > 1) throw new SchemaError(PROVIDER, 'Celeritas repeated a detail of the shipment');
  return matches.length ? clean(matches.children('.second-column').text(), 80) : null;
}

/** The weight in kilograms the details list gives, when it is a positive amount. */
function weight(value: string | null): number | undefined {
  if (!value || !KILOS.test(value)) return undefined;
  const kilos = Number(value.replace(',', '.'));
  return kilos > 0 ? kilos : undefined;
}

/**
 * The page the tracker renders for a reference: the details list, the
 * heading over the scans and the scans, newest first, each with a date and a
 * minute, a wording and an explanation. A reference it does not know gets a
 * notice instead of the details.
 */
export function parseCeleritas(html: string, raw: string): CarrierResult {
  const number = normalizeCeleritasNumber(raw);
  const $ = load(html);
  const sections = $('section.seguimiento-paquete');
  if (sections.length > 1) throw new SchemaError(PROVIDER, 'Celeritas tracking page changed');
  if (!sections.length) {
    const notice = clean($('#problemas-identificacion-paquete h3').text(), 120);
    if (notice === NOT_FOUND) throw new NotFoundError(PROVIDER);
    if (notice) throw new IndeterminateError(PROVIDER, 'Celeritas answered with a notice about the reference');
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Celeritas answered with a block page');
    if ($('form#form1 input[name="identificador"]').length) throw new IndeterminateError(PROVIDER, 'Celeritas returned its search page');
    throw new SchemaError(PROVIDER, 'Celeritas did not return a tracking page');
  }
  const section = sections.first();
  const lines = section.find('.order-tracking-details li');
  const shown = detail($, lines, REFERENCE);
  if (!shown || !NUMBER.test(shown)) throw new SchemaError(PROVIDER, 'Celeritas did not name the reference');
  // The tracker also finds a shipment by the shop's order number; such a hit
  // names another reference and says nothing about the one asked for.
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'Celeritas answered for another reference');

  const headings = section.find('.order-tracking-situations .event-name');
  if (headings.length > 1) throw new SchemaError(PROVIDER, 'Celeritas tracking page changed');
  const heading = clean(headings.text(), 80);
  const rows = section.find('.timeline > .timeline-event');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Celeritas returned too many scans');
  const scans: { event: CarrierEvent; index: number }[] = [];
  const seen = new Set<string>();
  rows.each((index, node) => {
    const row = $(node);
    const time = row.find('time');
    const wording = row.find('span');
    if (time.length !== 1 || wording.length !== 1) throw new SchemaError(PROVIDER, 'Celeritas scan layout changed');
    const local = wallClock(clean(time.text(), 40));
    const description = clean(wording.text(), 200);
    if (!local || !description) throw new SchemaError(PROVIDER, 'Celeritas returned a scan without a clock or wording');
    // The explanation under each wording is the same sentence for every
    // parcel and is left out.
    const event: CarrierEvent = { local_time: local, description };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    const stage = celeritasStage(description);
    if (stage) Object.assign(event, { stage: stage.stage, stage_source: stage.source });
    scans.push({ event, index });
  });
  // Newest first; equal clocks keep the page's order.
  scans.sort((left, right) => right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : left.index - right.index);
  const events = scans.map(({ event }) => event);

  // A returned shipment's heading says so even when a later scan, such as a
  // cross-dock reading on the way to the returns warehouse, is transit.
  const headingStage = heading ? celeritasHeadingStage(heading) : undefined;
  const kilos = weight(detail($, lines, WEIGHT));
  const facts = { expected_delivery: null, ...(kilos !== undefined ? { weight_kg: kilos } : {}) };
  if (!events.length) {
    if (!headingStage) throw new NoHistoryError(PROVIDER);
    return { status: languageStageStatus(headingStage), current_stage: headingStage, current_stage_source: 'carrier_map',
      last_status_text: heading, last_update: null, ...facts, summary_only: true, events: [] };
  }
  const newest = events[0]!;
  const fromHeading = Boolean(headingStage && headingStage !== newest.stage);
  const stage = (fromHeading ? headingStage : newest.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: fromHeading ? 'carrier_map' : newest.stage_source } : {}),
    last_status_text: fromHeading ? heading : newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    ...facts,
    events,
  };
}

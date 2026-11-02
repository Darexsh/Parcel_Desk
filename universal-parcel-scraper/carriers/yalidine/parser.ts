import { load } from 'cheerio';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { yalidineStage } from './status.js';

export const PROVIDER = 'Yalidine';
export const YALIDINE_MAX_BYTES = 1_000_000;
const BLOCKED = /_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const MONTH_DAYS: Readonly<Record<string, number>> = {
  janvier: 31, février: 29, mars: 31, avril: 30, mai: 31, juin: 30,
  juillet: 31, août: 31, septembre: 30, octobre: 31, novembre: 30, décembre: 31,
};

/** Reuse the existing own-label rule; no bare numeric identifier claims this carrier. */
export function normalizeYalidineNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!number || !detectCarrierMatch(number).candidates.includes('yalidine')) {
    throw new InvalidInputError(PROVIDER, 'Yalidine needs its own YAL-prefixed tracking number');
  }
  return number;
}

export function yalidineRequestNumber(raw: string): string {
  return `yal-${normalizeYalidineNumber(raw).slice(3)}`;
}

/** The guest page states no year. Validate the displayed digits without inventing one. */
function clock(raw: string): string {
  const text = clean(raw, 64);
  const match = /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) (\d{2}) ([a-zéûô]+) à ((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(text);
  if (!match || !MONTH_DAYS[match[3]!] || Number(match[2]) < 1 || Number(match[2]) > MONTH_DAYS[match[3]!]!) {
    throw new SchemaError(PROVIDER, 'Yalidine returned an invalid yearless scan clock');
  }
  return text;
}

/** A result of the adapter's same-path, whole-number guest form POST. */
export function parseYalidine(html: string, raw: string): CarrierResult {
  const number = normalizeYalidineNumber(raw);
  if (new TextEncoder().encode(html).byteLength > YALIDINE_MAX_BYTES) throw new SchemaError(PROVIDER, 'Yalidine returned an oversized tracking page');
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Yalidine answered with a browser check');
  const $ = load(html);
  const root = $('#about > .container');
  const forms = root.children('form');
  if (root.length !== 1 || forms.length !== 1 || forms.attr('method')?.toLowerCase() !== 'post'
    || forms.find('input[name="tracking"]').length !== 1 || forms.find('.cf-turnstile').length !== 1) {
    throw new SchemaError(PROVIDER, 'Yalidine changed its guest tracking page');
  }
  const cards = root.children('.card');
  const alerts = root.children('.alert');
  if (alerts.length) {
    if (alerts.length !== 1 || cards.length || root.find('table').length) throw new SchemaError(PROVIDER, 'Yalidine returned conflicting tracking replies');
    const alert = alerts.first(), message = alert.clone();
    message.find('br').replaceWith(' ');
    const text = clean(message.text(), 500);
    if (!alert.hasClass('alert-danger') || alert.children('strong').length !== 1
      || clean(alert.children('strong').text()) !== 'Affichage impossible') throw new SchemaError(PROVIDER, 'Yalidine changed its lookup notice');
    if (text === "Affichage impossible Le colis que vous avez saisi n'existe pas.") throw new NotFoundError(PROVIDER);
    if (text === 'Affichage impossible Veuillez réessayer.') throw new ChallengeError(PROVIDER, 'Yalidine did not accept guest verification');
    throw new IndeterminateError(PROVIDER, 'Yalidine did not complete the tracking lookup');
  }
  if (cards.length !== 1) throw new SchemaError(PROVIDER, 'Yalidine returned no unique shipment card');
  const headers = cards.children('.card-header');
  const heading = /^Le suivi du colis (YAL-[A-Z0-9]{6})$/i.exec(clean(headers.text(), 200));
  if (headers.length !== 1 || !heading || headers.children('span').length !== 1) throw new SchemaError(PROVIDER, 'Yalidine returned no whole shipment identity');
  if (normalizeTrackingNumber(heading[1]!) !== number) throw new IndeterminateError(PROVIDER, 'Yalidine answered for another shipment');
  const table = cards.children('.card-body').children('.table-responsive').children('table');
  if (table.length !== 1 || cards.find('table').length !== 1
    || table.find('thead th').toArray().map(node => clean($(node).text())).join('|') !== 'Date du statut|Le statut|Localisation') {
    throw new SchemaError(PROVIDER, 'Yalidine changed its scan table');
  }
  const rows = table.children('tbody').children('tr');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Yalidine returned too many scans');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  let currentBadges = 0;
  for (const [index, row] of rows.toArray().entries()) {
    const cells = $(row).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Yalidine returned an incomplete scan');
    if (cells.toArray().some(cell => $(cell).text().length > 2000)) throw new SchemaError(PROVIDER, 'Yalidine returned excessive scan text');
    const date = clock(cells.eq(0).text());
    const status = cells.eq(1).clone();
    for (const badge of status.children('span').toArray()) {
      if (clean($(badge).text()) !== 'Actuel' || index !== 0) throw new SchemaError(PROVIDER, 'Yalidine returned an ambiguous current scan');
      currentBadges++;
      $(badge).remove();
    }
    if (status.children().length) throw new SchemaError(PROVIDER, 'Yalidine changed its scan wording');
    const description = clean(status.text(), 500), location = clean(cells.eq(2).text(), 160);
    if (!description) throw new SchemaError(PROVIDER, 'Yalidine returned an unnamed scan');
    const key = JSON.stringify([date, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = yalidineStage(description);
    events.push({ provider_time_text: date, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (currentBadges !== 1) throw new SchemaError(PROVIDER, 'Yalidine returned no unique current scan');
  // The table is newest first. Sorting a yearless calendar can invert New Year.
  const latest = events[0]!, current = yalidineStage(latest.description!);
  return { status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: latest.description!, last_update: null, expected_delivery: null, events };
}

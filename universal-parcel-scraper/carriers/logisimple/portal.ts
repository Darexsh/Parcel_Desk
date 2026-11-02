/**
 * The courier portal Logisimple runs, a Laravel site that Intercourier's
 * tracking page also runs on, each on its own host. Its tracking page,
 * `/{locale}/tracking?tracking={number}`, renders on the server. The form takes
 * several numbers separated by commas and shows a card for each one it finds,
 * headed `TRK#{number}`, with the sender's reference, the expected delivery and
 * a table of scans, newest first. A number it does not know gets "Não
 * encontrámos correspondências para o código de envio", with HTTP 200. Each
 * carrier keeps its own host, numbers and status map; this module holds the
 * request and parser they share.
 */
import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';

/** One carrier's tenant on the portal. */
export interface CourierPortalTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The portal's origin, such as `https://portal.example.pt`. */
  readonly origin: string;
  /** The tenant's numbers, as normalization leaves them. */
  readonly layout: RegExp;
  /** What a number of another layout is told. */
  readonly layoutMessage: string;
  /** A scan's stage, by its state's name and the sentence that explains the state. */
  readonly stage: (state: string, detail: string) => ClassifiedWording | null;
}

// A page with a long history is under 100 kB; a delivered one carries the
// proof of delivery's image, which can be a photo.
export const COURIER_PORTAL_MAX_BYTES = 8_000_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown number with HTTP 200: a missing route is not a missing shipment.
const GONE = [404, 405, 410];
const NOT_FOUND = /^Não encontrámos correspondências para o código de envio\b/;
const CODE = /^TRK#\s*(\S{1,64})$/;
// "2025-08-25" and "11:19"
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// The estimate's day, with the time it gives: "2025-08-25 até 12:00".
const ESTIMATE = /^(\d{4})-(\d{2})-(\d{2})(?:\s|$)/;
const ESTIMATE_LABEL = 'prev. entrega';
// The scan table's headings, in the Portuguese page the adapter asks for.
const COLUMNS = { day: 'data', minute: 'hora', state: 'estados', place: 'armazém', detail: 'detalhes' } as const;
// A firewall's, CDN's or bot check's page in place of the portal's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenge-platform|requested URL was rejected|g-recaptcha|h-captcha|_Incapsula_Resource/i;
const MAX_ROWS = 300;

/** A tenant's number, as the adapter asks for it; anything else is not one of its numbers. */
export function normalizeCourierPortalNumber(raw: string, tenant: CourierPortalTenant): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!tenant.layout.test(number)) throw new InvalidInputError(tenant.provider, tenant.layoutMessage);
  return number;
}

/** The Portuguese tracking page for one number, as the portal's search form submits it. */
export function courierPortalTrackingUrl(tenant: CourierPortalTenant, number: string): string {
  return `${tenant.origin}/pt/tracking?${new URLSearchParams({ tracking: number }).toString()}`;
}

function text($: CheerioAPI, element: Cheerio<AnyNode> | AnyNode, maxLength = 300): string {
  return clean($(element).text(), maxLength);
}

/** A number as the page echoes it, without the quotes around it. */
function echoed(value: string): string {
  return normalizeTrackingNumber(value.replace(/["“”]/g, ''));
}

/** A scan's day and minute as one wall clock. The page gives no zone. */
function wallClock(day: string, minute: string, provider: string): string {
  const date = DAY.exec(day);
  const valid = date ? calendarDay(Number(date[1]), Number(date[2]), Number(date[3])) : null;
  if (!valid || valid < '2000-01-01' || !MINUTE.test(minute)) throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  return `${valid}T${minute}:00`;
}

/** The estimate's day while the parcel is still to come, and not a day before its newest scan. */
function estimateDay(card: Cheerio<AnyNode>, $: CheerioAPI, newest: string): string | null {
  const row = card.find('.details-box tr').toArray()
    .find((element) => text($, $(element).children('td').first()).toLocaleLowerCase('pt-PT') === ESTIMATE_LABEL);
  const match = row ? ESTIMATE.exec(text($, $(row).children('td').eq(1))) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  return day && day >= newest.slice(0, 10) ? day : null;
}

/** The column of each heading the scan table must have. */
function columns($: CheerioAPI, table: Cheerio<AnyNode>, provider: string): Record<keyof typeof COLUMNS, number> {
  const headings = table.find('thead th').toArray().map((element) => text($, element, 60).toLocaleLowerCase('pt-PT'));
  return Object.fromEntries(Object.entries(COLUMNS).map(([key, heading]) => {
    const index = headings.indexOf(heading);
    if (index < 0 || headings.lastIndexOf(heading) !== index) throw new SchemaError(provider, `${provider} returned an unexpected scan table`);
    return [key, index];
  })) as Record<keyof typeof COLUMNS, number>;
}

/**
 * The tracking page the portal renders for one number. The scan table has
 * the day, the minute, the state, the warehouse, the state's explanation and
 * remarks. A delivered scan's remarks open the proof of delivery, which names
 * the person who received the parcel: it is removed before anything is read,
 * and the remarks are never read.
 */
export function parseCourierPortal(html: string, raw: string, tenant: CourierPortalTenant): CarrierResult {
  const { provider } = tenant;
  const number = normalizeCourierPortalNumber(raw, tenant);
  const $ = load(html);
  $('.modal').remove();

  const cards = $('.card-tracking[data-tracking]').toArray()
    .filter((element) => echoed(CODE.exec(text($, $(element).find('.details-box h4').first(), 80))?.[1] ?? '') === number);
  if (!cards.length) {
    const notices = $('h4').toArray().filter((element) => NOT_FOUND.test(text($, element)));
    if (notices.some((element) => echoed(text($, $(element).find('b'), 80)) === number)) throw new NotFoundError(provider);
    if (notices.length || $('.card-tracking[data-tracking]').length) throw new IndeterminateError(provider, `${provider} answered for another shipment`);
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a bot check`);
    throw new SchemaError(provider, `${provider} returned an unexpected page`);
  }
  if (cards.length > 1) throw new IndeterminateError(provider, `${provider} answered for several shipments`);
  const card = $(cards[0]);
  const tables = card.find('table.table-history');
  if (tables.length > 1) throw new SchemaError(provider, `${provider} returned several scan tables`);
  if (!tables.length) throw new NoHistoryError(provider);
  const column = columns($, tables, provider);
  const rows = tables.find('tbody > tr').toArray();
  if (!rows.length) throw new NoHistoryError(provider);
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);

  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    const cells = $(row).children('td');
    if (cells.length <= Math.max(...Object.values(column))) throw new SchemaError(provider, `${provider} returned an incomplete scan`);
    const cell = (key: keyof typeof COLUMNS) => text($, cells.eq(column[key]));
    const local = wallClock(cell('day'), cell('minute'), provider);
    const state = cell('state');
    const detail = cell('detail');
    const description = state || detail;
    if (!description) throw new SchemaError(provider, `${provider} returned a scan without its state`);
    const location = clean(cell('place'), 120);
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = tenant.stage(state, detail);
    scans.push({ local, index, event: {
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // Newest first; of scans on one minute, the row higher on the page is the newer.
  scans.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  const events = scans.map((scan) => scan.event);
  const newest = scans[0]!.local;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const final = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: newest,
    // The estimate stays on the page after the delivery.
    expected_delivery: final ? null : estimateDay(card, $, newest),
    events,
  };
}

/** Looks a tenant's number up on its portal's tracking page. */
export class CourierPortalTracker {
  constructor(
    private readonly tenant: CourierPortalTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {},
  ) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { tenant } = this;
    const number = normalizeCourierPortalNumber(raw, tenant);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(courierPortalTrackingUrl(tenant, number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-PT,pt', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: tenant.provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: COURIER_PORTAL_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      const { status } = response;
      if (status === 403) throw new ChallengeError(tenant.provider, `${tenant.provider} refused the lookup`, { status });
      if (REDIRECTS.includes(status) || GONE.includes(status)) {
        throw new TransportError(tenant.provider, `${tenant.provider}'s tracking page moved`, { status });
      }
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(tenant.provider, `${tenant.provider} returned an empty page`);
      return parseCourierPortal(html, number, tenant);
    };
    // A read that fails to reach the portal, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

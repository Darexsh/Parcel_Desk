
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isYanwenPlaceholder } from './app.js';
import { yanwenCategory, yanwenStatus } from './status.js';

// This constant is shipped in the public browser script; it is part of the
// anonymous form protocol, not a customer or account credential.
const PUBLIC_FORM_SALT = '00#78a13&ba6c;73LOL';

export function normalizeYanwenNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{8,40}$/.test(number)) throw new InvalidInputError('Yanwen', 'Yanwen requires an alphanumeric parcel reference');
  return number;
}

export function yanwenTrackingUrl(raw: string): string {
  const number = normalizeYanwenNumber(raw);
  const signature = createHash('md5').update(number + PUBLIC_FORM_SALT).digest('hex');
  return `https://track.yw56.com.cn/en/querydel?${new URLSearchParams({ nums: number, cyp: signature })}`;
}

// Partner scans can carry the delivery postcode: a Canadian one before the
// town, a US ZIP after the state. A location keeps its town and region only,
// and a partner's "Not Available" or bare "AA", a code no country holds, is none.
const POSTCODE = /^(?:[A-Z]\d[A-Z] ?\d[A-Z]\d|\d{5}(?:-\d{4})?)$/i;
// GOFO's European delivery scans say whether a PIN was used and give a door
// number; neither belongs in the wording.
const DELIVERY_DETAIL = /\s*,?\s*\b(?:PIN|Door NO):[^,.]*/gi;

function place(raw: string): string {
  if (isYanwenPlaceholder(raw)) return '';
  const parts = raw.split(',').map((part) => part.trim());
  const kept = parts.map((part) => part.replace(/^([A-Z]{2}) \d{5}(?:-\d{4})?$/, '$1')).filter((part) => part && !POSTCODE.test(part));
  return kept.join(',') === parts.join(',') ? raw : kept.join(', ');
}

/**
 * The last-mile carrier the notes name. The catalog must know its name or
 * site, and that carrier's own detection must offer the reference: one
 * brand's site can serve regional networks outside the catalog carrier.
 */
function distributor(notes: string[], reference: string): string | undefined {
  const field = (label: string) => notes.find((line) => line.startsWith(`${label}: `))?.slice(label.length + 2) ?? '';
  const carrier = carrierIdFromPartner(field('Distributor'), field('Distributor Website'));
  return carrier && carrier !== 'yanwen' && (detectCarrierMatch(reference).candidates as string[]).includes(carrier) ? carrier : undefined;
}

function eventTime(day: string, raw: string): string {
  const match = /^(\d{2}:\d{2}:\d{2}) \[GMT([+-]\d{2})(?::(\d{2}))?\]$/.exec(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !match) throw new SchemaError('Yanwen', 'Yanwen returned an invalid scan time');
  const parsed = DateTime.fromISO(`${day}T${match[1]}${match[2]}:${match[3] ?? '00'}`, { setZone: true });
  if (!parsed.isValid) throw new SchemaError('Yanwen', 'Yanwen returned an invalid scan time');
  return parsed.toISO({ suppressMilliseconds: true });
}

/**
 * Yanwen relays La Poste's scans of a parcel bound for France on UTC's wall
 * clock under France's offset, with no copy on the local clock: its "Arrived
 * at destination" at 13:34:37 [GMT+02] is La Poste's 15:34:37+02:00. A
 * relayed scan, placed and without an icon, under France's offset at the
 * instant its wall clock gives in UTC, is read that way and keeps its offset.
 */
function onFrenchUtcClock(event: CarrierEvent): CarrierEvent {
  const shown = DateTime.fromISO(event.time!, { setZone: true });
  if (!event.location || event.provider_code || !shown.offset) return event;
  const utc = DateTime.fromISO(shown.toISO({ includeOffset: false })!, { zone: 'utc' });
  if (utc.setZone('Europe/Paris').offset !== shown.offset) return event;
  return { ...event, time: utc.setZone(shown.zone).toISO({ suppressMilliseconds: true })! };
}

/**
 * Some partner histories come twice: on the local wall clock and on the UTC
 * wall clock under the same offset, which puts US scans hours late. A scan with
 * the same wording, icon and offset exactly that offset away, in the same place
 * or with one place missing, is the UTC copy: the local scan stays and keeps
 * the copy's place. A scan that could pair with more than one stays as it is.
 */
function withoutUtcCopies(events: CarrierEvent[]): CarrierEvent[] {
  const clocks = events.map((event) => DateTime.fromISO(event.time!, { setZone: true }));
  const pairs: Array<[local: number, copy: number]> = [];
  events.forEach((local, i) => events.forEach((copy, j) => {
    const { offset } = clocks[i]!;
    if (offset && clocks[j]!.offset === offset && clocks[j]!.toMillis() === clocks[i]!.toMillis() - offset * 60_000
      && copy.description === local.description && copy.provider_code === local.provider_code
      && (!copy.location || !local.location || copy.location === local.location)) pairs.push([i, j]);
  }));
  const uses = new Map<number, number>();
  for (const index of pairs.flat()) uses.set(index, (uses.get(index) ?? 0) + 1);
  const unique = pairs.filter((pair) => pair.every((index) => uses.get(index) === 1));
  const copies = new Set(unique.map(([, copy]) => copy));
  const places = new Map(unique.map(([local, copy]) => [local, events[local]!.location || events[copy]!.location]));
  return events.flatMap((event, index) => copies.has(index) ? [] : [places.has(index) ? { ...event, location: places.get(index) } : event]);
}

export function parse(html: string, trackingNumber: string): CarrierResult {
  const number = normalizeYanwenNumber(trackingNumber);
  const $ = load(html);
  $('script, style, noscript').remove();
  const pages = $('.ny_cxjg > input[name="wcdhA"]');
  // The tracker answers a last-mile number with its parcel's page, which
  // names that number beside the parcel's own and in the parcel summary.
  const own = pages.length === 1 ? pages.attr('value') ?? '' : '';
  const parcel = own !== number && /^[A-Z0-9]{8,40}$/.test(own) && $('.ny_cxjg > input').filter((_, element) =>
    $(element).attr('name') === `wcdhB${own}` && $(element).attr('value') === number).length === 1 ? own : number;
  const identities = pages.filter((_, element) => $(element).attr('value') === parcel);
  // Which check failed tells a page without any shipment from one naming another.
  if (identities.length !== 1) {
    throw new SchemaError('Yanwen', `Yanwen returned a different or ambiguous shipment (${pages.length} listed, ${identities.length} matching)`);
  }
  const resultBlocks = $('.cx_lb').filter((_, element) => clean($(element).find('.cx_bt_xx > h5').text()) === parcel);
  if (resultBlocks.length < 1 || resultBlocks.length > 2) {
    throw new SchemaError('Yanwen', `Yanwen returned a different or ambiguous shipment (${resultBlocks.length} result blocks for it)`);
  }
  const results: CarrierResult[] = [];
  for (const element of resultBlocks.toArray()) {
    const block = $(element);
    const timeline = block.find('.czhaodl');
    const summary = clean(block.find('.cx_bt_xx > p').text(), 200);
    if (parcel === number && timeline.length === 0 && summary === 'No information was found' && identities.attr('status') === '查询不到') {
      results.push({ missing: true });
      continue;
    }
    if (timeline.length !== 1) throw new IndeterminateError('Yanwen', 'Yanwen returned no parcel timeline');
    const scans = timeline.find('dl > dd');
    if (!scans.length || scans.length > 500) throw new SchemaError('Yanwen', 'Yanwen returned incomplete tracking history');
    const scanned: CarrierEvent[] = [];
    const seen = new Set<string>();
    for (const scan of scans.toArray()) {
      const row = $(scan);
      const day = clean(row.prevAll('dt').first().text(), 32);
      const time = eventTime(day, clean(row.find('.timePoint').text(), 64));
      const words = row.find('.cz_r h6');
      if (words.length < 1 || words.length > 2) throw new SchemaError('Yanwen');
      const description = clean(words.last().text(), 500).replace(DELIVERY_DETAIL, '');
      if (!description) throw new SchemaError('Yanwen', 'Yanwen returned an empty scan');
      const location = words.length === 2 ? place(clean(words.first().text(), 200).replace(/^\[|\]$/g, '')) : '';
      const code = /\/([A-Z]{2}\d{2})\.png$/.exec(row.find('.cz_c img').attr('src') ?? '')?.[1];
      const key = JSON.stringify([time, description, location]);
      if (seen.has(key)) continue;
      seen.add(key);
      const classified = yanwenStatus(description, code);
      scanned.push({ time, description, location, ...(code ? { provider_code: code } : {}), ...(classified ? { stage: classified.stage } : {}) });
    }
    const columns = block.children('.cx_top_nr').children('.colFlex');
    if (columns.length !== 5) throw new SchemaError('Yanwen', 'Yanwen returned an invalid parcel summary');
    columns.find('a').remove();
    const country = clean(columns.eq(3).text(), 8).toUpperCase();
    const local = withoutUtcCopies(scanned);
    // Without a local copy beside them, La Poste's scans came on UTC's wall clock alone.
    const events = country === 'FR' && local.length === scanned.length ? local.map(onFrenchUtcClock) : local;
    const latest = events[0]!;
    const scan = yanwenStatus(latest.description!, latest.provider_code);
    // The category gives the status when the newest scan's wording is new. A
    // delivery still needs a delivered scan; the category alone never makes one.
    const filed = yanwenCategory(identities.attr('status'));
    const category = filed?.status === 'delivered' && !events.some((event) => event.stage === 'delivered') ? undefined : filed;
    const status = scan?.status ?? category?.status ?? 'unknown';
    const stage = scan?.stage ?? category?.stage;
    const delivery = status === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
    const deliveryNumber = clean(columns.eq(1).text(), 64).toUpperCase();
    if (parcel !== number && deliveryNumber !== number) throw new SchemaError('Yanwen', 'Yanwen returned a different or ambiguous shipment (another last-mile number)');
    const handoff = deliveryNumber !== number && /^[A-Z0-9]{4,40}$/.test(deliveryNumber) ? deliveryNumber : '';
    const notes = block.find('.addNotes p').toArray().map((line) => clean($(line).text(), 300));
    const partner = handoff ? distributor(notes, handoff) : undefined;
    results.push({ status, ...(stage ? { current_stage: stage } : {}),
      last_status_text: latest.description, last_update: latest.time,
      ...(delivery ? { delivered_at: delivery.time } : {}), ...(parcel !== number ? { canonical_tracking_number: parcel } : {}),
      ...(handoff ? { delivery_tracking_number: handoff, ...(partner ? { delivery_carrier: partner } : {}) } : {}),
      ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}), events: events.slice(0, 100) });
  }
  // The server renders desktop and mobile copies. Require them to agree so
  // responsive duplicates cannot silently hide a different result.
  if (results.some((result) => JSON.stringify(result) !== JSON.stringify(results[0]))) throw new SchemaError('Yanwen', 'Yanwen returned inconsistent parcel histories');
  if (results[0]!.missing) throw new NotFoundError('Yanwen');
  return results[0]!;
}

export class YanwenTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeYanwenNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Yanwen timeout must be positive');
    context.signal?.throwIfAborted();
    try {
      const { bytes } = await fetchBounded(yanwenTrackingUrl(number), { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) }, body: 'timeZone=1',
      }, { provider: 'Yanwen', timeoutMs: Math.max(1, Math.floor(budgetMs)), maxBytes: 1_000_000,
        fetcher: (input, init) => (this.options.fetcher ?? fetch)(input, { ...init,
          signal: AbortSignal.any([...(context.signal ? [context.signal] : []), ...(init?.signal ? [init.signal] : [])]) }),
      });
      context.signal?.throwIfAborted();
      return parse(decodeText(bytes), number);
    } catch (error) {
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Yanwen', 'Yanwen tracking endpoint is unavailable', { cause: error });
      throw error;
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new YanwenTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return { id: 'yanwen', recordsSteps: true, steps: ['direct'], track: async (input, context = {}) => {
    // A number of another shape is refused before the lookup starts.
    normalizeYanwenNumber(input.number);
    return runSteps({ carrier: 'yanwen', budgetMs: context.budgetMs ?? 15_000, signal: context.signal, recorder: environment.recorder },
      [{ id: 'direct', run: ({ signal, remainingMs }) => tracker.fetch(input.number, { signal, budgetMs: remainingMs }) }]);
  } };
};

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { loggiStage } from './status.js';

export const PROVIDER = 'Loggi';
export const LOGGI_MAX_BYTES = 2_000_000;
const MAX_ROWS = 500;

export function normalizeLoggiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{8}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Loggi requires an eight-character tracking code');
  return number;
}

export function loggiTrackingUrl(raw: string): string {
  return `https://app.loggi.com/rastreador/${normalizeLoggiNumber(raw)}`;
}

function text(row: Record<string, unknown>, key: string, max = 500): string {
  const value = row[key];
  if (value === null || value === undefined || value === '$undefined') return '';
  if (typeof value !== 'string' || (value.startsWith('$') && !value.startsWith('$$'))) {
    throw new SchemaError(PROVIDER, `Loggi returned an invalid ${key}`);
  }
  return clean(value.startsWith('$$') ? value.slice(1) : value, max);
}

/** Only the day is supplied; midnight and a Brazilian offset would invent a scan clock. */
function scanDay(value: string): string {
  const match = /^(\d{1,2}) ([a-zç]{3})\.?[,]? (\d{4})$/i.exec(value);
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const month = match ? months.indexOf(match[2]!.toLowerCase()) + 1 : 0;
  const date = match && month ? DateTime.fromObject({ year: Number(match[3]), month, day: Number(match[1]) }, { zone: 'UTC' }) : null;
  if (!date?.isValid) throw new SchemaError(PROVIDER, 'Loggi returned an invalid scan day');
  return date.toFormat('yyyy-MM-dd');
}

/** The serialized component props in the requested page, without evaluating page scripts. */
export function parseLoggi(html: string, raw: string): CarrierResult {
  const number = normalizeLoggiNumber(raw);
  if (html.length > LOGGI_MAX_BYTES) throw new SchemaError(PROVIDER, 'Loggi returned an oversized page');
  const $ = load(html);
  if (/just a moment|attention required|access denied/i.test($('title').text()) || /_cf_chl_opt\s*=/.test(html)) {
    throw new ChallengeError(PROVIDER, 'Loggi requires browser verification');
  }
  let stream = '';
  $('script').each((_index, element) => {
    const match = /^\s*self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/.exec($(element).text());
    if (!match) return;
    let chunk: unknown;
    try { chunk = JSON.parse(match[1]!); } catch { throw new SchemaError(PROVIDER, 'Loggi returned unreadable page data'); }
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === 'string') stream += chunk[1];
  });
  const models: unknown[] = [];
  const views = new Set<string>();
  let root: unknown;
  let failed = false;
  for (const line of stream.split('\n')) {
    const match = /^([0-9a-f]{1,8}):(I?)([[{][\s\S]*)$/.exec(line);
    if (/^[0-9a-f]{1,8}:E/.test(line)) failed = true;
    if (!match) continue;
    let value: unknown;
    try { value = JSON.parse(match[3]!); } catch { throw new SchemaError(PROVIDER, 'Loggi returned incomplete page data'); }
    if (match[2] === 'I') {
      if (Array.isArray(value) && value[2] === 'MainContent' && Array.isArray(value[1])
        && value[1].some(path => typeof path === 'string' && /rastreador\/(?:%5B|\[)tracking-code(?:%5D|\])\/page-/.test(path))) views.add(`$L${match[1]}`);
    } else {
      models.push(value);
      if (match[1] === '0') root = value;
    }
  }
  if (!isRecord(root) || !Array.isArray(root.c) || root.c.length !== 3 || root.c[0] !== '' || root.c[1] !== 'rastreador' || root.c[2] !== number) {
    throw new IndeterminateError(PROVIDER, 'Loggi returned no page bound to the requested tracking code');
  }
  const contents: Record<string, unknown>[] = [];
  const stack = [...models];
  for (let visited = 0; stack.length; visited++) {
    if (visited >= 100_000) throw new SchemaError(PROVIDER, 'Loggi returned an oversized component tree');
    const node = stack.pop();
    if (Array.isArray(node)) {
      if (node[0] === '$' && typeof node[1] === 'string' && views.has(node[1]) && isRecord(node[3])) contents.push(node[3]);
      for (const child of node as unknown[]) stack.push(child);
    } else if (isRecord(node)) for (const child of Object.values(node)) stack.push(child);
  }
  if (contents.length !== 1) throw new SchemaError(PROVIDER, 'Loggi returned no unambiguous tracking view');
  const shipment = contents[0]!;
  // This is the route's active view, rather than the generic 404 template present on every Next page.
  if (!Object.keys(shipment).length && !failed && $('h1,h2').toArray().some(element => clean($(element).text()) === 'Página não encontrada')) {
    throw new NotFoundError(PROVIDER);
  }
  if (shipment.initialTrackingCode === number) throw new ChallengeError(PROVIDER, 'Loggi requires recipient verification for the reused code');
  if (!isRecord(shipment.trackingCode)) throw new SchemaError(PROVIDER, 'Loggi returned no tracking codes');
  if (text(shipment.trackingCode, 'loggi', 64) !== number) throw new IndeterminateError(PROVIDER, 'Loggi answered for another tracking code');
  if (!Array.isArray(shipment.history) || shipment.history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Loggi returned an invalid history');
  if (!shipment.history.length) throw new NoHistoryError(PROVIDER);
  const events: CarrierEvent[] = [];
  for (const row of shipment.history as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Loggi returned an invalid scan');
    const wording = text(row, 'title');
    if (!wording) throw new SchemaError(PROVIDER, 'Loggi returned a scan without wording');
    const day = scanDay(text(row, 'date', 40));
    const classified = loggiStage(wording);
    // Descriptions on facility scans are towns. Delivery details and names are separate props, never read.
    const location = ['Chegou em uma base', 'Saiu de uma base', 'Coletado'].includes(wording) ? text(row, 'description', 160) : '';
    const description = wording;
    // Two identical wordings on one day can be separate scans; the page supplies no clock to deduplicate them.
    events.push({ local_time: day, description, ...(location ? { location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) });
  }
  // The page lists newest first; equal dates retain that order.
  events.sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
  const newest = events[0]!;
  const current = loggiStage(text(shipment, 'status'));
  return { status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: text(shipment, 'status') || newest.description!, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}

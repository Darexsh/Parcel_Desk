import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { zrExpressRequestNumber } from './number.js';
import { zrExpressStage } from './status.js';

export { zrExpressRequestNumber } from './number.js';

export const PROVIDER = 'ZR Express';
// A delivered parcel's page is under 40 kilobytes.
export const ZR_EXPRESS_MAX_BYTES = 1_000_000;
const MAX_NODES = 250_000;
const MAX_STEPS = 300;
const MAX_EVENTS = 100;

// Row tags whose payload gives its length in bytes, as hex before a comma, and
// ends without a line feed: text, and typed arrays.
const LENGTH_TAGS = new Set([...'TAOoUSsLlGgMmV'].map((tag) => tag.charCodeAt(0)));
const COLON = 0x3a;
const COMMA = 0x2c;
const LINE_FEED = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
/** Next's notFound() and redirect() travel as error rows, and mean the route changed. */
const NEXT_CONTROL = /^(?:NEXT_NOT_FOUND$|NEXT_HTTP_ERROR_FALLBACK;|NEXT_REDIRECT;)/;

/** The digest of an error row; an unreadable one is an empty digest, never a Next signal. */
function errorDigest(json: string): string {
  try {
    const error: unknown = JSON.parse(json);
    return isRecord(error) && typeof error.digest === 'string' ? error.digest : '';
  } catch {
    return '';
  }
}

/**
 * The JSON rows of a React Server Components reply by row id, and the digests
 * of its error rows. A text row ends where its byte length does, often with
 * the next row on the same line, so rows are read by length, not split at line
 * feeds. Hint rows have no id; they, text and module rows are skipped.
 */
function flightRows(bytes: Uint8Array): { rows: Map<string, unknown>; failures: string[] } {
  const rows = new Map<string, unknown>();
  const failures: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (bytes[at] === LINE_FEED) { at += 1; continue; }
    const colon = bytes.indexOf(COLON, at);
    const id = colon < 0 ? '' : ascii(bytes.subarray(at, Math.min(colon, at + 9)));
    if (colon < 0 || !/^[0-9a-f]{0,8}$/.test(id)) throw new SchemaError(PROVIDER, 'ZR Express returned an unreadable page');
    at = colon + 1;
    if (LENGTH_TAGS.has(bytes[at]!)) {
      const comma = bytes.indexOf(COMMA, at);
      const length = comma < 0 ? '' : ascii(bytes.subarray(at + 1, Math.min(comma, at + 10)));
      if (!/^[0-9a-f]{1,8}$/.test(length)) throw new SchemaError(PROVIDER, 'ZR Express returned an unreadable page');
      at = comma + 1 + parseInt(length, 16);
      if (at > bytes.length) throw new SchemaError(PROVIDER, 'ZR Express returned a truncated page');
      continue;
    }
    const end = bytes.indexOf(LINE_FEED, at);
    const stop = end < 0 ? bytes.length : end;
    let row: string;
    try { row = utf8.decode(bytes.subarray(at, stop)); }
    catch (cause) { throw new SchemaError(PROVIDER, 'ZR Express returned an unreadable page', { cause }); }
    at = stop + 1;
    if (row.startsWith('E{')) failures.push(errorDigest(row.slice(1)));
    else if (id && /^[[{"]/.test(row)) {
      try { rows.set(id, JSON.parse(row)); }
      catch { /* A row that is not JSON holds neither a parcel nor its absence. */ }
    }
  }
  return { rows, failures };
}

type Element = [string, unknown, unknown, Record<string, unknown>];
const isElement = (node: unknown): node is Element => Array.isArray(node) && node.length === 4 && node[0] === '$' && isRecord(node[3]);
/** A reference to another row: `$1a`, or `$L1a` for one rendered lazily. */
const REFERENCE = /^\$L?([0-9a-f]{1,8})$/;

/** The texts an element renders, in order, following references to other rows and skipping `$undefined`. */
function textsOf(node: unknown, rows: Map<string, unknown>, budget = { left: 10_000 }): string[] {
  if (--budget.left < 0) throw new SchemaError(PROVIDER, 'ZR Express returned an oversized page');
  if (typeof node === 'number') return [String(node)];
  if (typeof node === 'string') {
    const reference = REFERENCE.exec(node)?.[1];
    if (reference !== undefined) return textsOf(rows.get(reference), rows, budget);
    if (node.startsWith('$$')) return [node.slice(1)];
    return node.startsWith('$') ? [] : [node];
  }
  if (isElement(node)) return textsOf(node[3].children, rows, budget);
  if (Array.isArray(node)) return node.flatMap((child) => textsOf(child, rows, budget));
  return [];
}

/** A row or a reference to one, resolved. */
function resolved(node: unknown, rows: Map<string, unknown>): unknown {
  const reference = typeof node === 'string' ? REFERENCE.exec(node)?.[1] : undefined;
  return reference === undefined ? node : rows.get(reference);
}

/**
 * Each step of the history is keyed with its UTC instant, its state code and
 * its place in the list, as `2026-01-02T03:04:05.678Z-livre-8`.
 */
const STEP_KEY = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)-([a-z][a-z0-9_]{0,63})-(\d{1,4})$/;

/**
 * The answer box, whose first child is the status chip: the chip, then the
 * number and any message under it. And the keyed steps of the history.
 */
function scanPage(rows: Map<string, unknown>) {
  const boxes: unknown[][] = [];
  const steps = new Map<string, Element>();
  const stack: unknown[] = [...rows.values()];
  for (let visited = 0; stack.length; visited += 1) {
    if (visited > MAX_NODES) throw new SchemaError(PROVIDER, 'ZR Express returned an oversized page');
    const node = stack.pop();
    if (Array.isArray(node)) {
      if (isElement(node)) {
        const children: unknown[] | undefined = Array.isArray(node[3].children) ? node[3].children : undefined;
        const first = children ? resolved(children[0], rows) : undefined;
        if (children && isElement(first) && typeof first[3].className === 'string' && /^chip(?:\s|$)/.test(first[3].className)) {
          boxes.push([first, ...children.slice(1)]);
        }
        if (typeof node[2] === 'string' && STEP_KEY.test(node[2])) steps.set(node[2], node);
      }
      for (const child of node) stack.push(child);
    } else if (isRecord(node)) {
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return { boxes, steps };
}

interface Step { event: CarrierEvent & { time: string; description: string }; timestamp: number; order: number; code: string }

// A clock the page shows next to the place, such as "26 avr., 20:41".
const SHOWN_CLOCK = /\d{1,2}:\d{2}$/;
const NO_PLACE = /^[—–-]?$/;

/**
 * A step: its state's wording, then its office and the clock the page shows,
 * then a remark. The remark (a scan note or an internal workflow tag) is not
 * kept, and the shown clock is the key's instant.
 */
function projectStep(key: string, element: Element, rows: Map<string, unknown>): Step {
  const [, iso, code, order] = STEP_KEY.exec(key)!;
  const instant = explicitOffsetTime(iso);
  const [wording, place, shown] = textsOf(element[3].children, rows).map((text) => clean(text, 300));
  if (!instant || !wording || place === undefined || !shown || !SHOWN_CLOCK.test(shown)) {
    throw new SchemaError(PROVIDER, 'ZR Express returned an incomplete step');
  }
  const location = NO_PLACE.test(place) ? '' : clean(place, 160);
  return {
    event: { time: instant.iso, description: clean(wording, 200), ...(location ? { location } : {}), provider_code: code! },
    timestamp: instant.timestamp, order: Number(order), code: code!,
  };
}

/**
 * The parcel's steps, newest first. A check-in at an office is an acceptance
 * only before anything else moved the parcel.
 */
function history(steps: Map<string, Element>, rows: Map<string, unknown>): CarrierEvent[] {
  if (steps.size > MAX_STEPS) throw new SchemaError(PROVIDER, 'ZR Express returned an oversized history');
  const oldestFirst = [...steps].map(([key, element]) => projectStep(key, element, rows))
    .sort((left, right) => left.timestamp - right.timestamp || left.order - right.order);
  let moved = false;
  for (const step of oldestFirst) {
    const staged = zrExpressStage(step.code, step.event.description, moved);
    if (staged) Object.assign(step.event, { stage: staged.stage, stage_source: staged.source });
    if (staged && staged.stage !== 'registered' && staged.stage !== 'pending') moved = true;
  }
  return oldestFirst.reverse().map((step) => step.event);
}

/**
 * The React Server Components reply of `zrexpress.net/suivi?tn={number}`. The
 * page answers with a box holding a status chip and the number asked: the
 * parcel's state over its history, "INTROUVABLE" for a number ZR Express does
 * not know, or "INVALID" with a format message for a number it does not take.
 */
export function parseZrExpress(bytes: Uint8Array, contentType: string | null, raw: string): CarrierResult {
  const number = zrExpressRequestNumber(raw);
  const type = (contentType ?? '').toLowerCase();
  if (!bytes.length) throw new IndeterminateError(PROVIDER, 'ZR Express returned an empty tracking reply');
  if (type.includes('text/html') || /^\s*</.test(ascii(bytes.subarray(0, 64)))) {
    throw new ChallengeError(PROVIDER, 'ZR Express answered with a web page instead of tracking data');
  }
  if (!type.includes('text/x-component')) throw new SchemaError(PROVIDER, 'ZR Express returned an unexpected tracking reply');
  const { rows, failures } = flightRows(bytes);
  const { boxes, steps } = scanPage(rows);
  if (!boxes.length) {
    if (failures.some((digest) => NEXT_CONTROL.test(digest))) throw new SchemaError(PROVIDER, 'ZR Express redirected or dropped its tracking page');
    if (failures.length) throw new IndeterminateError(PROVIDER, 'ZR Express could not render the tracking page');
    throw new SchemaError(PROVIDER, 'ZR Express returned no tracking answer');
  }
  if (boxes.length > 1) throw new SchemaError(PROVIDER, 'ZR Express returned several answers');
  const [chip, echo] = boxes[0]!.map((child) => textsOf(child, rows).join('').trim());
  const state = clean(chip, 80).replace(/^●\s*/, '');
  if (state === 'INVALID') throw new InvalidInputError(PROVIDER, 'ZR Express does not take the number', { reason: 'wrong_number' });
  if (!state || echo?.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'ZR Express answered for another number');
  if (state === 'INTROUVABLE') {
    if (steps.size) throw new SchemaError(PROVIDER, 'ZR Express returned a history for a number it does not know');
    throw new NotFoundError(PROVIDER);
  }
  if (!steps.size) throw new SchemaError(PROVIDER, 'ZR Express returned a parcel without its history');

  const events = history(steps, rows);
  const newest = events[0]!;
  const at = events.findIndex((event) => event.stage);
  const current = at < 0 ? undefined : events[at]!;
  const stage = current?.stage as Stage | undefined;
  // The delivery, not the cash collected after it.
  let delivered: CarrierEvent | undefined;
  for (let index = at; stage === 'delivered' && index < events.length && events[index]!.stage === 'delivered'; index += 1) {
    delivered = events[index];
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description ?? null,
    last_update: newest.time ?? null,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

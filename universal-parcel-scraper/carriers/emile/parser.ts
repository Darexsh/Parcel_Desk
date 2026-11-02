import { DateTime } from 'luxon';
import { SaxesParser } from 'saxes';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { emileStage } from './status.js';

export const EMILE_MAX_BYTES = 1_000_000;
const PROVIDER = 'Emile';
interface Node { name: string; uri: string; attributes: Record<string, string>; text: string; children: Node[] }

export function normalizeEmileNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^EM\d{12}(?:\d{4})?CA$/.test(number)) throw new InvalidInputError(PROVIDER, 'Emile requires EM, twelve or sixteen digits and CA');
  return number;
}

/** Preserve the identity attributes while rejecting malformed XML, entities and excessive nesting. */
function document(xml: string): Node | undefined {
  if (new TextEncoder().encode(xml).length > EMILE_MAX_BYTES) return undefined;
  const parser = new SaxesParser({ xmlns: true });
  const stack: Node[] = [];
  let root: Node | undefined, count = 0;
  const invalid = (): never => { throw new SyntaxError('Invalid tracking XML'); };
  parser.on('error', invalid);
  parser.on('doctype', invalid);
  parser.on('opentag', tag => {
    if (++count > 20_000 || stack.length >= 24) invalid();
    const node: Node = { name: tag.local, uri: tag.uri,
      attributes: Object.fromEntries(Object.values(tag.attributes).filter(attribute => !attribute.uri)
        .map(attribute => [attribute.local, attribute.value])), text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) invalid();
    else root = node;
    stack.push(node);
  });
  const text = (value: string) => { if (stack.length) stack.at(-1)!.text += value; };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  try { parser.write(xml).close(); } catch { return undefined; }
  return stack.length ? undefined : root;
}

const children = (node: Node, name: string) => node.children.filter(child => child.name === name && !child.uri);
function scalar(node: Node, name: string, required = false): string {
  const found = children(node, name);
  if (found.length > 1 || found[0]?.children.length || (required && found.length !== 1)) {
    throw new SchemaError(PROVIDER, 'Emile returned an invalid tracking field');
  }
  return found[0]?.text.trim() ?? '';
}

function clock(raw: string, zone: string): { time?: string; local_time?: string; provider_time_text?: string } {
  if (!raw) return {};
  const valid = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(raw)
    && DateTime.fromFormat(raw, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }).isValid;
  if (!valid) return { provider_time_text: clean(raw, 64) };
  const local = raw.replace(' ', 'T');
  const offset = /^GMT([+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(zone)?.[1];
  const instant = offset ? explicitOffsetTime(`${local}${offset}`) : null;
  return instant ? { time: instant.iso } : { local_time: local };
}

export function parseEmileTrackingXml(xml: string, rawNumber: string): CarrierResult {
  const number = normalizeEmileNumber(rawNumber);
  const root = document(xml);
  if (!root || root.name !== 'root' || root.uri) {
    if (/<title>\s*Just a moment|cf-chl-|challenge-platform|cf-turnstile/i.test(xml)) throw new ChallengeError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Emile returned invalid tracking XML');
  }
  const status = scalar(root, 'status', true);
  if (!/^\d+$/.test(status)) throw new SchemaError(PROVIDER, 'Emile returned an invalid response status');
  if (status !== '0') throw new IndeterminateError(PROVIDER, 'Emile tracking returned an unsuccessful response');
  const shipments = children(root, 'tracks');
  if (shipments.length !== 1) throw new SchemaError(PROVIDER, 'Emile did not return one unambiguous parcel');
  const shipment = shipments[0]!;
  const identity = normalizeTrackingNumber(shipment.attributes.barcode ?? '');
  const error = shipment.attributes.error_message ?? '';
  const scans = children(shipment, 'track');
  if (error) {
    // The negative reply has no barcode: bind its explicit error to the whole
    // requested number, and never treat another error or an empty history as absence.
    if ((!identity || identity === number) && !scans.length && error === `Order [${number}] not found trackingevent.`) {
      throw new NotFoundError(PROVIDER);
    }
    if (identity && identity !== number || /Order \[[^\]]+\] not found trackingevent\./.test(error)) {
      throw new SchemaError(PROVIDER, 'Emile returned an error for a different shipment');
    }
    throw new IndeterminateError(PROVIDER, 'Emile returned a tracking error');
  }
  if (identity !== number) throw new SchemaError(PROVIDER, 'Emile returned a different shipment');
  const country = countryCode(shipment.attributes.recipient_country);
  if (country && country !== 'CA') throw new SchemaError(PROVIDER, 'Emile returned a shipment outside its Canadian service');
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'Emile returned no parcel history');
  if (scans.length > 500) throw new SchemaError(PROVIDER, 'Emile returned excessive tracking history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // Both official clients reverse the oldest-first history. Preserve that order
  // when a scan has only a local clock, no clock, or the same clock as another.
  for (const scan of [...scans].reverse()) {
    const description = clean(scalar(scan, 'status_desc', true), 500);
    if (!description) throw new SchemaError(PROVIDER, 'Emile returned a scan without public wording');
    const stage = emileStage(description);
    const code = clean(scalar(scan, 'track_point_code'), 40);
    const location = [clean(scalar(scan, 'city'), 100), clean(scalar(scan, 'province'), 100)].filter(Boolean).join(', ');
    // The waybill label embeds the upstream reference. Keep the milestone alone.
    // Remarks, event_info, postcodes, phone numbers and proof images are omitted.
    const event: CarrierEvent = { description: /^waybill generated for [a-z0-9]+$/i.test(description) ? 'Waybill Generated' : description,
      ...clock(scalar(scan, 'date'), scalar(scan, 'time_zone')), ...(location ? { location } : {}),
      ...(code ? { provider_code: code } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!;
  // Notification and billing entries leave the last actual milestone in place.
  const stage = events.find(event => event.stage && event.stage !== 'pending')?.stage as ReturnType<typeof emileStage>;
  const delivery = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: null, ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(country ? { destination_country: country } : {}), ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}

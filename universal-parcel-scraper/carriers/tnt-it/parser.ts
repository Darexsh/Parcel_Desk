import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { normalizeTntItalyNumber } from './number.js';
import { tntItalyStage } from './status.js';

export { normalizeTntItalyNumber };

export const PROVIDER = 'TNT Italy';
// A reply is padded with blanks to some tens of kilobytes.
export const TNT_ITALY_MAX_BYTES = 512 * 1024;
// Every scan is at an Italian depot.
const ZONE = 'Europe/Rome';
// The reply names its DTD by a relative path; only that declaration is dropped before parsing.
const DOCTYPE = /^(\s*<\?xml[^>]*\?>\s*)<!DOCTYPE ResultSet SYSTEM "traOU\.dtd">/;
// Akamai's refusal and bot checks that can come instead of the reply.
const CHALLENGE = /<title>\s*Access Denied|errors\.edgesuite\.net|_abck|bm-verify|sec-if-cpt|captcha/i;
// "Nessun dato rientra nei criteri di scelta": the tracker's own answer for a number it does not know.
const NOT_FOUND = '00015';
// The page sends the visitor to fedex.com for a shipment FedEx carries.
const FEDEX = '40000';
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name && !child.uri);
}

/** A leaf's text; a field with markup inside, or given twice, is a changed reply. */
function field(node: XmlNode, name: string, maxLength = 300): string {
  const found = children(node, name);
  if (found.length > 1 || found[0]?.children.length) throw new SchemaError(PROVIDER, `TNT Italy returned a malformed ${name}`);
  return clean(found[0]?.text ?? '', maxLength);
}

interface Scan { event: CarrierEvent; timestamp: number; index: number }

/**
 * One consignment's scans, newest first. Each is a depot's wall clock in
 * Italy, to the minute, with a day that drops its leading zero. The depot is
 * the location when the reply marks it for display.
 */
function history(consignment: XmlNode): Scan[] {
  const rows = children(consignment, 'StatusDetails');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TNT Italy returned an oversized history');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const code = field(row, 'StatusCode', 16).toUpperCase();
    const description = field(row, 'StatusDescription');
    const time = zonedTime(`${field(row, 'StatusDate', 16)} ${field(row, 'StatusTime', 16)}`, 'd/M/yyyy H:mm', ZONE);
    if (!description || !time) throw new SchemaError(PROVIDER, 'TNT Italy returned an incomplete scan');
    const location = field(row, 'TrackingDisplayDepot', 4) === 'Y' ? field(row, 'Depot', 120) : '';
    const key = JSON.stringify([time.iso, code, description, location]);
    if (seen.has(key)) return;
    seen.add(key);
    const stage = code ? tntItalyStage(code) : undefined;
    scans.push({ event: {
      time: time.iso, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    }, timestamp: time.timestamp, index });
  });
  return scans.sort((a, b) => b.timestamp - a.timestamp || a.index - b.index);
}

/** Why the tracker answered without a shipment. */
function refusal(error: XmlNode): never {
  const code = field(error, 'Code', 16);
  if (code === NOT_FOUND) throw new NotFoundError(PROVIDER);
  if (code === FEDEX) throw new IndeterminateError(PROVIDER, 'TNT Italy sends this shipment to FedEx\'s tracker');
  throw new IndeterminateError(PROVIDER, `TNT Italy answered with error ${code || 'without a code'}`);
}

/**
 * The XML tnt.it's tracking page reads for one waybill. A number it does not
 * know is error 00015. Waybills are reused: every consignment with the number
 * is listed, and the one with the most recent scan is the parcel.
 */
export function parseTntItaly(xml: string, raw: string): CarrierResult {
  const number = normalizeTntItalyNumber(raw);
  const root = xmlDocument(xml.replace(DOCTYPE, '$1'), TNT_ITALY_MAX_BYTES);
  if (!root || root.name !== 'ResultSet' || root.uri) {
    if (CHALLENGE.test(xml.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TNT Italy answered with a browser check');
    throw new SchemaError(PROVIDER, 'TNT Italy returned a reply that is not its tracking XML');
  }
  const consignments = children(root, 'Consignment');
  const errors = children(root, 'RuntimeError');
  if (!consignments.length) {
    if (errors.length === 1) refusal(errors[0]!);
    throw new SchemaError(PROVIDER, 'TNT Italy returned neither a shipment nor an error');
  }
  if (consignments.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'TNT Italy returned excessive shipments');
  const shipments = consignments
    .filter((consignment) => normalizeTrackingNumber(field(consignment, 'ConNo', 64)) === number)
    .map((consignment) => ({ consignment, scans: history(consignment) }));
  if (!shipments.length) throw new SchemaError(PROVIDER, 'TNT Italy answered for another shipment');
  const newest = ({ scans }: { scans: Scan[] }) => scans[0]?.timestamp ?? -Infinity;
  const { consignment, scans } = shipments.reduce((best, shipment) => newest(shipment) > newest(best) ? shipment : best);
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'TNT Italy lists the shipment without scans');

  const events = scans.map(({ event }) => event);
  const latest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  // The delivery's own clock, to the second; the delivery scan can be a minute apart.
  const delivered = stage === 'delivered' ? zonedTime(field(consignment, 'DeliveryDate', 32), 'd/M/yyyy, H:mm:ss', ZONE) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.iso } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

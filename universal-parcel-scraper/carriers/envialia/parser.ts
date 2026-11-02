import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { envialiaStatus } from './status.js';

export const PROVIDER = 'Envialia';
export const ENVIALIA_MAX_BYTES = 64_000;
const SOAP = 'http://www.w3.org/2003/05/soap-envelope';
export const ENVIALIA_NAMESPACE = 'http://servicio.envialiamobileservice.dinaprise.com';
const ENTITIES = 'http://entidades.recursos.envialiamobileservice.dinaprise.com/xsd';
const MAX_RETURNS = 20;
// Imperva fronts the service host.
const BLOCKED = /_Incapsula_Resource|Incapsula incident|<title>\s*(?:Request Rejected|Access Denied)/i;

/**
 * The official app searches a tracking number only when it has sixteen characters: the
 * six-digit agency code followed by the ten-digit consignment note, as the app prints it.
 */
export function normalizeEnvialiaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{16}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Envialia tracking numbers are sixteen digits');
  return number;
}

function children(node: XmlNode, name: string, uri: string): XmlNode[] {
  return node.children.filter(child => child.name === name && child.uri === uri);
}

/** One text field of a shipment; a field the reply repeats or nests is malformed. */
function field(shipment: XmlNode, name: string): string {
  const found = children(shipment, name, ENTITIES);
  if (found.length > 1 || found[0]?.children.length) throw new SchemaError(PROVIDER, 'Envialia returned an invalid shipment field');
  return found[0]?.text.trim() ?? '';
}

/** A day the reply prints as dd/MM/yyyy. */
function day(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

// The app calls the date the network's target day. The old web page showed it as the
// estimated delivery while the shipment was open, and as a bare date once it had ended.
const ON_THE_WAY = new Set<Stage>(['registered', 'accepted', 'in_transit', 'out_for_delivery']);

/**
 * The app's guest status reply. Only the agencies, the consignment note, the state and
 * the target day are read: the reply also names the destination postcode and town, the
 * sender's reference, the delivering agency's contacts and a shipment key, which stay out.
 */
export function parseEnvialiaStatusXml(xml: string, rawNumber: string): CarrierResult {
  const number = normalizeEnvialiaNumber(rawNumber);
  const root = xmlDocument(xml, ENVIALIA_MAX_BYTES);
  if (!root || root.name !== 'Envelope' || root.uri !== SOAP) {
    if (BLOCKED.test(xml.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Envialia answered with a block page');
    throw new SchemaError(PROVIDER, 'Envialia returned invalid tracking XML');
  }
  const bodies = children(root, 'Body', SOAP);
  if (bodies.length !== 1) throw new SchemaError(PROVIDER, 'Envialia returned an invalid SOAP envelope');
  const body = bodies[0]!;
  if (children(body, 'Fault', SOAP).length) throw new IndeterminateError(PROVIDER, 'Envialia tracking returned a SOAP fault');
  const response = children(body, 'buscarEstadoEnvio2Response', ENVIALIA_NAMESPACE);
  if (response.length !== 1 || body.children.length !== 1) throw new SchemaError(PROVIDER, 'Envialia returned an unexpected tracking reply');
  const returns = response[0]!.children;
  if (returns.some(item => item.name !== 'return' || item.uri !== ENVIALIA_NAMESPACE) || returns.length > MAX_RETURNS) {
    throw new SchemaError(PROVIDER, 'Envialia returned an unexpected tracking reply');
  }
  // The service leaves the reply empty for a tracking number it does not know.
  if (!returns.length) throw new NotFoundError(PROVIDER);
  // A nil return is its answer to a search it could not run, such as a malformed number.
  if (returns.some(item => !item.children.length)) throw new IndeterminateError(PROVIDER, 'Envialia could not run the search');

  // A number is an agency code and a consignment note. The app prints the agency in
  // charge; the origin agency, the same in every reply seen, names the shipment too.
  const agency = number.slice(0, 6);
  const note = number.slice(6);
  const matches = returns.filter(item => field(item, 'strAlbaran') === note
    && (field(item, 'strAgeCargo') === agency || field(item, 'strAgeOrigen') === agency));
  if (matches.length !== 1) throw new SchemaError(PROVIDER, 'Envialia did not identify one matching shipment');
  const shipment = matches[0]!;

  const code = field(shipment, 'strCodEstado');
  if (code && !/^\d{1,3}$/.test(code)) throw new SchemaError(PROVIDER, 'Envialia returned an invalid state code');
  const known = envialiaStatus(code);
  const wording = clean(field(shipment, 'strDesEstado'), 160) || known.wording || '';
  if (!code && !wording) throw new SchemaError(PROVIDER, 'Envialia returned a shipment without a state');
  const stage = known.stage;
  const target = stage && ON_THE_WAY.has(stage) ? day(field(shipment, 'strFechaEnt')) : null;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: wording || code,
    ...(code ? { provider_code: code } : {}),
    summary_only: true,
    last_update: null,
    expected_delivery: target,
    events: [],
  };
}

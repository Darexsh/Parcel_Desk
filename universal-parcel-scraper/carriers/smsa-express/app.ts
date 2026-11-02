import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { normalizeSmsaNumber, PROVIDER, SMSA_BLOCKED, SMSA_MAX_SCANS, smsaWording } from './parser.js';
import { smsaStage } from './status.js';

/** The tracking service of SMSA's Android app, which answers plain HTTP only. */
export const SMSA_APP_ENDPOINT = 'http://strack.cloudapp.net/trackSMSA.svc';
export const SMSA_APP_ACTION = 'http://smsaexpress.com/track/ITrack/AllTrackDetails';
// A reply is a few kilobytes; a long history stays well under this.
export const SMSA_APP_MAX_BYTES = 256_000;
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const TRACK = 'http://smsaexpress.com/track/';
const ROLE = 'http://schemas.datacontract.org/2004/07/TrackRole';
// The guest login every install of the app sends.
const APP_LOGIN = { username: 'smsamobile', password: 'gf343s$a' }; // gitleaks:allow
const DONE = /^Successfully Done!?$/;
// "Your AirWaybill Number {number} is not valid SMSA AirWaybill Number."
const INVALID = /^Your AirWaybill Number (\S{1,64}) is not valid SMSA AirWaybill Number\.?$/;
const REFUSED = /^Username or password is not correct/;
const ESTIMATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const WEIGHT = /^\d{1,6}(?:\.\d{1,3})?$/;
const CODE = /^[A-Za-z0-9-]{1,20}$/;
// The fields a known shipment fills in; an unknown one names only the number.
const SHIPMENT_FIELDS = ['EDD', 'ShipDate', 'ShipmentDestCity', 'ShipmentDestCountry', 'ShipmentOriginCity', 'ShipmentOriginCountry',
  'ShipmentPieces', 'ShipmentWeight'];

/** The app's request for one airway bill's details and scans, in English. */
export function smsaAppRequest(raw: string): string {
  const number = normalizeSmsaNumber(raw);
  return '<?xml version="1.0" encoding="utf-8"?>'
    + `<soap:Envelope xmlns:soap="${SOAP}"><soap:Body><AllTrackDetails xmlns="${TRACK}"><RequestData>`
    + `<AWB>${number}</AWB><Language>en</Language>`
    + `<Password>${APP_LOGIN.password}</Password><Username>${APP_LOGIN.username}</Username>`
    + '</RequestData></AllTrackDetails></soap:Body></soap:Envelope>';
}

function only(node: XmlNode | undefined, name: string, uri: string): XmlNode | undefined {
  const found = node?.children.filter((child) => child.name === name && child.uri === uri) ?? [];
  return found.length === 1 ? found[0] : undefined;
}

function text(node: XmlNode | undefined, name: string, uri: string, max = 200): string {
  return clean(only(node, name, uri)?.text ?? '', max);
}

/** The estimate, which the app sends as `10/3/2026`, month first. */
function estimate(value: string): string | null {
  const match = ESTIMATE.exec(value);
  return match ? calendarDay(Number(match[3]), Number(match[1]), Number(match[2])) : null;
}

/**
 * The app's reply for one airway bill: the shipment's details and its scans,
 * newest first, each with SMSA's code and an instant with an offset. The
 * details must name the airway bill asked. Names, references, the delivery
 * code and the scans' comments, which can hold a phone number, are dropped.
 */
export function parseSmsaApp(xml: string, raw: string): CarrierResult {
  const number = normalizeSmsaNumber(raw);
  const root = xmlDocument(xml, SMSA_APP_MAX_BYTES);
  const body = root?.name === 'Envelope' && root.uri === SOAP ? only(root, 'Body', SOAP) : undefined;
  if (!body) {
    if (SMSA_BLOCKED.test(xml.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SMSA answered with a block page');
    throw new SchemaError(PROVIDER, 'SMSA\'s app service did not return a SOAP reply');
  }
  const result = only(only(body, 'AllTrackDetailsResponse', TRACK), 'AllTrackDetailsResult', TRACK);
  if (!result) {
    if (only(body, 'Fault', SOAP)) throw new IndeterminateError(PROVIDER, 'SMSA\'s app service returned a fault');
    throw new SchemaError(PROVIDER, 'SMSA\'s app service changed its reply');
  }

  const status = text(result, 'RequestStatus', TRACK, 300);
  if (!DONE.test(status)) {
    const invalid = INVALID.exec(status);
    if (invalid) {
      if (normalizeTrackingNumber(invalid[1]!) !== number) throw new IndeterminateError(PROVIDER, 'SMSA answered for another airway bill');
      throw new NotFoundError(PROVIDER, 'SMSA does not know this airway bill');
    }
    if (REFUSED.test(status)) throw new TransportError(PROVIDER, 'SMSA\'s app service refused the app\'s login');
    throw new IndeterminateError(PROVIDER, 'SMSA\'s app service answered with a notice');
  }

  const details = only(result, 'ShipmentDetails', TRACK);
  const airwayBill = text(details, 'AirWaybill', TRACK);
  if (!/^\d{6,20}$/.test(airwayBill)) throw new SchemaError(PROVIDER, 'SMSA did not name the airway bill');
  if (airwayBill !== number) throw new IndeterminateError(PROVIDER, 'SMSA answered for another airway bill');
  const list = only(result, 'TrackingDetailsList', TRACK);
  if (!list) throw new SchemaError(PROVIDER, 'SMSA\'s app service changed its reply');
  const scans = list.children.filter((child) => child.name === 'TrackingDetails' && child.uri === ROLE);
  if (scans.length !== list.children.length) throw new SchemaError(PROVIDER, 'SMSA\'s app service changed its reply');
  if (scans.length > SMSA_MAX_SCANS) throw new SchemaError(PROVIDER, 'SMSA returned too many scans');

  const dated: { event: CarrierEvent; timestamp: number }[] = [];
  const seen = new Set<string>();
  for (const scan of scans) {
    const description = smsaWording(text(scan, 'EventDesc', ROLE, 300));
    const time = explicitOffsetTime(text(scan, 'EventTime', ROLE, 64));
    if (!description || !time) throw new SchemaError(PROVIDER, 'SMSA returned a scan without a time or wording');
    const location = text(scan, 'Office', ROLE, 120);
    const rawCode = text(scan, 'StatusCode', ROLE, 40);
    const code = CODE.test(rawCode) ? rawCode : '';
    const identity = JSON.stringify([time.timestamp, code, description, location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const staged = smsaStage(description);
    dated.push({ timestamp: time.timestamp, event: {
      time: time.iso,
      description,
      ...(location ? { location } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!dated.length) {
    if (SHIPMENT_FIELDS.some((field) => text(details, field, TRACK))) throw new NoHistoryError(PROVIDER);
    // SMSA's answer for an airway bill it has no record of: the number and nothing else.
    throw new NotFoundError(PROVIDER);
  }
  // Newest first, as the app lists them; scans at the same minute keep its order.
  const events = dated.sort((left, right) => right.timestamp - left.timestamp).map(({ event }) => event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const done = stage === 'delivered' || stage === 'returned';
  const weight = text(details, 'ShipmentWeight', TRACK, 20);
  const kilograms = WEIGHT.test(weight) ? Number(weight) : 0;
  const country = countryCode(text(details, 'ShipmentDestCountry', TRACK, 20));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: done ? null : estimate(text(details, 'EDD', TRACK, 20)),
    ...(kilograms > 0 ? { weight_kg: kilograms } : {}),
    ...(country ? { destination_country: country } : {}),
    events,
  };
}

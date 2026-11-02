import { CarrierError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { lbcHistory, normalizeLbcNumber } from './parser.js';

export const LBC_MOBILE_API = 'https://lbcapigateway.lbcapps.com/lbctrackingapi2/v2';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE = 'http://tempuri.org/';
const MAX_BYTES = 1_000_000;
// Shared guest-tracking application key, distributed with the maintainer's approval.
const APPLICATION_KEY = '4dc2cebad70043c79346dc66d5a94fa8';

function invalidXml(): never { throw new SchemaError('lbc-express', 'LBC returned invalid tracking XML'); }

function children(node: XmlNode, name: string, uri = SERVICE): XmlNode[] {
  return node.children.filter(child => child.name === name && child.uri === uri);
}

function one(node: XmlNode, name: string, uri = SERVICE): XmlNode {
  const matches = children(node, name, uri);
  if (matches.length !== 1) invalidXml();
  return matches[0]!;
}

function scalar(node: XmlNode, name: string, required = true, max = 1000): string {
  const matches = children(node, name);
  if (matches.length > 1 || (!matches.length && required)) invalidXml();
  if (!matches.length) return '';
  if (matches[0]!.children.length) invalidXml();
  const value = clean(matches[0]!.text, max);
  if (required && !value) invalidXml();
  return value;
}

export function parseLbcMobile(xml: string, raw: string): CarrierResult {
  const number = normalizeLbcNumber(raw);
  const root = xmlDocument(xml, MAX_BYTES) ?? invalidXml();
  if (root.name !== 'Envelope' || root.uri !== SOAP) invalidXml();
  const body = one(root, 'Body', SOAP);
  if (children(body, 'Fault', SOAP).length) throw new IndeterminateError('lbc-express', 'LBC returned a tracking service fault');
  const response = one(body, 'LBCTrackAndTraceResponse');
  const result = one(response, 'LBCTrackAndTraceResult');
  const status = one(result, 'TrackingStatus');
  const code = scalar(status, 'StatusCode', true, 16);
  // Remittances and unbound service errors do not establish parcel absence.
  if (code !== '0001') throw new IndeterminateError('lbc-express', 'LBC returned no confirmed parcel history');
  const details = one(one(status, 'TrackingDetails'), 'TrackingDetails');
  if (scalar(details, 'TrackingNo', true, 40) !== number) {
    throw new SchemaError('lbc-express', 'LBC returned a different shipment');
  }
  return lbcHistory(children(one(status, 'TrackingHistory'), 'TrackingHistory').map(row => ({
    code: scalar(row, 'StatusId', true, 32), wording: scalar(row, 'StatusandLocation'),
    day: scalar(row, 'DatePosted', true, 64), time: scalar(row, 'DatePostedTime', false, 64),
    town: scalar(row, 'CityName', false, 120), province: scalar(row, 'ProvinceName', false, 120),
  })));
}

export async function readLbcMobile(number: string, options: {
  fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal; timeoutMs: number;
}): Promise<CarrierResult> {
  const normalized = normalizeLbcNumber(number);
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${SOAP}"><soap:Body><LBCTrackAndTrace xmlns="${SERVICE}"><TrackingNo>${normalized}</TrackingNo></LBCTrackAndTrace></soap:Body></soap:Envelope>`;
  try {
    const { response, bytes } = await fetchBounded(LBC_MOBILE_API, { method: 'POST', signal: options.signal, body,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${SERVICE}LBCTrackAndTrace`,
        Accept: 'text/xml', lbcOAKey: APPLICATION_KEY, 'User-Agent': userAgentOf(options.userAgent) } }, {
      provider: 'lbc-express', maxBytes: MAX_BYTES, timeoutMs: options.timeoutMs, fetcher: options.fetcher,
      allowHttpStatuses: [401, 403, 404, 410],
    });
    const xml = decodeText(bytes);
    if (/<(?:html|!doctype html)\b/i.test(xml) && /DNS points to prohibited IP/i.test(xml) && /\bCloudflare\b/i.test(xml)) {
      throw new TransportError('lbc-express', 'LBC tracking API origin is unavailable', {
        status: response.status >= 400 ? response.status : undefined,
      });
    }
    if ([401, 403].includes(response.status)) throw new ChallengeError('lbc-express', 'LBC refused the tracking API credential');
    if ([404, 410].includes(response.status)) throw new TransportError('lbc-express', 'LBC tracking API is unavailable', { status: response.status });
    if (/<(?:html|!doctype html)\b/i.test(xml) && /captcha|cloudflare|access denied|challenge/i.test(xml)) throw new ChallengeError('lbc-express');
    if (response.status !== 200) throw new UpstreamHttpError('lbc-express', response.status);
    return parseLbcMobile(xml, normalized);
  } catch (error) {
    options.signal.throwIfAborted();
    // Transport diagnostics include the key, barcode and possibly recipient XML.
    // Preserve the failure contract without forwarding request/body data or causes.
    if (error instanceof CarrierError) throw new CarrierError(error.kind, 'lbc-express', `LBC tracking failed (${error.kind})`, {
      status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
    });
    throw new TransportError('lbc-express', 'LBC tracking API request failed');
  }
}

import { normalizeTrackingNumber } from '../detection/index.js';

const PLANZER_SHARED_HOST = 'trackandtrace.planzergroup.com';
const PLANZER_SHARED_PATH = /^\/shared\/sendungen\/([^/]+)\/?$/;
const PLANZER_ACCESS_KEY = /^[A-Za-z0-9_-]{32,256}$/;
const DACHSER_HOST = 'customeriberia.dachser.com';
const DACHSER_PAGE_PATH = '/customerarea/utilidades/seguimiento-publico/detalle';
const INSTABOX_PATH = /^\/[a-z]{2}(?:-[A-Z]{2})?\/([A-Z0-9]{4,40})(?:\/locker-to-locker-recipient)?\/?$/i;
const CAPABILITY_VALUE = /^[A-Za-z0-9_-]{4,256}$/;
// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const ALLOWED_QUERY_KEYS = new Set([
  'hash',
  'cliente',
  'numeroUnico',
  'referencia',
  'fecha',
  'clave',
  'user',
  'idioma',
  'expedicion',
  'tipoMail',
  'error',
  'origen',
  'usuario',
]);

/** An Instabox recipient's notification link, bound to its complete parcel identifier. */
export function validateInstaboxTrackingUrl(rawUrl: string, trackingNumber: string): string {
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { throw new TypeError('Paste the complete Instabox notification URL'); }
  if (rawUrl.length > 4096 || url.protocol !== 'https:' || url.hostname !== 'track.instabox.com'
    || url.username || url.password || (url.port && url.port !== '443') || url.hash) {
    throw new TypeError('Instabox notification links must use https://track.instabox.com');
  }
  const match = INSTABOX_PATH.exec(url.pathname);
  if (!match || match[1]!.toUpperCase() !== normalizeTrackingNumber(trackingNumber)) {
    throw new TypeError('The Instabox URL must name this complete parcel identifier');
  }
  const codes = [...url.searchParams].filter(([key]) => key === 'authCode' || key === 'c');
  if (codes.length !== 1 || !/^[A-Za-z0-9_-]{16,160}$/.test(codes[0]![1])) {
    throw new TypeError('The Instabox notification URL must include its verification code');
  }
  for (const [key, value] of url.searchParams) {
    if (!['authCode', 'c'].includes(key) && (!/^utm_(?:source|medium|campaign|content|term)$/.test(key) || value.length > 256)) {
      throw new TypeError('The Instabox URL contains an unsupported parameter');
    }
  }
  url.pathname = url.pathname.replace(match[1]!, normalizeTrackingNumber(trackingNumber));
  url.search = new URLSearchParams([codes[0]!]).toString();
  return url.toString();
}

// The Freightways networks' domains. Their receiver sites and older ITNG
// servlet look a customer printed label up with the sender's account.
const FREIGHTWAYS_DOMAINS: Readonly<Record<string, string>> = {
  'nz-couriers': 'nzcouriers.co.nz',
  'post-haste': 'posthaste.co.nz',
  'castle-parcels': 'castleparcels.co.nz',
  'now-couriers': 'nowcouriers.co.nz',
};
const FREIGHTWAYS_SERVLET = /^\/[a-z]+\/servlet\/ITNG_TAndTServlet\/?$/i;
// A customer printed label's composite id: its consignment number, a letter,
// the sender's account and a count.
const FREIGHTWAYS_COMPOSITE = /^CU\.\.([A-Z0-9]{4,40})\.([A-Z0-9])\.([A-Z0-9]{3,16})\.(\d{1,3})$/i;
const FREIGHTWAYS_ACCOUNT = /^[A-Z0-9]{3,16}$/i;

/** A Freightways link that names a customer printed label with its sender's account. */
export interface FreightwaysTrackingLink {
  /** The link on the network's receiver site. */
  url: string;
  /** The sender's account. */
  account: string;
  /** The consignment number, which is the tracking number. */
  consignment: string;
}

/**
 * Read a Freightways network's link that names the sender's account beside a
 * customer printed label's consignment number: the receiver site's
 * `?consignmentid=CU..{consignment}.{letter}.{account}.{n}`, or its or the ITNG
 * servlet's `customer_number` (or `customer_id`) and `consignment_id` (or
 * `consignment_id_ref`). The link is bound to the network's domain and to the
 * complete tracking number, and kept as a receiver site link.
 */
export function readFreightwaysTrackingUrl(rawUrl: string, trackingNumber: string, carrierId: string): FreightwaysTrackingLink {
  const domain = FREIGHTWAYS_DOMAINS[carrierId];
  if (!domain) throw new TypeError('This carrier takes no Freightways tracking link');
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { throw new TypeError('Paste the complete tracking link'); }
  const host = url.hostname.toLowerCase();
  if (rawUrl.length > 4096 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || (host !== domain && !host.endsWith(`.${domain}`))) {
    throw new TypeError(`The tracking link must be on ${domain}`);
  }
  const receiver = host === `receiver.${domain}` && /^\/?$/.test(url.pathname);
  if (!receiver && !FREIGHTWAYS_SERVLET.test(url.pathname)) throw new TypeError('Paste the receiver link from the shipping email');
  /** A parameter by any of its names, whatever their case; two different values are refused. */
  const param = (...names: string[]) => {
    const values = new Set([...url.searchParams].filter(([key]) => names.includes(key.toLowerCase())).map(([, value]) => value.trim()));
    if (values.size > 1) throw new TypeError('The tracking link names two consignments');
    return [...values][0];
  };
  const number = normalizeTrackingNumber(trackingNumber);
  if (!/^[A-Z0-9]{4,40}$/.test(number)) throw new TypeError('The tracking link belongs to a different tracking number');
  const composite = receiver ? param('consignmentid') : undefined;
  if (composite) {
    const parts = FREIGHTWAYS_COMPOSITE.exec(composite);
    if (!parts) throw new TypeError('The tracking link must name the sender’s account');
    if (normalizeTrackingNumber(parts[1]!) !== number) throw new TypeError('The tracking link belongs to a different tracking number');
    const account = parts[3]!.toUpperCase();
    return { url: `https://receiver.${domain}/?consignmentid=CU..${number}.${parts[2]!.toUpperCase()}.${account}.${parts[4]}`,
      account, consignment: number };
  }
  const account = param('customer_number', 'customer_id');
  const consignment = param('consignment_id', 'consignment_id_ref');
  if (!account || !consignment || !FREIGHTWAYS_ACCOUNT.test(account)) throw new TypeError('The tracking link must name the sender’s account');
  if (normalizeTrackingNumber(consignment) !== number) throw new TypeError('The tracking link belongs to a different tracking number');
  return { url: `https://receiver.${domain}/?request_id=3&customer_number=${account.toUpperCase()}&consignment_id=${number}`,
    account: account.toUpperCase(), consignment: number };
}

/** A Freightways network's link with the sender's account, as the receiver site link it keeps. */
export function validateFreightwaysTrackingUrl(rawUrl: string, trackingNumber: string, carrierId: string): string {
  return readFreightwaysTrackingUrl(rawUrl, trackingNumber, carrierId).url;
}

export function validatePlanzerSharedUrl(rawUrl: string, trackingNumber: string): string {
  const value = rawUrl.trim();
  if (value.length < 1 || value.length > 4_096) {
    throw new TypeError('Paste the complete Planzer tracking URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError('Paste a valid Planzer tracking URL', { cause: error });
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== PLANZER_SHARED_HOST
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || url.hash
  ) {
    throw new TypeError(`Planzer shared links must use https://${PLANZER_SHARED_HOST}`);
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new TypeError('Paste a valid Planzer tracking URL', { cause: error });
  }
  const match = PLANZER_SHARED_PATH.exec(pathname);
  if (!match) throw new TypeError('Paste a Planzer shared shipment URL');
  if (normalizeTrackingNumber(match[1]!) !== normalizeTrackingNumber(trackingNumber)) {
    throw new TypeError('The Planzer URL belongs to a different tracking number');
  }
  const accessKeys = url.searchParams.getAll('accessKey');
  if (accessKeys.length !== 1 || !PLANZER_ACCESS_KEY.test(accessKeys[0]!)) {
    throw new TypeError('The Planzer URL must include its accessKey');
  }
  return url.toString();
}

export function validateDachserTrackingUrl(rawUrl: string, trackingNumber: string): string {
  const value = rawUrl.trim();
  if (value.length < 1 || value.length > 4_096) {
    throw new TypeError('Paste the complete Dachser tracking URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError('Paste a valid Dachser tracking URL', { cause: error });
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== DACHSER_HOST
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || url.hash
  ) throw new TypeError(`Dachser links must use https://${DACHSER_HOST}`);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    throw new TypeError('Paste a valid Dachser tracking URL', { cause: error });
  }
  if (pathname !== DACHSER_PAGE_PATH && pathname !== `${DACHSER_PAGE_PATH}/`) {
    throw new TypeError('Paste a Dachser public shipment detail URL');
  }

  const values = new Map<string, string>();
  for (const [name, parameter] of url.searchParams) {
    if (!ALLOWED_QUERY_KEYS.has(name)) {
      throw new TypeError('The Dachser URL contains an unsupported parameter');
    }
    if (values.has(name)) throw new TypeError('The Dachser URL contains a duplicate parameter');
    if (!parameter || parameter.length > 256 || CONTROL_CHARACTER.test(parameter)) {
      throw new TypeError('The Dachser URL contains an invalid parameter');
    }
    values.set(name, parameter);
  }
  const uniqueNumber = values.get('numeroUnico');
  if (!uniqueNumber) throw new TypeError('The Dachser URL must include its shipment number');
  if (normalizeTrackingNumber(uniqueNumber) !== normalizeTrackingNumber(trackingNumber)) {
    throw new TypeError('The Dachser URL belongs to a different tracking number');
  }
  const capabilityHash = values.get('hash');
  const capabilityKey = values.get('clave');
  const capabilityDate = values.get('fecha');
  const hasHash = Boolean(capabilityHash && CAPABILITY_VALUE.test(capabilityHash));
  const hasKey = Boolean(
    capabilityKey
    && capabilityDate
    && CAPABILITY_VALUE.test(capabilityKey)
    && /^\d{8}$/.test(capabilityDate),
  );
  if (!hasHash && !hasKey) {
    throw new TypeError('The Dachser URL must include its access parameters');
  }
  url.protocol = 'https:';
  url.hostname = DACHSER_HOST;
  url.port = '';
  return url.toString();
}

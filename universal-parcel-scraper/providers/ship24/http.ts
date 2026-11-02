
/**
 * The signed requests the public Ship24 web app makes for one parcel.
 *
 * The website builds `x-ship24-token` from a timestamp, an opaque digest, a
 * MurmurHash3 checksum bound to the tracking number and an HMAC over the
 * three. Its refresh request carries a second token, the bytes of the
 * timestamp and the number between three of the same marker characters. The
 * constants below are public frontend configuration read from the site's own
 * script, not a provisioned API credential: no account, cookie, browser
 * fingerprint or issued token is involved. See README.md.
 */
import { createHash, createHmac } from 'node:crypto';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { InvalidInputError, NotFoundError, UpstreamHttpError } from '../../core/errors/index.js';
import { isRecord } from '../../core/types.js';

const PAGE = 'https://www.ship24.com/tracking';
const API = 'https://api.ship24.com/api/parcels';
// Public website checksum configuration, not a provisioned API credential,
// read from the site's main bundle (cdn.ship24.com/assets/main.<hash>.js,
// named in the tracking page's HTML; the hash changes with each deploy): the
// HMAC key that signs getOneParcel's token, and the first of the three values
// the bundle appends to $zoho_.
const WEBSITE_SIGNING_KEY = "qxV6SOr2tqw9m36j0-R-ohPt1PAB2et0"; // gitleaks:allow -- public frontend checksum constant, not an API credential
const WEBSITE_SALT = '\u1780';
// The other two values appended to $zoho_, which getWithCrawlerAuth's token
// uses, in the same bundle.
const REFRESH_MARKERS = ['\u1781', '\u1782'] as const;

// Standard MurmurHash3 x86/32, used by the public frontend's request checksum.
export function ship24Checksum(text: string): number {
  const bytes = Buffer.from(text);
  let hash = 0;
  let offset = 0;
  const mix = (value: number) => {
    value = Math.imul(value, 0xcc9e2d51);
    value = value << 15 | value >>> 17;
    return Math.imul(value, 0x1b873593);
  };
  for (; offset + 4 <= bytes.length; offset += 4) {
    hash ^= mix(bytes.readUInt32LE(offset));
    hash = hash << 13 | hash >>> 19;
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }
  let tail = 0;
  for (let index = offset; index < bytes.length; index++) tail |= bytes[index]! << ((index - offset) * 8);
  if (offset < bytes.length) hash ^= mix(tail);
  hash ^= bytes.length;
  hash = Math.imul(hash ^ hash >>> 16, 0x85ebca6b);
  hash = Math.imul(hash ^ hash >>> 13, 0xc2b2ae35);
  return (hash ^ hash >>> 16) >>> 0;
}

function token(number: string): string {
  const timestamp = Date.now();
  // The anonymous endpoint accepts an opaque digest; a browser fingerprint is
  // unnecessary. Verified with fresh Node-only requests in the production container.
  const digest = createHash('sha256').update(`delivery-tracker|en-US|${timestamp}`).digest('hex');
  const encoded = Buffer.from(JSON.stringify({
    a: ship24Checksum(number + timestamp + digest.length + WEBSITE_SALT), b: timestamp, c: digest,
  })).toString('base64');
  return `${encoded}.${createHmac('sha256', WEBSITE_SIGNING_KEY).update(encoded).digest('hex')}`;
}

/**
 * The refresh token: the UTF-8 bytes of the salt, the time, the second marker,
 * the number and the first marker, comma-separated, with the second byte and
 * the one before last set to 150, written as decimal bytes.
 */
export function refreshToken(number: string, timestamp = Date.now()): string {
  const bytes = Buffer.from([WEBSITE_SALT, timestamp, REFRESH_MARKERS[1], number, REFRESH_MARKERS[0]].join(','));
  bytes[1] = 150;
  bytes[bytes.length - 2] = 150;
  return [...bytes].join(',');
}

// Ship24's parcel id, a UUID.
const PARCEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A code of Ship24's public courier list ("dpd-pl", "4px").
const COURIER_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The 404 message for a courier whose parcels Ship24 shows its subscribers only: "UPS is not available for website."
const SUBSCRIBER_ONLY = /^[^\n]{1,100} is not available for website\.?$/;

/**
 * A 404 for a courier Ship24 shows its subscribers only, read from the reply's
 * diagnostics. The courier's name is provider prose and stays out of the error.
 */
function subscriberOnly(error: unknown): NotFoundError | null {
  if (!(error instanceof UpstreamHttpError) || error.status !== 404 || error.diagnostics?.body_read !== 'complete') return null;
  try {
    const reply: unknown = JSON.parse(error.diagnostics.body_excerpt ?? '');
    const message = isRecord(reply) ? reply.message : null;
    return typeof message === 'string' && SUBSCRIBER_ONLY.test(message.trim())
      ? new NotFoundError('Ship24', 'Ship24 shows this courier to subscribers only', { cause: error, reason: 'subscriber_only' }) : null;
  } catch {
    return null;
  }
}

export class Ship24HttpClient {
  readonly #userAgent: string;

  constructor(readonly fetcher?: typeof fetch, userAgent?: string) {
    this.#userAgent = userAgentOf(userAgent);
  }

  /**
   * The parcel as Ship24 has it stored; `to_updated` asks for a refresh. A
   * courier code asks for the parcel with that courier, as the tracking page's
   * "Add details" dialog does.
   */
  async fetch(number: string, timeoutMs: number, signal?: AbortSignal, courier?: string): Promise<unknown> {
    if (!/^(?=.*\d)[A-Z0-9]{4,40}$/.test(number)) throw new InvalidInputError('Ship24', 'Invalid Ship24 tracking number');
    if (courier !== undefined && (courier.length > 60 || !COURIER_CODE.test(courier))) throw new TypeError('Invalid Ship24 courier code');
    return this.#post(`${API}/${number}?lang=en`, token(number), timeoutMs, signal,
      courier === undefined ? {} : { postCode: '', destinationCountryCode: '', to_check: [courier] });
  }

  /**
   * The refresh the web app asks for when the stored parcel says `to_updated`:
   * Ship24 queries the carriers again and replies with the parcel's current
   * history, or none yet.
   */
  async refresh(parcelId: string, number: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (!/^(?=.*\d)[A-Z0-9]{4,40}$/.test(number) || !PARCEL_ID.test(parcelId)) throw new InvalidInputError('Ship24', 'Invalid Ship24 parcel reference');
    return this.#post(`${API}/update/${parcelId}/mainTN/${number}?lang=en`, refreshToken(number), timeoutMs, signal);
  }

  async #post(url: string, signature: string, timeoutMs: number, signal?: AbortSignal, details: Record<string, unknown> = {}): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('Ship24 HTTP timeout must be positive');
    const { bytes } = await fetchBounded(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.ship24.com',
        Referer: PAGE, 'User-Agent': this.#userAgent, 'x-ship24-token': signature },
      body: JSON.stringify({ userAgent: '', os: 'Linux', browser: 'Unknown', device: 'Unknown',
        os_version: 'unknown', browser_version: 'unknown', deviceType: 'desktop',
        orientation: 'landscape', uL: 'en-US', ...details }),
    }, { provider: 'Ship24 HTTP', fetcher: this.fetcher, timeoutMs: Math.floor(timeoutMs), maxBytes: 2_000_000 }).catch((error: unknown) => {
      throw subscriberOnly(error) ?? error;
    });
    return parseJsonBytes(bytes, 'Ship24');
  }
}

export const ship24Http = new Ship24HttpClient();

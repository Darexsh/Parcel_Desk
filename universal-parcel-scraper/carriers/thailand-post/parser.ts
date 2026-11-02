import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ACTIVITY, COD_REMITTANCE, FINAL_DELIVERY, thailandPostStage } from './status.js';

export const PROVIDER = 'Thailand Post';
const ZONE = 'Asia/Bangkok';
const MAX_SCANS = 500;
const MAX_EVENTS = 100;
// Codes whose detail was seen to hold only the scan and its offices.
const DETAILED = new Set(['3', '9', '15', '18', '23', '24', '25', '27', '31', '34', '35']);
// A refusal that asks for a verification, or for a registered API account.
const VERIFICATION = /captcha|turnstile|verif|robot|regist|cf-chl|challenge|just a moment|access denied/i;
const THROTTLED = /too many requests|rate.?limit/i;
const S10_SHAPE = /^[A-Z]{2}\d{9}[A-Z]{2}$/i;

export function normalizeThailandPostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z]{2}\d{9}TH$/.test(number) || !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError(PROVIDER, 'Thailand Post requires a valid S10 number ending in TH');
  }
  return number;
}

/**
 * The website's request encoding: base64 of a JSON envelope cut into nine
 * parts, then a base64 index of each part's position and length. The site
 * shuffles the parts; it accepts them in order too. There is no key.
 */
export function encodeThailandPostRequest(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify({ data: JSON.stringify(payload), d: null }), 'utf8').toString('base64');
  const size = Math.ceil(encoded.length / 9);
  const parts = Array.from({ length: 9 }, (_, position) => encoded.slice(size * position, size * (position + 1)));
  const index = parts.map((part, position) => `${position}${part.length}`).join(':');
  return `${parts.join('')},${Buffer.from(index, 'utf8').toString('base64')}`;
}

/** The site's own payload for one number; `checkBot` must be "1" or the reply is a rejection. */
export function thailandPostRequestBody(number: string): string {
  return encodeThailandPostRequest({ trackingNo: normalizeThailandPostNumber(number), flagOS: '1', flagBill: '',
    checkBot: '1', check: 'AA', tnt: '', turnstileToken: null });
}

interface Scan { event: CarrierEvent; instant: number | null; activity: boolean; mapped: ClassifiedWording | null }

function scan(raw: unknown, number: string): Scan {
  if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Thailand Post returned an invalid scan');
  if (typeof raw.mailingNo !== 'string' || raw.mailingNo.trim() !== number
    || (raw.prefix != null && raw.prefix !== number.slice(0, 2)) || (raw.suffix != null && raw.suffix !== number.slice(-2))) {
    throw new SchemaError(PROVIDER, 'Thailand Post returned a scan of another shipment');
  }
  const created = raw.createDate;
  if (typeof created !== 'number' || !Number.isSafeInteger(created) || created < 1e12 || created >= 1e14) {
    throw new SchemaError(PROVIDER, 'Thailand Post returned an invalid scan clock');
  }
  const code = cleanScalar(raw.statusID, 8);
  if (!/^\d{1,4}$/.test(code)) throw new SchemaError(PROVIDER, 'Thailand Post returned an invalid scan code');
  const label = isRecord(raw.statusName) ? clean(raw.statusName['1'], 300) : '';
  if (!label) throw new SchemaError(PROVIDER, 'Thailand Post returned a scan without a status');
  const detail = isRecord(raw.statusDetail) ? clean(raw.statusDetail['1'], 500) : '';
  // The contact scan's detail masks the recipient's phone number: only known
  // details, and never a masked one, replace the label.
  const description = DETAILED.has(code) && detail && !detail.includes('*') ? detail : label;
  // A payment to the seller is no scan of the parcel, so its office is no location.
  const location = isRecord(raw.outletName) && code !== COD_REMITTANCE ? clean(raw.outletName['1'], 200) : '';
  const clock = DateTime.fromMillis(created, { zone: ZONE });
  // Foreign posts' EDI scans hold their office's wall clock stored as if it
  // were Bangkok time, so they keep that wall clock without an offset.
  const foreign = cleanScalar(raw.portalCode, 16) === '99999' || cleanScalar(raw.outletType, 8) === '25' || raw.itemTypeFlag === 'EDI';
  const activity = ACTIVITY.has(code);
  const group = typeof raw.statusGroup === 'number' ? raw.statusGroup : null;
  // The delivery result of a final delivery: the addressee's, or the sender's after a return.
  const result = cleanScalar(raw.dStatusCode, 8);
  return {
    event: {
      ...(foreign ? { local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") } : { time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ") }),
      description, ...(location ? { location } : {}), provider_code: code,
    },
    instant: foreign ? null : created, activity, mapped: activity ? null : thailandPostStage(code, label, group, result),
  };
}

/** The text of a refusal: its string values, at the top and one level down, bounded. */
function refusalText(value: unknown): string {
  let text = '';
  for (const child of isRecord(value) ? Object.values(value) : Array.isArray(value) ? value : [value]) {
    for (const leaf of isRecord(child) ? Object.values(child) : Array.isArray(child) ? child : [child]) {
      if (typeof leaf === 'string') text = `${text} ${leaf.slice(0, 2_000)}`.slice(0, 2_000);
    }
  }
  return text;
}

/** A reply without the history: a verification or a throttle when it says so, else a rejection. */
function refusal(value: unknown, message: string, cause?: unknown): Error {
  const text = refusalText(value);
  if (VERIFICATION.test(text)) return new ChallengeError(PROVIDER, 'Thailand Post asked for a verification');
  if (THROTTLED.test(text)) return new RateLimitedError(PROVIDER);
  return new SchemaError(PROVIDER, message, { cause });
}

/**
 * The getMailing reply: a map keyed by the requested number. Only that whole
 * key is read; a null value is the site's answer for an unknown or expired
 * number. A reply without that key is the server refusing the request, or a
 * different shipment when it is keyed by another number.
 */
export function parseThailandPostReply(text: string, requested: string): CarrierResult {
  const number = normalizeThailandPostNumber(requested);
  const body = text.replace(/^\uFEFF/, '').trim();
  if (body.startsWith('<')) throw new ChallengeError(PROVIDER, 'Thailand Post answered with a web page instead of tracking data');
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    throw refusal(body.slice(0, 2_000), 'Thailand Post returned invalid tracking JSON', cause);
  }
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  const keys = Object.keys(payload);
  if (!Object.hasOwn(payload, number)) {
    if (keys.some((key) => S10_SHAPE.test(key))) throw new SchemaError(PROVIDER, 'Thailand Post returned a different shipment');
    throw refusal(payload, 'Thailand Post rejected the tracking request');
  }
  if (keys.length !== 1) throw new SchemaError(PROVIDER, 'Thailand Post returned more than the requested shipment');
  const history = payload[number];
  if (history === null) throw new NotFoundError(PROVIDER);
  if (!Array.isArray(history)) throw refusal(history, 'Thailand Post returned an invalid tracking history');
  if (!history.length || history.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Thailand Post returned an invalid tracking history');

  const scans = history.map((raw) => scan(raw, number));
  // The site lists scans newest first. Thai scans are instants and can be
  // ordered; a foreign post's wall clock cannot be compared with them.
  if (scans.every((row) => row.instant !== null)) {
    if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
    scans.sort((left, right) => right.instant! - left.instant!);
  }
  const seen = new Set<string>();
  const unique = scans.filter(({ event }) => {
    const key = JSON.stringify([event.time ?? event.local_time, event.description, event.location, event.provider_code]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Oldest first: a call or a payment to the seller records activity under
  // the stage the scans before it established, without becoming the parcel's
  // stage.
  let current: ClassifiedWording | null = null;
  for (const row of [...unique].reverse()) {
    const stage = row.activity ? current && { stage: current.stage, source: 'none' } : row.mapped;
    if (stage) Object.assign(row.event, { stage: stage.stage, stage_source: stage.source });
    if (!row.activity) current = row.mapped;
  }
  const events = unique.slice(0, MAX_EVENTS).map(({ event }) => event);
  const latest = events[0]!;
  // The newest final delivery to the addressee dates the delivery; activity
  // after it does not. A delivery abroad has only the destination post's wall
  // clock, so no delivery instant.
  const delivered = current?.stage === 'delivered'
    ? unique.find((row) => row.event.provider_code === FINAL_DELIVERY && row.mapped?.stage === 'delivered')?.event.time : undefined;
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: latest.description,
    last_update: latest.time ?? null,
    ...(typeof latest.local_time === 'string' ? { last_update_local: latest.local_time } : {}),
    ...(delivered ? { delivered_at: delivered } : {}),
    expected_delivery: null,
    events,
  };
}


/**
 * AliExpress / Cainiao tracking.
 *
 * Cainiao's public shipment detail endpoint (`global.cainiao.com/global/
 * detail.json`) is the same keyless JSON the consumer tracking page reads. One
 * GET returns every requested `mailNo` as a module, so the adapter selects the
 * module whose identifier equals the number that was asked for and refuses
 * anything else: the endpoint happily echoes other shipments when the query is
 * malformed, and showing a stranger's parcel would be worse than an error.
 *
 * A module with no status, no history and no latest trace is genuinely unknown
 * only when `mailNoSource` is `EXTERNAL`; otherwise Cainiao is still waiting
 * for the seller and the parcel is simply pending.
 *
 * That feed holds AliExpress's parcels. Partners such as 4PX hand theirs to
 * Cainiao Express for home delivery in France under the same `DOFR…HD` and
 * `CNFR…HD` numbers, and only Cainiao Express's own tracker
 * (`track.cainiao.com/coe/trace/queryDetail`, same module shape) holds those,
 * once it has the parcel. Before that only the partner knows the number, so
 * one neither feed knows is inconclusive, not missing.
 */
import { lookupBudget, recognizeFromLookup, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { detectCarrierMatch } from '../../core/detection/detect.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { validTrackingNumber } from '../../core/detection/valid.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import {
  CAINIAO_ACTION_STATUS,
  CAINIAO_NOTICE_ACTIONS,
  CAINIAO_STATUS,
  cainiaoActionCode,
  cainiaoActionStage,
  cainiaoStageByStatus,
} from './status.js';
import { placedWording, placeName } from './place.js';

const PROVIDER = 'Cainiao';
const UPSTREAM = 'Cainiao tracking';
const DETAIL_URL = 'https://global.cainiao.com/global/detail.json';
const DETAIL_PAGE = 'https://global.cainiao.com/newDetail.htm';
const EXPRESS_URL = 'https://track.cainiao.com/coe/trace/queryDetail';
/** Cainiao Express's French home-delivery numbers, which partners' parcels carry too. */
const HOME_DELIVERY = /^(?:DO|CN)FR\d{13}HD$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_EVENTS_TO_RETURN = 100;
const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

/**
 * A reply's shape for a schema error: its top-level keys with their types, and
 * the short status texts it carries. Runs of digits, which could be a number,
 * are masked.
 */
function replyShape(value: unknown): string {
  if (!isRecord(value)) return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const fields = Object.entries(value).slice(0, 12).map(([key, field]) => {
    const type = Array.isArray(field) ? 'array' : field === null ? 'null' : typeof field;
    const text = /^(?:success|ret|code|status|error\w*|msg|message)$/i.test(key)
      ? [field].flat().filter((item) => typeof item !== 'object').map(String).join(' ').slice(0, 60) : '';
    return `${key}:${type}${text ? ` ${JSON.stringify(text.replace(/\w*\d{5,}\w*/g, '#'))}` : ''}`;
  });
  return `{${fields.join(', ')}}`;
}

function recordArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function comparableIdentifier(value: unknown): string {
  return text(value).toLocaleUpperCase('en-US').replace(/[^A-Z0-9]/g, '');
}

/**
 * The partner number Cainiao hands the parcel over with, when it publishes
 * one. `copyRealMailNo` is the machine-readable field; `realMailNo` is display
 * prose that sometimes wraps the same identifier in a sentence.
 */
/**
 * One of Cainiao's own numbers (`CNG`, `CNFR…HD`, `DOFR…HD`), which names no
 * partner: Cainiao gives its `CNG` number beside an Ecoscooting `CNPRT` reference.
 */
function cainiaoOwnNumber(number: string): boolean {
  const detected = detectCarrierMatch(number);
  return detected.confidence === 'high' && detected.carrier === 'aliexpress';
}

function cainiaoHandoffNumber(trackingModule: JsonObject): string {
  const direct = normalizeTrackingNumber(text(trackingModule.copyRealMailNo));
  if (/^(?=.*\d)[A-Z0-9]{8,30}$/.test(direct)) {
    return direct;
  }
  const display = text(trackingModule.realMailNo);
  const match = /(?<![A-Z0-9])(?=[A-Z0-9]*\d)[A-Z0-9]{8,30}(?![A-Z0-9])/i.exec(display);
  return match?.[0].toUpperCase() ?? '';
}

/**
 * A scan's time: `timeStr` is the local wall clock and `timeZone` ("GMT+2")
 * its offset. `timeStr` alone is not UTC, and the epoch `time` field is not
 * the instant either: it reads `timeStr` as Beijing time even for European
 * scans, putting a morning "out for delivery" in the middle of the night
 * (checked 2026-09-22). Without a zone the text is kept, unless Cainiao
 * recorded the scan itself (`recordedInBeijing`).
 */
function scanTime(scan: JsonObject): string {
  const wall = text(scan.timeStr);
  const zone = /^(?:GMT|UTC)\s*(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(text(scan.timeZone));
  if (!wall) return wall;
  if (!zone) {
    if (text(scan.timeZone).trim() || !recordedInBeijing(scan, wall)) return wall;
    return explicitOffsetTime(`${wall.replace(' ', 'T')}+08:00`)?.iso ?? wall;
  }
  const offset = zone[1] ? `${zone[1]}${zone[2]!.padStart(2, '0')}:${zone[3] ?? '00'}` : 'Z';
  return explicitOffsetTime(`${wall.replace(' ', 'T')}${offset}`)?.iso ?? wall;
}

/** The flight out of the departure country, which Cainiao can date by its day alone. */
const FLIGHT_CODES = new Set(['LH_HO_AIRLINE', 'LH_DEPART']);

/**
 * A scan's clock, or its day alone. Cainiao can put the flight out
 * ("Leaving from departure country/region", "Departed from departure
 * country/region") at midnight on its day, sometimes before export customs
 * has cleared: a planned day, not a scan time.
 */
function scanClock(scan: JsonObject): { time: string } | { local_time: string } {
  const day = FLIGHT_CODES.has(cainiaoActionCode(scan.actionCode))
    ? /^(\d{4}-\d{2}-\d{2}) 00:00:00$/.exec(text(scan.timeStr).trim())?.[1] : undefined;
  return day ? { local_time: day } : { time: scanTime(scan) };
}

/** The carriers a module names, which a bracket can name too without being a place. */
function carrierNames(trackingModule: JsonObject, scans: readonly JsonObject[]): Set<string> {
  const named = [trackingModule.destCpInfo, ...[trackingModule.latestTrace, trackingModule.globalCombinedLogisticsTraceDTO, ...scans]
    .map((scan) => record(scan).currentStatusCpInfo)];
  return new Set(named.map((info) => text(record(info).cpName).trim().toLocaleLowerCase('en-US')).filter(Boolean));
}

/**
 * Cainiao's standard wording, or the scan's own where the standard one is the
 * placeholder Cainiao gives some steps, its transit sorting centers' scans and
 * its last-mile forecast among them: "Carrier update" says nothing their own
 * wording does not.
 */
function scanWording(scan: JsonObject): string {
  const standard = text(scan.standerdDesc);
  return (/^carrier update$/i.test(standard) && text(scan.desc)) || standard || text(scan.desc);
}

const BEIJING_OFFSET_MS = 8 * 3_600_000;

/**
 * Whether a zone-less scan is Cainiao's own record on the Beijing clock. Its
 * notices (`LAST_MILE_ASN_NOTIFY`) come from no facility, so
 * they carry no `timeZone`, and their epoch keeps milliseconds that `timeStr`
 * cannot hold: the epoch is then the recorded instant and `timeStr` its
 * Beijing rendering, not the other way round. A whole-second epoch could be
 * read from the text, so it proves nothing.
 */
function recordedInBeijing(scan: JsonObject, wall: string): boolean {
  const epoch = scan.time;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch % 1000 === 0) return false;
  const beijing = new Date(epoch + BEIJING_OFFSET_MS);
  return Number.isFinite(beijing.getTime()) && beijing.toISOString().slice(0, 19).replace('T', ' ') === wall;
}

/** The module of a `detail.json` payload for the number asked; any other shipment is refused. */
function trackingModuleOf(value: unknown, trackingNumber: string): JsonObject {
  const payload = record(value);
  const rawModules = Array.isArray(payload.module)
    ? payload.module
    : Array.isArray(payload.data) ? payload.data : null;
  if (!rawModules) throw new SchemaError(PROVIDER, `Cainiao returned an invalid tracking response: ${replyShape(value)}`);
  const modules = recordArray(rawModules);
  if (modules.length !== rawModules.length) {
    throw new SchemaError(PROVIDER, 'Cainiao returned an invalid shipment entry');
  }
  if (modules.length === 0) throw new SchemaError(PROVIDER, 'Cainiao did not return a shipment entry');
  const requested = comparableIdentifier(trackingNumber);
  const identified = modules.filter((module) => comparableIdentifier(module.mailNo));
  if (identified.length === 0) throw new SchemaError(PROVIDER, 'Cainiao did not return a shipment identifier');
  const trackingModule = identified.find(
    (module) => comparableIdentifier(module.mailNo) === requested,
  );
  if (!trackingModule) throw new SchemaError(PROVIDER, 'Cainiao returned a different shipment');
  return trackingModule;
}

/**
 * The carriers a `detail.json` payload names for the number asked, in lower
 * case: the destination carrier and each scan's carrier.
 */
export function cainiaoCarrierNames(value: unknown, trackingNumber: string): ReadonlySet<string> {
  const trackingModule = trackingModuleOf(value, trackingNumber);
  return carrierNames(trackingModule, recordArray(trackingModule.detailList));
}

/** Projects one `detail.json` payload. Pure: the offline tests target this. */
export function parseCainiaoTrackingResponse(value: unknown, trackingNumber: string): CarrierResult {
  const trackingModule = trackingModuleOf(value, trackingNumber);
  const requested = comparableIdentifier(trackingNumber);
  const rawStatus = text(trackingModule.status);
  const latest = record(trackingModule.latestTrace ?? trackingModule.globalCombinedLogisticsTraceDTO);
  const rawDetails = trackingModule.detailList;
  if (rawDetails !== undefined && !Array.isArray(rawDetails)) {
    throw new SchemaError(PROVIDER, 'Cainiao returned invalid tracking history');
  }
  const details = recordArray(rawDetails);
  if (Array.isArray(rawDetails) && details.length !== rawDetails.length) {
    throw new SchemaError(PROVIDER, 'Cainiao returned an invalid tracking event');
  }
  if (Array.isArray(rawDetails)
    && !rawStatus
    && details.length === 0
    && Object.keys(latest).length === 0) {
    // Only an externally issued number can be positively unknown here; an
    // internal one is a shipment the seller has not handed over yet.
    if (text(trackingModule.mailNoSource).toLocaleUpperCase('en-US') === 'EXTERNAL') {
      throw new NotFoundError(PROVIDER);
    }
  }
  // A token the map does not know reads as moving only once Cainiao has a
  // scan; before one it states nothing.
  const scanned = details.length > 0 || Object.keys(latest).length > 0;
  // A notice moves nothing: the parcel stands at its newest scan that has a stage,
  // while the notice stays the newest update.
  const standing = CAINIAO_NOTICE_ACTIONS.has(cainiaoActionCode(latest.actionCode))
    ? details.find((event) => cainiaoActionStage(cainiaoActionCode(event.actionCode))) ?? latest
    : latest;
  const standingAction = cainiaoActionCode(standing.actionCode);
  const status = standingAction
    ? (CAINIAO_ACTION_STATUS.get(standingAction) ?? 'unknown')
    : (CAINIAO_STATUS.get(rawStatus)
      ?? (rawStatus ? (scanned ? 'in_transit' : 'unknown') : details.length === 0 ? 'pending' : 'unknown'));
  const currentStage = cainiaoActionStage(standingAction) ?? cainiaoStageByStatus()[status];
  const carriers = carrierNames(trackingModule, details);
  const events = details.slice(0, MAX_EVENTS_TO_RETURN).map((event): CarrierEvent => {
    const code = cainiaoActionCode(event.actionCode);
    const stage = cainiaoActionStage(code);
    const placed = placedWording(scanWording(event), carriers);
    return {
      ...scanClock(event),
      // Cainiao Express's tracker states a town or a country code in `location`.
      location: placed.location || placeName(text(event.location), carriers),
      description: placed.description,
      // The code keys the app's review of a scan the map does not stage.
      ...(/^[A-Z0-9_]{1,64}$/.test(code) ? { provider_code: code } : {}),
      ...(stage ? { stage } : {}),
    };
  });
  // Oldest first: a notice keeps the stage of the scan before it, and pending before any.
  let previous: Stage = 'pending';
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (CAINIAO_NOTICE_ACTIONS.has(cainiaoActionCode(details[index]!.actionCode))) Object.assign(event, { stage: previous, stage_source: 'none' });
    else if (event.stage) previous = event.stage as Stage;
  }
  const eta = record(trackingModule.globalEtaInfo);
  const toMillis = (value_: unknown): number | null => (
    typeof value_ === 'number' && Number.isFinite(value_) ? value_ : null
  );
  const deliveryMinTime = toMillis(eta.deliveryMinTime);
  const deliveryMaxTime = toMillis(eta.deliveryMaxTime);
  const toDate = (millis: number | null): string | null => (
    millis == null ? null : new Date(millis).toISOString().slice(0, 10)
  );
  const expected = toDate(deliveryMaxTime);
  const expectedFrom = toDate(deliveryMinTime);
  const handoff = cainiaoHandoffNumber(trackingModule);
  // Cainiao can follow the country with the recipient's town, "France,Town": only the country is read.
  const destination = text(trackingModule.destCountry).split(',')[0]!.trim().slice(0, 80);
  const deliveredAt = status === 'delivered' ? scanTime(standing) || null : null;
  const latestClock = scanClock(latest);
  return {
    status,
    ...(currentStage ? { current_stage: currentStage } : {}),
    last_status_text: placedWording(scanWording(latest), carriers).description || rawStatus,
    last_update: 'time' in latestClock ? latestClock.time || null : null,
    ...('local_time' in latestClock ? { last_update_local: latestClock.local_time } : {}),
    expected_delivery: status === 'delivered' ? null : expected,
    ...(status === 'delivered' || expectedFrom == null || expectedFrom === expected
      ? {}
      : { expected_delivery_from: expectedFrom }),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(handoff && comparableIdentifier(handoff) !== requested && !cainiaoOwnNumber(handoff) ? { delivery_tracking_number: handoff } : {}),
    ...(destination ? { destination_country_name: destination } : {}),
    events,
  };
}

/**
 * Alibaba's slider page, which Cainiao serves with a 200 in place of the JSON
 * once it suspects a robot.
 */
function sliderPage(body: string): boolean {
  return /^\s*</.test(body) && /rgv587_flag|<punish-component\b|\/_____tmd_____\//.test(body);
}

export class CainiaoTracker {
  private readonly fetcher: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}) {
    this.fetcher = options.fetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const budget = lookupBudget(context, this.timeoutMs);
    try {
      // The feed refuses a request another site refers ("uri is null or empty").
      return parseCainiaoTrackingResponse(await this.payload(`${DETAIL_URL}?${new URLSearchParams({ mailNos: trackingNumber, lang: 'en-US' })}`,
        DETAIL_PAGE, budget), trackingNumber);
    } catch (error) {
      if (!(error instanceof NotFoundError) || !HOME_DELIVERY.test(comparableIdentifier(trackingNumber))) throw error;
    }
    try {
      return await this.read(`${EXPRESS_URL}?${new URLSearchParams({ mailNos: trackingNumber, lang: 'en-US', language: 'en-US' })}`,
        'https://track.cainiao.com/orderTrack', trackingNumber, budget);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      throw new IndeterminateError(PROVIDER, 'Cainiao has no record of the shipment yet', { reason: 'portal_not_found' });
    }
  }

  /**
   * The global feed's `detail.json` reply for a number, unparsed, for a
   * carrier that reads Cainiao's leg of its own parcels.
   */
  async detail(trackingNumber: string, context: TrackingContext = {}): Promise<unknown> {
    return this.payload(`${DETAIL_URL}?${new URLSearchParams({ mailNos: trackingNumber, lang: 'en-US' })}`,
      DETAIL_PAGE, lookupBudget(context, this.timeoutMs));
  }

  private async read(url: string, referer: string, trackingNumber: string, budget: LookupBudget): Promise<CarrierResult> {
    return parseCainiaoTrackingResponse(await this.payload(url, referer, budget), trackingNumber);
  }

  private async payload(url: string, referer: string, budget: LookupBudget): Promise<unknown> {
    const { bytes } = await fetchBounded(
      url,
      { signal: budget.signal, headers: { ...BASE_HEADERS, 'User-Agent': this.userAgent, Referer: referer } },
      { provider: UPSTREAM, timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()), fetcher: this.fetcher },
    );
    if (sliderPage(decodeText(bytes))) throw new ChallengeError(PROVIDER);
    return parseJsonBytes(bytes, UPSTREAM);
  }
}

/** Kept for the host's legacy dispatch chain until it is deleted. */
export async function fetchCainiao(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
  return new CainiaoTracker().fetch(trackingNumber, context);
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CainiaoTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'aliexpress',
    // Keyless GETs, a second only for a home-delivery number the first does not know.
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => validTrackingNumber(number)),
  };
};

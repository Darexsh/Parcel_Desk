
import { lookupBudget, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, MaintenanceError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { isValidS10TrackingNumber } from '../../core/detection/index.js';
import { countryTimeZone, explicitOffsetTime, isoTime } from '../../core/time/index.js';
import {
  clean,
  decodeText,
  escapeRegExp,
  fetchBounded,
  parseJsonBytes,
} from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { agencyIntake, cttSiteZone, isCttExpressAgency, portugalZone } from './clock.js';
import { classifyCttStatus } from './status.js';

// Protocol provenance:
// - Prior art (full session mechanics + vocabulary, verified step by step
//   below, MIT): https://github.com/ha-parcel-integrations/ha-ctt (api.py,
//   parcels.py, tests).
// - CTT's tracker is an OutSystems Reactive app, so there is ceremony: the
//   endpoint answers 403 Invalid Login to a cookie-less request while setting
//   the nr2Users session cookie on that same response (the 403 is the
//   bootstrap, not an error); every data action then needs the cookie plus an
//   X-CSRFToken derived from it, plus moduleVersion/apiVersion tokens that CTT
//   rotates on every frontend deploy (derived at runtime from keyless version
//   endpoints and the screen bundle — never pinned). A browser User-Agent is
//   mandatory (Cloudflare error 1010 otherwise).
// - Found:true carries ObjectEventsFromQuery; Found:false is
//   BOTH genuine unknown and backend outage, told apart only via the sibling
//   DataActionCheckIPLocked call (made solely on Found:false — a found parcel
//   already proves health).
// - StateId is the stable integer key (never the Portuguese State text); the
//   map lives in status.ts.
const BASE_URL = 'https://appserver.ctt.pt';
const SCREEN_PATH = '/CustomerArea/screenservices/CustomerArea/CustomerArea/PublicArea_Detail';
const VIEW_NAME = 'CustomerArea.PublicArea_Detail';
const TRACK_ACTION = 'DataActionGetObjectEventsByInputObjectCode';
const MAINTENANCE_ACTION = 'DataActionCheckIPLocked';
const MODULE_VERSION_URL = `${BASE_URL}/CustomerArea/moduleservices/moduleversioninfo`;
const SCREEN_SCRIPT_PATH = '/CustomerArea/scripts/CustomerArea.CustomerArea.PublicArea_Detail.mvc.js';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_SCRIPT_BYTES = 2_000_000;
const MAX_EVENTS_TO_RETURN = 20;

interface CttSession {
  cookie: string;
  csrfToken: string;
}

/** A CTT maintenance window: the backend is up but refuses to answer lookups. */
export class CttMaintenanceError extends MaintenanceError {
  constructor() {
    super('CTT', 'CTT tracking is temporarily unavailable');
    this.name = 'CttMaintenanceError';
  }
}

/** The OutSystems ceremony broke down (session, version tokens, body shape). */
export class CttApiError extends IndeterminateError {
  constructor(detail: string) {
    super('CTT', `CTT tracking request failed: ${detail}`);
    this.name = 'CttApiError';
  }
}

export function normalizeCttTrackingNumber(raw: string): string {
  // A checksum-valid S10 number: CTT's own, ending in PT, or mail from abroad
  // under the number its origin post gave it, which CTT's tracker also looks up.
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(value) || !isValidS10TrackingNumber(value)) {
    throw new InvalidInputError('CTT', 'CTT tracking requires a valid 13-character S10 number');
  }
  return value;
}

export function cttTrackingUrl(rawTrackingNumber: string): string {
  // Legacy objectSearch page: the address users recognise, stable across
  // appserver host changes, and the one CTT itself links from its site.
  const url = new URL('https://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx');
  url.searchParams.set('objects', normalizeCttTrackingNumber(rawTrackingNumber));
  return url.toString();
}

function sessionFromSetCookie(response: Response): CttSession | null {
  const getSetCookie = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie.bind(response.headers)
    : null;
  const rawCookies = getSetCookie ? getSetCookie() : [];
  const header = rawCookies.find((value) => value.startsWith('nr2Users='))
    ?? response.headers.get('set-cookie') ?? '';
  const value = /^nr2Users=([^;]*)/.exec(header)?.[1] ?? '';
  if (!value) return null;
  // Decoded shape: crf=<TOKEN>;uid=0;unm= — the crf field is the CSRF token.
  const csrfToken = /crf=([^;]+)/.exec(decodeURIComponent(value))?.[1] ?? '';
  if (!csrfToken) return null;
  return { cookie: `nr2Users=${value}`, csrfToken };
}

/** UPU events a destination post records: from arrival at its office of exchange to delivery. */
const DESTINATION_EVENT = /^(?:EM[D-I]|ED[A-H])$/;
/** UPU events an origin post records: from posting to dispatch from its office of exchange. */
const ORIGIN_EVENT = /^(?:EM[A-C]|EX[A-DX])$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(?:Z|\+00:?00)?$/i;

/** A scan's wall clock read as UTC, only to compare it with another's. */
function wallMillis(value: unknown): number {
  const wall = WALL_CLOCK.exec(typeof value === 'string' ? value.trim() : '')?.[1];
  return wall ? Date.parse(`${wall}Z`) : Number.NaN;
}

/**
 * A scan's clock. CTT's Z is no offset: the digits are the wall clock where
 * the scan happened (see clock.ts). That is the partner post's country
 * (`partner`) for its scans: the destination's on a parcel bound abroad, the
 * origin's on mail from abroad. A location naming an office or a site of
 * CTT's overrides it; Portugal's clock applies otherwise. In a country with
 * several zones the scan keeps CTT's Z, the last guess: hours off, but the
 * reply keeps its instant. Only a wall clock sent with no Z stays a wall time
 * there. Any other offset is taken as sent.
 */
function scanClock(value: unknown, location: string, partner: string | null, spanish: boolean):
  { time?: string; local_time?: string; timestamp: number } | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  const wall = WALL_CLOCK.exec(raw)?.[1];
  if (!wall) {
    const time = explicitOffsetTime(raw);
    return time ? { time: time.iso, timestamp: time.timestamp } : null;
  }
  const zone = cttSiteZone(location, partner ? [partner] : []) ?? (spanish ? 'Europe/Madrid' : null)
    ?? (partner ? countryTimeZone(partner) : portugalZone(location));
  const placed = zone ? isoTime(wall, zone) : null;
  if (placed) return { time: placed.iso, timestamp: placed.timestamp };
  const labelled = explicitOffsetTime(raw);
  if (labelled) return { time: labelled.iso, timestamp: labelled.timestamp };
  const read = Date.parse(`${wall}Z`);
  return Number.isFinite(read) ? { local_time: wall, timestamp: read } : null;
}

export function parseCttTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const requested = normalizeCttTrackingNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('CTT', 'CTT returned an invalid tracking response');
  const data = isRecord(payload.data) ? payload.data : null;
  if (!data) throw new SchemaError('CTT', 'CTT returned an invalid tracking response');
  const record = data.ObjectEventsFromQuery;
  if (!isRecord(record)) throw new SchemaError('CTT', 'CTT returned an invalid tracking response');
  const returned = clean(record.ObjectCode, 64).toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!returned) throw new SchemaError('CTT', 'CTT did not return a shipment identifier');
  if (returned !== requested) throw new SchemaError('CTT', 'CTT returned a different shipment');
  const rawEvents = record.Events;
  const eventsList = isRecord(rawEvents) && Array.isArray(rawEvents.List) ? rawEvents.List : null;
  if (eventsList === null) throw new SchemaError('CTT', 'CTT returned invalid tracking history');
  // Only the parcel's countries are read: the recipient's, to tell a parcel
  // bound abroad, and the origin's on mail from abroad, the sender's country
  // or else the one whose post issued the number.
  const recipient = clean(record.RecipientCountryCode, 8).toUpperCase();
  const abroad = /^[A-Z]{2}$/.test(recipient) && recipient !== 'PT' ? recipient : null;
  const sender = clean(record.SenderCountryCode, 8).toUpperCase();
  const origin = requested.endsWith('PT') ? null : /^[A-Z]{2}$/.test(sender) && sender !== 'PT' ? sender : requested.slice(-2);
  const rows = eventsList.filter(isRecord).slice(0, 500);
  // A parcel CTT Express hands over in Spain: its agencies' scans, and the
  // acceptance CTT records with no place as one takes the parcel in, are on
  // Madrid's clock (clock.ts).
  const agencyScans = rows.filter((row) => isCttExpressAgency(clean(row.Local, 160))).map((row) => wallMillis(row.DateTime));
  const parsed: Array<{ event: CarrierEvent; classified: ClassifiedStatus | undefined; timestamp: number; index: number }> = [];
  const seen = new Set<string>();
  rows.forEach((rawEvent, index) => {
    const stateId = typeof rawEvent.StateId === 'number' ? rawEvent.StateId : Number.NaN;
    const description = clean(rawEvent.Event, 500) || clean(rawEvent.State, 200);
    const location = clean(rawEvent.Local, 160);
    const code = clean(rawEvent.EventCode, 8);
    const partner = abroad && DESTINATION_EVENT.test(code) ? abroad : origin && ORIGIN_EVENT.test(code) ? origin : null;
    const at = wallMillis(rawEvent.DateTime);
    const spanish = isCttExpressAgency(location)
      || (!location && agencyIntake(at, agencyScans));
    const clock = scanClock(rawEvent.DateTime, location, partner, spanish);
    if (!clock || !description) return;
    const identity = `${clock.time ?? clock.local_time}\u0000${description}\u0000${Number.isSafeInteger(stateId) ? stateId : ''}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyCttStatus(stateId);
    parsed.push({
      // Local mixes depot codes and point names (operational locations, kept
      // coarse). A bare number, such as the Spanish post office code on the
      // acceptance CTT relays from Correos, names no place. Sender/recipient
      // identity, contact and address blocks travel on the record but are
      // deliberately never retained.
      // An unmapped state keeps no stage: the sync classifies the wording and
      // records where the stage came from instead of assuming movement here.
      event: {
        ...(clock.time ? { time: clock.time } : { local_time: clock.local_time }),
        location: /^\d+$/.test(location) ? '' : location,
        description,
        ...(classified ? { stage: classified.stage } : {}),
        ...(Number.isSafeInteger(stateId) ? { provider_code: String(stateId) } : {}),
      },
      classified: classified ?? undefined,
      timestamp: clock.timestamp,
      index,
    });
  });
  parsed.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const events = parsed.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event);
  const latest = parsed.find((item) => item.classified);
  if (!latest) {
    return {
      status: 'unknown',
      last_status_text: events[0]?.description ?? 'Tracking information received',
      last_update: events[0]?.time ?? null,
      ...(events[0]?.local_time ? { last_update_local: events[0].local_time } : {}),
      expected_delivery: null,
      events,
    };
  }
  return {
    status: latest.classified!.status,
    current_stage: latest.classified!.stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time ?? null,
    ...(latest.event.local_time ? { last_update_local: latest.event.local_time } : {}),
    expected_delivery: null,
    events,
  };
}

export class CttTracker {
  readonly timeoutMs: number;
  readonly fetcher: typeof fetch | undefined;
  private moduleVersion: string | null = null;
  private apiVersions = new Map<string, string>();
  private screenScript: string | null = null;

  constructor(options: { timeoutMs?: number; fetcher?: typeof fetch } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('CTT timeout must be positive');
    }
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const trackingNumber = normalizeCttTrackingNumber(rawTrackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    const payload = await this.callAction(TRACK_ACTION, {
      ObjectCodeInput: trackingNumber,
      SearchInput: trackingNumber,
      IsFromPublicArea: true,
      IPClient: '',
    }, null, true, true, budget);
    const record = isRecord(payload.data) ? payload.data.ObjectEventsFromQuery : undefined;
    if (!isRecord(record) || typeof record.Found !== 'boolean') {
      throw new CttApiError('missing shipment Found flag');
    }
    if (!record.Found) {
      // Found:false is both genuine unknown and backend outage: a found parcel
      // already proves health, so the sibling check runs solely on negatives.
      if (await this.isMaintenance(budget)) throw new CttMaintenanceError();
      throw new NotFoundError('CTT');
    }
    return parseCttTrackingResponse(payload, trackingNumber);
  }

  private async isMaintenance(budget: LookupBudget): Promise<boolean> {
    const payload = await this.callAction(MAINTENANCE_ACTION, {}, null, true, true, budget);
    const data = isRecord(payload.data) ? payload.data : {};
    if (typeof data.IsMaintenance !== 'boolean') throw new CttApiError('missing maintenance flag');
    return data.IsMaintenance === true;
  }

  private async callAction(
    action: string,
    variables: Record<string, unknown>,
    session: CttSession | null,
    retrySession: boolean,
    retryVersion: boolean,
    budget: LookupBudget,
  ): Promise<{ data?: unknown; versionInfo?: unknown } & Record<string, unknown>> {
    const apiVersion = await this.ensureApiVersion(action, budget);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': BROWSER_USER_AGENT,
    };
    if (session) {
      headers.Cookie = session.cookie;
      headers['X-CSRFToken'] = session.csrfToken;
    }
    const { response, bytes } = await fetchBounded(`${BASE_URL}${SCREEN_PATH}/${action}`, {
      method: 'POST',
      signal: budget.signal,
      headers,
      body: JSON.stringify({
        versionInfo: { moduleVersion: this.moduleVersion, apiVersion },
        viewName: VIEW_NAME,
        screenData: { variables },
      }),
    }, {
      provider: 'CTT tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      retryTransient: true,
      allowHttpStatuses: [403],
      fetcher: this.fetcher,
    });
    if (response.status === 403) {
      const bootstrapped = sessionFromSetCookie(response);
      if (retrySession && bootstrapped) {
        return this.callAction(action, variables, bootstrapped, false, retryVersion, budget);
      }
      throw new CttApiError('anonymous session bootstrap failed');
    }
    const payload = parseJsonBytes(bytes, 'CTT tracking');
    if (!isRecord(payload)) throw new CttApiError('unexpected body (not a JSON object)');
    const versionInfo = isRecord(payload.versionInfo) ? payload.versionInfo : {};
    if ((versionInfo.hasModuleVersionChanged === true || versionInfo.hasApiVersionChanged === true) && retryVersion) {
      this.moduleVersion = null;
      this.screenScript = null;
      this.apiVersions.delete(action);
      return this.callAction(action, variables, session, retrySession, false, budget);
    }
    return payload;
  }

  private async ensureApiVersion(action: string, budget: LookupBudget): Promise<string> {
    const cached = this.apiVersions.get(action);
    if (cached !== undefined) return cached;
    await this.ensureModuleVersion(budget);
    const script = await this.ensureScreenScript(budget);
    const version = new RegExp(
      `callDataAction\\("${escapeRegExp(action)}",\\s*"[^"]*",\\s*"([^"]+)"`,
    ).exec(script)?.[1];
    if (!version) throw new CttApiError(`could not derive apiVersion for ${action}`);
    this.apiVersions.set(action, version);
    return version;
  }

  private async ensureModuleVersion(budget: LookupBudget): Promise<void> {
    if (this.moduleVersion !== null) return;
    const { bytes } = await fetchBounded(MODULE_VERSION_URL, {
      signal: budget.signal,
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_USER_AGENT },
    }, {
      provider: 'CTT tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      retryTransient: true,
      fetcher: this.fetcher,
    });
    const payload = parseJsonBytes(bytes, 'CTT tracking');
    const token = isRecord(payload) && typeof payload.versionToken === 'string' ? payload.versionToken : '';
    if (!token) throw new CttApiError('moduleversioninfo returned no versionToken');
    this.moduleVersion = token;
  }

  private async ensureScreenScript(budget: LookupBudget): Promise<string> {
    if (this.screenScript !== null) return this.screenScript;
    // The version token carries +/= characters: it must travel percent-encoded
    // or the manifest endpoint answers an unrelated shape.
    const manifestUrl = `${BASE_URL}/CustomerArea/moduleservices/moduleinfo?${encodeURIComponent(this.moduleVersion ?? '')}`;
    const manifest = await this.fetchJson(manifestUrl, budget);
    const versions = isRecord(manifest) && isRecord(manifest.manifest) && isRecord(manifest.manifest.urlVersions)
      ? manifest.manifest.urlVersions as Record<string, unknown>
      : {};
    const scriptToken = versions[SCREEN_SCRIPT_PATH];
    if (typeof scriptToken !== 'string' || !scriptToken) {
      throw new CttApiError("module manifest missing the screen script's version token");
    }
    const script = decodeText((await this.fetchBytes(`${BASE_URL}${SCREEN_SCRIPT_PATH}?${scriptToken}`, budget)).bytes);
    this.screenScript = script;
    return script;
  }

  private async fetchJson(url: string, budget: LookupBudget): Promise<unknown> {
    return parseJsonBytes((await this.fetchBytes(url, budget)).bytes, 'CTT tracking');
  }

  private async fetchBytes(url: string, budget: LookupBudget): Promise<{ bytes: Uint8Array }> {
    const { bytes } = await fetchBounded(url, {
      signal: budget.signal,
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': BROWSER_USER_AGENT },
    }, {
      provider: 'CTT tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_SCRIPT_BYTES,
      retryTransient: true,
      fetcher: this.fetcher,
    });
    return { bytes };
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CttTracker({ fetcher: environment.fetcher });
  return {
    id: 'ctt',
    // The OutSystems session bootstrap and the version-token refresh are part
    // of the direct call, not separate tiers: they never change the transport.
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};

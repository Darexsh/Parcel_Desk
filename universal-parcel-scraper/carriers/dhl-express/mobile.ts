import { randomBytes, randomUUID } from 'node:crypto';
import type { AdapterEnvironment, LookupBudget } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { decodeText, fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'DHL Express';
const APP = 'com.dhl.exp.dhlmobile';
const VERSION = '6.1.0';
const API = `https://dhle.dhl.com/access/access/${APP}`;
// The shared guest application bearer is deliberately distributed with this adapter.
const APPLICATION_BEARER = "Bearer MtX6uKNcGM295BXaJGa83GFhTHCL9a";
/** How long a confirmed plaintext-waybill setting is reused before it is read again. */
export const SETTINGS_TTL_MS = 15 * 60_000;
/** The codes of the CAPTCHA the app would show, which DHL turns on for a whole address at a time. */
const CAPTCHA_CODES = ['DRG10012', 'DRG10013'];
/**
 * How long after a CAPTCHA tracking is not asked again. Asked every two
 * minutes, the address kept its CAPTCHA past a quarter of an hour; left alone
 * for half an hour, it was gone. When the first request after the pause draws
 * it again, the next pause is twice as long, up to `MAX_CAPTCHA_MEMORY_MS`.
 */
export const CAPTCHA_MEMORY_MS = 30 * 60_000;
export const MAX_CAPTCHA_MEMORY_MS = 4 * 60 * 60_000;
/**
 * How many requests the mobile API is sent through one transport in an hour.
 * A waybill checked every ten minutes went unchallenged for hours; at twelve
 * checks an hour the address drew the CAPTCHA within the hour, and again a few
 * requests after each pause.
 */
export const HOURLY_REQUESTS = 6;
const HOUR_MS = 60 * 60_000;

/** The mobile API's CAPTCHA, which the transport's state remembers. */
class CaptchaError extends ChallengeError {}

/** Tracking not asked because the transport's requests for the hour are spent. */
export class MobilePacedError extends RateLimitedError {
  constructor(retryAfterMs: number) {
    super(PROVIDER, retryAfterMs, 'DHL mobile tracking was asked as often as an hour allows');
    this.name = 'MobilePacedError';
  }
}

/**
 * What the mobile API answered last through one transport: when `api_awb_encryption` last
 * read N, null until it is read again; when a request last drew the CAPTCHA, null once one is
 * answered, and the pause it began; and when the past hour's requests were sent. DHL turns the
 * CAPTCHA on for a whole address, so every adapter instance in the process that sends through
 * the same fetcher shares this, as a host's several registries do. A restart forgets it.
 */
interface TransportState { settingsCheckedAt: number | null; captchaAt: number | null; captchaMemoryMs: number; sentAt: number[] }
const states = new WeakMap<object, TransportState>();
const GLOBAL_FETCH = {};

function transportState(fetcher: typeof fetch | undefined): TransportState {
  const key = transportOf(fetcher) ?? GLOBAL_FETCH;
  let state = states.get(key);
  if (!state) states.set(key, state = { settingsCheckedAt: null, captchaAt: null, captchaMemoryMs: CAPTCHA_MEMORY_MS, sentAt: [] });
  return state;
}

/** Mobile errors can arrive as JSON strings or envelopes with HTTP 200. */
function checkReply(payload: unknown, httpStatus: number): void {
  const root = isRecord(payload) ? payload : {};
  const nested = isRecord(root.error) ? root.error : {};
  const codes = [payload, root.error, root.statusCode, root.status, root.code, root.message,
    nested.error, nested.statusCode, nested.status, nested.code, nested.message]
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    .map((value) => String(value).trim());
  if (codes.some((code) => ['429', 'temporary_blocked', 'max_attempts_reached'].includes(code))) throw new RateLimitedError(PROVIDER);
  const status = httpStatus === 200 ? undefined : { status: httpStatus };
  if (codes.some((code) => CAPTCHA_CODES.includes(code))) throw new CaptchaError(PROVIDER, 'DHL mobile tracking requires verification', status);
  if (codes.some((code) => ['401', '403', '428'].includes(code))) throw new ChallengeError(PROVIDER, 'DHL mobile tracking requires verification', status);
  const serverError = codes.find((code) => /^5\d{2}$/.test(code));
  if (serverError) throw new UpstreamHttpError(PROVIDER, Number(serverError));
}

/**
 * The guest mobile API for one adapter instance, with its device identity and
 * its transport's state.
 */
export class DhlMobileApi {
  private readonly device = randomUUID();
  private readonly state: TransportState;

  constructor(private readonly environment: AdapterEnvironment) {
    this.state = transportState(environment.fetcher);
  }

  /**
   * One waybill's shipments. An empty list counts as missing only under a
   * recently verified configuration, so the encryption setting is read after
   * one unless it was confirmed within the TTL. A shipment found needs no
   * setting, and DHL draws its CAPTCHA from an address's request count, so
   * most lookups send the tracking request alone. Any reply other than a
   * shipment list discards the setting. A request that got no reply, including
   * one its own lookup cancelled or ran out of time for, says nothing about it.
   * A CAPTCHA holds for every waybill and device from the address for a while,
   * so for `CAPTCHA_MEMORY_MS` after one, lookups through the same transport
   * fail as a challenge without a request. Once the transport has sent
   * `HOURLY_REQUESTS` in the past hour, lookups fail as paced without one.
   */
  async tracking(number: string, budget: LookupBudget): Promise<unknown> {
    const state = this.state;
    if (this.captchaHeld()) throw new ChallengeError(PROVIDER, 'DHL mobile tracking recently required verification');
    const pacedMs = this.pacedMs();
    if (pacedMs > 0) throw new MobilePacedError(pacedMs);
    let payload: unknown;
    try {
      payload = await this.request(budget, 'tracking', 'shipments', { airWayBill: number, countryCode: 'GB', languageCd: 'en',
        addShipmentToODD: 'N', moreDetails: 'Y', iv: Buffer.from(randomBytes(8).toString('hex')).toString('base64'), captchaVerificationData: {} });
    } catch (error) {
      if (!(error instanceof UpstreamNetworkError) && !budget.signal.aborted) state.settingsCheckedAt = null;
      throw error;
    }
    if (!Array.isArray(payload)) state.settingsCheckedAt = null;
    else if (payload.length === 0) {
      const checkedAt = state.settingsCheckedAt;
      if (checkedAt === null || Date.now() - checkedAt >= SETTINGS_TTL_MS) await this.checkSettings(budget);
    }
    return payload;
  }

  /** Whether a CAPTCHA drawn through this transport may still hold, so tracking would fail without a request. */
  captchaHeld(): boolean {
    const captchaAt = this.state.captchaAt;
    return captchaAt !== null && Date.now() - captchaAt < this.state.captchaMemoryMs;
  }

  /** How long until the transport may send another request this hour, 0 when it may now. */
  pacedMs(): number {
    const now = Date.now();
    const sentAt = this.state.sentAt = this.state.sentAt.filter((at) => now - at < HOUR_MS);
    return sentAt.length < HOURLY_REQUESTS ? 0 : sentAt[sentAt.length - HOURLY_REQUESTS]! + HOUR_MS - now;
  }

  /** Whether tracking would fail without a request, held by a CAPTCHA or paced. */
  withheld(): boolean {
    return this.captchaHeld() || this.pacedMs() > 0;
  }

  private async checkSettings(budget: LookupBudget): Promise<void> {
    this.state.settingsCheckedAt = null;
    const checkedAt = Date.now();
    const settings = await this.request(budget, 'countrySettingsBySettingName', 'common', { countryCode: 'GB', settingNames: ['api_awb_encryption'] });
    if (!Array.isArray(settings) || settings.length > 20 || settings.some((setting) => !isRecord(setting))) throw new SchemaError(PROVIDER, 'DHL mobile tracking returned invalid settings');
    const encryption = settings.filter(isRecord).filter((setting) => setting.name === 'api_awb_encryption');
    if (encryption.length !== 1 || (encryption[0]!.value !== 'N' && encryption[0]!.value !== 'Y')) throw new SchemaError(PROVIDER, 'DHL mobile tracking returned invalid encryption settings');
    if (encryption[0]!.value === 'Y') throw new ChallengeError(PROVIDER, 'DHL mobile tracking requires waybill encryption');
    this.state.settingsCheckedAt = checkedAt;
  }

  private async request(budget: LookupBudget, method: string, service: string, extra: Record<string, unknown>): Promise<unknown> {
    budget.signal.throwIfAborted();
    this.state.sentAt.push(Date.now());
    const { response, bytes } = await fetchBounded(`${API}?${new URLSearchParams({ appVersion: VERSION, service: `${service}-${method}` })}`, {
      method: 'POST', signal: budget.signal,
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: APPLICATION_BEARER,
        'cache-control': 'no-cache', transactionId: randomUUID(), 'user-agent': this.environment.userAgent ?? 'Mozilla/5.0' },
      body: JSON.stringify({ method, service, authentication: { provider: 'DEMP.RS1', token: '', login: '' },
        data: { parameters: {}, timezoneOffset: '+00:00', appVersion: VERSION, UIClient: 'Android',
          device_info: { device_unique_id: this.device, deviceId: this.device, device_language: 'en', app_id: APP,
            platform: 'Android', appStore: 'PlayStore', gpsLoc: '', pushToken: '' }, ...extra } }),
    }, { provider: PROVIDER, timeoutMs: budget.remainingMs(), maxBytes: 1_000_000, fetcher: this.environment.fetcher,
      allowHttpStatuses: [400, 404, 410, 503] });
    budget.signal.throwIfAborted();
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'DHL mobile tracking endpoint is unavailable', { status: response.status });
    if (/^\s*</.test(decodeText(bytes))) {
      if (response.status !== 200) throw new UpstreamHttpError(PROVIDER, response.status);
      throw new ChallengeError(PROVIDER, 'DHL mobile tracking rejected the request');
    }
    let payload: unknown;
    try { payload = parseJsonBytes(bytes, PROVIDER); }
    catch (error) {
      if (response.status !== 200) throw new UpstreamHttpError(PROVIDER, response.status);
      throw new SchemaError(PROVIDER, 'DHL mobile tracking returned invalid JSON', { cause: error });
    }
    try { checkReply(payload, response.status); }
    catch (error) {
      if (error instanceof CaptchaError) {
        const state = this.state;
        const now = Date.now();
        if (state.captchaAt === null) state.captchaMemoryMs = CAPTCHA_MEMORY_MS;
        // The first request after a pause drew it again, so the next pause is longer.
        else if (now - state.captchaAt >= state.captchaMemoryMs) state.captchaMemoryMs = Math.min(state.captchaMemoryMs * 2, MAX_CAPTCHA_MEMORY_MS);
        state.captchaAt = now;
      }
      throw error;
    }
    if (response.status !== 200) throw new UpstreamHttpError(PROVIDER, response.status);
    this.state.captchaAt = null;
    return payload;
  }
}

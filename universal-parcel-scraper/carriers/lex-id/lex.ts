import { recognizeFromLookup, accepted, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierId } from '../../generated/catalog.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { lexStatus } from './status.js';

/** A LEX site on Lazada's logistics platform: its host, its numbers and how the search finds one. */
export interface LexTenant {
  readonly carrier: CarrierId;
  readonly provider: string;
  readonly origin: string;
  readonly timezone: string;
  /** The number, in detection's form, as the tracker files it, or null when it is not one of the tenant's. */
  readonly asked: (number: string) => string | null;
  readonly shape: string;
}

// A reply lists a few packages; an empty one is a few dozen bytes.
const MAX_BYTES = 64 * 1024;
const MAX_PACKAGES = 20;
const DEFAULT_BUDGET_MS = 20_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// Alibaba's bot checks: the slider page and the JSON that points to it.
const CHALLENGE = /x5secdata|_____tmd_____|\/punish\b|baxia|FAIL_SYS_USER_VALIDATE|nc_1_n1z|<title>\s*(?:Access Denied|验证)/i;

/** The search endpoint of a tenant. */
export const lexSearchUrl = (tenant: LexTenant): string => `${tenant.origin}/api/search_packages`;

/** The tenant's form of a number, or an input error. */
export function lexNumber(tenant: LexTenant, raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? tenant.asked(normalizeTrackingNumber(raw)) : null;
  if (!number) throw new InvalidInputError(tenant.provider, `${tenant.provider} numbers are ${tenant.shape}`);
  return number;
}

const text = (value: unknown, max = 64): string => (typeof value === 'string' && value.length <= max ? value.trim() : '');

/**
 * The search's answer for one number: `{success, data: [package]}`, each
 * package with its tracking number, the number it was first given, its
 * current status key and the first and last mile networks. It carries no
 * scan, time or place: the history needs the last digits of the recipient's
 * phone. A package must name the number asked; an empty list is a number the
 * tracker does not hold.
 */
export function parseLexSearch(payload: unknown, number: string, tenant: LexTenant): CarrierResult {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.data) || payload.data.length > MAX_PACKAGES) {
    throw new SchemaError(tenant.provider, `${tenant.provider} returned an invalid search reply`);
  }
  if (!payload.data.length) throw new NotFoundError(tenant.provider, `${tenant.provider} holds no package for this number`);
  const asked = normalizeTrackingNumber(number);
  const own = payload.data.filter(isRecord).find((item) => [item.trackingNumber, item.originalTrackingNumber]
    .some((value) => text(value) && normalizeTrackingNumber(text(value)) === asked));
  if (!own) throw new IndeterminateError(tenant.provider, `${tenant.provider} answered for another number`);
  const key = text(own.packageStatus);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) throw new SchemaError(tenant.provider, `${tenant.provider} returned an invalid package status`);
  const mapped = lexStatus(key);
  return {
    status: mapped?.stage ? languageStageStatus(mapped.stage) : 'unknown',
    ...(mapped?.stage ? { current_stage: mapped.stage, current_stage_source: 'carrier_map' as const } : {}),
    provider_code: key,
    last_status_text: mapped?.title ?? key,
    last_update: null,
    expected_delivery: null,
    timezone: tenant.timezone,
    summary_only: true,
    events: [],
  };
}

export class LexTracker {
  constructor(private readonly tenant: LexTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { provider } = this.tenant;
    const { response, bytes } = await fetchBounded(lexSearchUrl(this.tenant), { method: 'POST', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
      body: JSON.stringify({ trackingNumbers: [number] }),
    }, { provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    const body = decodeText(bytes);
    if (CHALLENGE.test(body.slice(0, 16_000))) throw new ChallengeError(provider, `${provider} answered with a bot check`);
    // The search answers every number with HTTP 200: a redirect or a missing route is a moved endpoint, not a missing parcel.
    if (response.status !== 200) throw new TransportError(provider, `${provider} search moved`, { status: response.status });
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new SchemaError(provider, `${provider} returned a search reply that is not JSON`);
    }
    return parseLexSearch(payload, number, this.tenant);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = lexNumber(this.tenant, raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: this.tenant.carrier, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

/** The adapter of a LEX tenant. */
export const lexAdapter = (tenant: LexTenant): AdapterFactory => (environment) => {
  const tracker = new LexTracker(tenant, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: tenant.carrier, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => lexNumber(tenant, number))),
  };
};

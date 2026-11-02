import { validatePlanzerSharedUrl } from '../../core/catalog/urls.js';
export { validatePlanzerSharedUrl } from '../../core/catalog/urls.js';

/**
 * Planzer shared shipments.
 *
 * A `999.90.########` shipment is not in the tracking API. Planzer publishes
 * it as a capability link — `trackandtrace.planzergroup.com/shared/sendungen/
 * {number}?accessKey=…` — which renders the five-step route page. The access
 * key is part of the tracking credential and is validated before the lookup.
 *
 * The page carries no status code, so the route steps are read from the
 * markup: their tooltip labels name the stage, `text-primary` marks the ones
 * already reached, and the `<time datetime>` next to each carries its
 * timestamp.
 */
import { load } from 'cheerio';
import { lookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { isPlanzerSharedTrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  PLANZER_ROUTE_STAGES,
  PLANZER_ROUTE_STATUS,
  planzerRouteStage,
  type PlanzerRouteStage,
} from './status.js';

export { isPlanzerSharedTrackingNumber, normalizeTrackingNumber };

const PROVIDER = 'Planzer';
const UPSTREAM = 'Planzer shared tracking';
const DEFAULT_TIMEOUT_MS = 15_000;
const EVENT_DESCRIPTIONS: Record<PlanzerRouteStage, string> = {
  registered: 'Shipment registered by Planzer',
  accepted: 'Shipment accepted from the sender',
  in_transit: 'Shipment at the transfer depot',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};
const NOT_FOUND_MESSAGES = new Set([
  'keine sendungen gefunden.',
  'aucun envoi trouve.',
  'nessuna spedizione trovata.',
  'no shipments found.',
]);

interface RouteStep {
  label: string;
  reached: boolean;
  timestamp: string;
}

/**
 * Accepts only a complete, https Planzer shared link for this very shipment,
 * with exactly one well-formed access key. Returns the canonical URL to fetch.
 */


/** Projects one shared route page. Pure: the offline tests target this. */
export function parsePlanzerTrackingHtml(html: string, trackingNumber: string): CarrierResult {
  const $ = load(html);
  const notice = $('p.lead').first().text().trim()
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  const timestamps = $('time[datetime]').toArray()
    .map((element) => ($(element).attr('datetime') ?? '').trim())
    .filter(Boolean);
  const steps: RouteStep[] = [];
  $('div.text-center').each((_, element) => {
    const container = $(element);
    const target = container.find('span.tooltip-target').first();
    if (target.length === 0) return;
    const label = (target.attr('data-original-title') ?? target.attr('title') ?? '').trim();
    if (!label) return;
    steps.push({
      label,
      reached: target.hasClass('text-primary'),
      timestamp: (container.find('time[datetime]').first().attr('datetime') ?? '').trim(),
    });
  });

  const seen = new Set<string>();
  const uniqueSteps = steps.filter((step) => {
    const key = step.label.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueSteps.length < PLANZER_ROUTE_STAGES.length) {
    // A short page is only "unknown shipment" when Planzer says so; anything
    // else (maintenance, a partial render) must stay an error.
    if (NOT_FOUND_MESSAGES.has(notice)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Planzer returned an invalid tracking page');
  }

  const events: Array<{ time: string; location: string; description: string }> = [];
  let currentStage: PlanzerRouteStage | null = null;
  let currentLabel = '';
  uniqueSteps.slice(0, PLANZER_ROUTE_STAGES.length).forEach((step, index) => {
    const stage = planzerRouteStage(step.label) ?? PLANZER_ROUTE_STAGES[index]!;
    if (!step.reached) return;
    currentStage = stage;
    currentLabel = step.label || EVENT_DESCRIPTIONS[stage];
    events.push({
      time: step.timestamp,
      location: '',
      // The rendered label is the recipient's language; the retained
      // description is our own neutral wording for the stage.
      description: EVENT_DESCRIPTIONS[stage],
    });
  });
  if (!currentStage) {
    throw new SchemaError(PROVIDER, 'Planzer returned a shipment without a current stage');
  }
  const dates = [...new Set(
    timestamps.filter((timestamp) => /^\d{4}-\d{2}-\d{2}/.test(timestamp))
      .map((timestamp) => timestamp.slice(0, 10)),
  )].sort();
  return {
    status: PLANZER_ROUTE_STATUS[currentStage],
    last_status_text: currentLabel,
    last_update: events.at(-1)?.time || null,
    expected_delivery: dates.at(-1) ?? null,
    events: events.reverse(),
    tracking_number: normalizeTrackingNumber(trackingNumber),
  };
}

export class PlanzerSharedTracker {
  private readonly fetcher: typeof fetch | undefined;
  readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}) {
    this.fetcher = options.fetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = userAgentOf(options.userAgent);
  }

  async fetch(trackingNumber: string, trackingUrl: string, context: TrackingContext = {}): Promise<CarrierResult> {
    let url: string;
    try {
      url = validatePlanzerSharedUrl(trackingUrl, trackingNumber);
    } catch (error) {
      // A link that is not this shipment's is the caller's credential, rejected before any request.
      if (error instanceof TypeError) throw new InvalidInputError(PROVIDER, error.message, { cause: error });
      throw error;
    }
    const budget = lookupBudget(context, this.timeoutMs);
    const { bytes } = await fetchBounded(url, {
      signal: budget.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
        'User-Agent': this.userAgent,
      },
    }, {
      provider: UPSTREAM,
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      fetcher: this.fetcher,
    });
    return parsePlanzerTrackingHtml(decodeText(bytes), trackingNumber);
  }
}

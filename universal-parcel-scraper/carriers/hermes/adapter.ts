import { lookupBudget, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isValidSscc } from '../../core/detection/numericChecksums.js';
import { NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { clean, cleanScalar, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { hermesEventStage, hermesStatus } from './status.js';

export { hermesStatus };

// Hermes Einrichtungs-Service (two-man furniture and white-goods delivery) is a
// different company from Hermes Germany's parcel network; its public order
// lookup lives on myhes.de and takes the consignment number alone.
const HERMES_API = 'https://myhes.de/api/request/auftragsdaten';
const PROVIDER = 'Hermes';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HermesOptions {
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  userAgent?: string;
}

function normalizeHermesTrackingNumber(raw: unknown): string {
  return cleanScalar(raw, 64).replace(/[\s.-]/g, '').toUpperCase();
}

/** The sender myhes.de names: the specialist dealer, else the shop, else the client. */
function senderOf(body: JsonObject): string {
  const sender = isRecord(body.versenderdaten) ? body.versenderdaten : {};
  const dealer = isRecord(sender.fachhaendler) ? sender.fachhaendler : {};
  return [dealer.name, sender.shopname, sender.name].map((value) => clean(value, 120)).find(Boolean) ?? '';
}

function clock(value: unknown): string {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(clean(value, 16));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '';
  return `${match[1]!.padStart(2, '0')}:${match[2]}`;
}

/** The planned day, with the page's time window when both ends are given. */
function estimateOf(order: JsonObject): string | null {
  if (typeof order.lieferdatum === 'string') {
    const from = clock(order.lieferzeitfensterVon);
    const to = clock(order.lieferzeitfensterBis);
    return from && to && /^\d{4}-\d{2}-\d{2}$/.test(order.lieferdatum)
      ? `${order.lieferdatum} ${from}–${to}`
      : order.lieferdatum;
  }
  return typeof order.hesBasicLieferterminZeit === 'string' ? order.hesBasicLieferterminZeit : null;
}

export function parseHermesTrackingResponse(
  payload: unknown,
  trackingNumber: string,
): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Hermes returned an invalid tracking response');
  const body = isRecord(payload.body) ? payload.body : payload;
  if (!isRecord(body.auftragsdaten)) {
    throw new SchemaError(PROVIDER, 'Hermes returned an invalid tracking response');
  }
  const order = body.auftragsdaten;
  const requested = normalizeHermesTrackingNumber(trackingNumber);
  const deliveryNote = order.lieferscheinnummer ? normalizeHermesTrackingNumber(order.lieferscheinnummer) : '';
  // myhes.de also takes a piece's SSCC (its Kollinummer) and answers with the
  // whole order, which echoes only the delivery note.
  const byPiece = isValidSscc(requested);
  if (!deliveryNote || (deliveryNote !== requested && !byPiece)) {
    throw new SchemaError(PROVIDER, 'Hermes returned a different shipment');
  }
  const journey = isRecord(order.statusjourneyDto) ? order.statusjourneyDto : {};
  if (journey.auftragstatusdaten !== undefined && !Array.isArray(journey.auftragstatusdaten)) {
    throw new SchemaError(PROVIDER, 'Hermes returned invalid tracking history');
  }
  // Hermes's own public UI treats auftragstatusdaten as the customer-facing
  // timeline. statusdaten contains a second, internal operational stream with
  // duplicate scans and different identifiers, so it is intentionally ignored.
  const rawEvents: JsonObject[] = Array.isArray(journey.auftragstatusdaten)
    ? journey.auftragstatusdaten.filter(isRecord)
    : [];
  // The public API answers a valid, unknown 8- or 9-digit consignment with a
  // synthetic order whose identifying/status fields are all null. Do not turn
  // that placeholder into a real-looking pending parcel.
  if (
    rawEvents.length === 0
    && order.auftragId == null
    && order.auftragsart == null
    && order.statusjourneyDto == null
  ) throw new NotFoundError(PROVIDER);
  const meaningfulEvents = rawEvents.flatMap((event) => {
    const description = event.sendungsstatus;
    const time = event.sendungsstatusBuchungszeitpunkt;
    if ((description != null && typeof description !== 'string') || (time != null && typeof time !== 'string')) {
      throw new SchemaError(PROVIDER, 'Hermes returned invalid tracking history');
    }
    return description?.trim() && time?.trim() ? [{ description, time, statusId: event.sendungsstatusId }] : [];
  });
  meaningfulEvents.sort((left, right) => right.time.localeCompare(left.time));
  const events = meaningfulEvents.map((event) => ({
    time: event.time,
    location: '',
    description: event.description,
    stage: hermesEventStage(event.statusId, event.description),
  }));
  const status = meaningfulEvents[0]
    ? hermesStatus(meaningfulEvents[0].statusId, meaningfulEvents[0].description)
    : 'pending';
  const sender = senderOf(body);
  // Once delivered, `lieferdatum` is the delivery day, not an estimate.
  const deliveredAt = status === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status,
    last_status_text: events[0]?.description ?? '',
    last_update: events[0]?.time || null,
    expected_delivery: status === 'delivered' ? null : estimateOf(order),
    ...(sender ? { sender_name: sender } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(deliveryNote !== requested ? { canonical_tracking_number: deliveryNote } : {}),
    timezone: 'Europe/Berlin',
    events,
  };
}

export class HermesTracker {
  readonly timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #userAgent: string;

  constructor(options: number | HermesOptions = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, fetcher, userAgent } = typeof options === 'number'
      ? { timeoutMs: options, fetcher: undefined, userAgent: undefined }
      : options;
    this.timeoutMs = timeoutMs;
    this.#fetcher = fetcher;
    this.#userAgent = userAgentOf(userAgent);
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = new URL(HERMES_API);
    url.searchParams.set('parcelNumber', trackingNumber);
    const budget = lookupBudget(context, this.timeoutMs);
    const { bytes } = await fetchBounded(url, {
      signal: budget.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': this.#userAgent,
      },
    }, {
      provider: 'Hermes tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
    });
    return parseHermesTrackingResponse(parseJsonBytes(bytes, PROVIDER), trackingNumber);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HermesTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'hermes',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context)),
  };
};

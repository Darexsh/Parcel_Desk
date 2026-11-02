import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dynalogicStage, dynalogicStepLabel } from './status.js';

export const PROVIDER = 'Dynalogic';
export const DYNALOGIC_MAX_BYTES = 256_000;
/** The service's notice for a number it holds no order under; the tracker words it as an unknown number. */
export const NOT_FOUND_NOTICE = 'An empty response returned.';
const ZONE = 'Europe/Amsterdam';

/**
 * A track & trace number is the five-digit id Dynalogic gives the merchant,
 * then the merchant's own order number.
 */
export function normalizeDynalogicNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{5}[A-Z0-9]{1,40}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Dynalogic track & trace numbers start with a five-digit customer id');
  }
  return number;
}

/** The notice the service sends in its `error` field, or ''. */
export function dynalogicNotice(payload: unknown): string {
  return isRecord(payload) ? clean(payload.error, 200) : '';
}

/** The minutes an "Ip block untill;<minutes>" notice names: the service has stopped answering this address. */
export function blockedMinutes(notice: string): number | null | undefined {
  if (!/^Ip block untill\b/i.test(notice)) return undefined;
  const minutes = /;\s*(\d{1,5})$/.exec(notice);
  return minutes ? Number(minutes[1]) : null;
}

const among = (value: unknown, allowed: readonly number[]): value is number => typeof value === 'number' && allowed.includes(value);

/** The driver's arrival window, as the tracker draws it while its timeline is on; the clocks are Amsterdam wall clocks. */
function arrivalWindow(progress: unknown): { from: string; to: string } | null {
  // 0 hides the timeline and 1 greys it out.
  if (!isRecord(progress) || typeof progress.TimeLineStatus !== 'number' || among(progress.TimeLineStatus, [0, 1])) return null;
  // The window is given to the minute; the clocks' fractions of a second are noise.
  const at = (value: unknown) => isoTime(typeof value === 'string' ? value.replace(/\.\d{1,7}$/, '') : value, ZONE);
  const from = at(progress.EtaStartDateTime);
  const to = at(progress.EtaEndDateTime);
  return from && to && from.timestamp <= to.timestamp ? { from: from.iso, to: to.iso } : null;
}

export function parseDynalogic(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeDynalogicNumber(rawNumber);
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    throw new SchemaError(PROVIDER, 'Dynalogic returned an invalid order reply');
  }
  const order = payload.data;
  const answered = typeof order.TrackAndTraceNumber === 'string' ? returnedTrackingNumber(order.TrackAndTraceNumber) : '';
  if (!answered) throw new SchemaError(PROVIDER, 'Dynalogic returned an order without its number');
  // The service also finds an order by the merchant's order number or its end;
  // only the whole track & trace number identifies the parcel asked for.
  if (answered !== number) throw new IndeterminateError(PROVIDER, 'Dynalogic answered with another order');

  const scenario = clean(order.Scenario, 20);
  const steps = order.ProgressData;
  if (!/^[A-Z]{1,8}_[A-Z]{1,8}$/.test(scenario) || !Array.isArray(steps) || !steps.length || steps.length > 8) {
    throw new SchemaError(PROVIDER, 'Dynalogic returned an order without its progress');
  }
  let reached = 0;
  let failed = false;
  for (const step of steps) {
    if (!isRecord(step) || !among(step.StepNumber, [1, 2, 3, 4, 5, 6, 7, 8]) || !among(step.Status, [0, 1]) || !among(step.Overlay, [0, 1, 2])) {
      throw new SchemaError(PROVIDER, 'Dynalogic returned an invalid progress step');
    }
    if (step.Status === 1) reached = Math.max(reached, step.StepNumber);
    // The tracker marks a step that went wrong in red.
    if (step.Overlay === 2) failed = true;
  }
  const code = failed && !scenario.endsWith('_FAIL') ? `${scenario}/${reached}/failed` : `${scenario}/${reached}`;
  const stage = dynalogicStage(code);
  const text = textFromHtml(order.DetailCaption, 200) || dynalogicStepLabel(scenario, reached);
  const window = stage === 'out_for_delivery' ? arrivalWindow(order.TransportProgress) : null;

  // The reply's other fields are Dynalogic's own contact details, the driver's
  // and recipient's coordinates and a sentence naming the delivery day without
  // its year; none of them is kept.
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: text || null,
    provider_code: code,
    last_update: null,
    expected_delivery: window?.to ?? null,
    ...(window ? { expected_delivery_from: window.from } : {}),
    summary_only: true,
    events: [],
  };
}

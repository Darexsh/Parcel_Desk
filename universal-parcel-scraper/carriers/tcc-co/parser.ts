import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { TCC_DELIVERED_WORDING, tccStage, tccStepStage } from './status.js';

export const PROVIDER = 'TCC';
export const TCC_MAX_BYTES = 1_000_000;
const MAX_EVENTS = 500;
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/i;
const OPEN_NOVELTIES = new Set(['Planteada', 'Informada', 'Gestión sin contactoEspero', 'Gestión sin contacto', 'Espero']);

export function normalizeTccNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{9}$/.test(number)) throw new InvalidInputError(PROVIDER, 'TCC remesas contain nine digits');
  return number;
}

export function tccJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch {
    if (/_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required)|verify you are human/i.test(text.slice(0, 64_000))) {
      throw new ChallengeError(PROVIDER, 'TCC answered with browser verification');
    }
    throw new SchemaError(PROVIDER, 'TCC returned a reply that is not JSON');
  }
}

function clock(value: unknown): { time: string; timestamp: number } {
  if (typeof value !== 'string' || !OFFSET_ISO.test(value)) throw new SchemaError(PROVIDER, 'TCC returned an invalid scan timestamp');
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== value.slice(0, 19)) {
    throw new SchemaError(PROVIDER, 'TCC returned an invalid scan calendar');
  }
  return { time: value, timestamp: parsed.toMillis() };
}

function rows(value: unknown, key: 'estado' | 'novedad'): unknown[] {
  if (value == null) return [];
  if (!isRecord(value) || !Array.isArray(value[key])) throw new SchemaError(PROVIDER, 'TCC returned an invalid history list');
  return value[key];
}

/** Public secondary history: whole remesa identity, dated states/novelties and completed delivery. */
export function parseTcc(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTccNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.respuesta)) {
    if (isRecord(payload) && typeof payload.message === 'string' && /captcha|verifica|token/i.test(payload.message)) {
      throw new ChallengeError(PROVIDER, 'TCC refused tracking verification');
    }
    throw new SchemaError(PROVIDER, 'TCC returned an invalid tracking envelope');
  }
  const response = payload.respuesta;
  if (response.codigo !== '0' && response.codigo !== 0) {
    if (typeof response.mensaje === 'string' && /captcha|verifica|token/i.test(response.mensaje)) throw new ChallengeError(PROVIDER, 'TCC refused tracking verification');
    if (!['string', 'number'].includes(typeof response.codigo) || !/^-?\d+$/.test(String(response.codigo))) throw new SchemaError(PROVIDER, 'TCC returned no tracking result code');
    throw new IndeterminateError(PROVIDER, 'TCC did not complete its tracking lookup');
  }
  // Expired genuine remesas and unknown numbers share this success/null reply.
  if (payload.remesas == null) throw new NoHistoryError(PROVIDER);
  if (!isRecord(payload.remesas) || !Array.isArray(payload.remesas.remesa)) throw new SchemaError(PROVIDER, 'TCC returned an invalid shipment list');
  const shipments = payload.remesas.remesa;
  if (!shipments.length) throw new NoHistoryError(PROVIDER);
  if (shipments.length !== 1) throw new IndeterminateError(PROVIDER, 'TCC returned several remesas for one request');
  const shipment: unknown = shipments[0];
  if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'TCC returned an invalid shipment');
  const identity = typeof shipment.numeroremesa === 'string' ? normalizeTrackingNumber(shipment.numeroremesa)
    : typeof shipment.numeroremesa === 'number' && Number.isSafeInteger(shipment.numeroremesa) ? String(shipment.numeroremesa) : null;
  if (identity === null) throw new SchemaError(PROVIDER, 'TCC returned no whole remesa number');
  if (identity !== number) throw new IndeterminateError(PROVIDER, 'TCC answered for another remesa');
  const step = typeof shipment.pasoestado === 'string' || typeof shipment.pasoestado === 'number' ? String(shipment.pasoestado) : '';
  const summary = tccStepStage(step);
  if (!summary) throw new IndeterminateError(PROVIDER, 'TCC returned no supported progress position');
  const history = rows(shipment.estados, 'estado'), novelties = rows(shipment.novedades, 'novedad');
  if (history.length + novelties.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'TCC returned excessive history');
  const scans: { event: CarrierEvent; timestamp: number; open: boolean; stage?: Stage }[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, novelty: boolean) => {
    if (!isRecord(value) || typeof value.descripcion !== 'string' || !value.descripcion || value.descripcion.length > 4000) {
      throw new SchemaError(PROVIDER, 'TCC returned an invalid history row');
    }
    const at = clock(value.fecha), description = clean(value.descripcion, 500);
    if (!description) throw new SchemaError(PROVIDER, 'TCC returned unnamed history');
    let code: string | null = null;
    if (novelty && value.codigo != null) {
      if ((typeof value.codigo !== 'string' && typeof value.codigo !== 'number') || !/^\d{1,12}$/.test(String(value.codigo))) throw new SchemaError(PROVIDER, 'TCC returned an invalid novelty code');
      code = String(value.codigo);
    }
    if (novelty && value.estado != null && typeof value.estado !== 'string') throw new SchemaError(PROVIDER, 'TCC returned an invalid novelty resolution');
    const key = JSON.stringify([at.timestamp, description]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = tccStage(code, description);
    scans.push({ timestamp: at.timestamp, open: novelty && typeof value.estado === 'string' && OPEN_NOVELTIES.has(value.estado), stage: staged?.stage,
      event: { time: at.time, description, ...(code ? { provider_code: code } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } });
  };
  // The novelty carries a code and resolution that an identical history row lacks.
  for (const row of novelties) add(row, true);
  for (const row of history) add(row, false);
  if (!novelties.length && shipment.novedad != null && shipment.fechanovedad != null) {
    add({ descripcion: shipment.novedad, fecha: shipment.fechanovedad, estado: shipment.estadonovedad }, true);
  }
  const delivery = step === '6' && shipment.fechaentrega != null && shipment.fechaentrega !== '' ? clock(shipment.fechaentrega) : null;
  if (delivery && !scans.some(scan => scan.timestamp === delivery.timestamp && scan.event.stage === 'delivered')) {
    scans.push({ timestamp: delivery.timestamp, open: false, stage: 'delivered',
      event: { time: delivery.time, description: TCC_DELIVERED_WORDING, stage: 'delivered', stage_source: 'carrier_map' } });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  if (step === '6' && !delivery && !scans.some(scan => scan.event.stage === 'delivered')) throw new IndeterminateError(PROVIDER, 'TCC returned no dated delivery milestone');
  scans.sort((left, right) => right.timestamp - left.timestamp);
  const latest = scans[0]!;
  if (delivery && scans.some(scan => scan.timestamp > delivery.timestamp && ['failed_attempt', 'exception'].includes(scan.event.stage ?? ''))) {
    throw new IndeterminateError(PROVIDER, 'TCC returned conflicting delivery milestones');
  }
  const unresolved = step !== '6' && latest.open && latest.stage && ['failed_attempt', 'exception', 'customs'].includes(latest.stage);
  const stage = unresolved ? latest.stage! : summary;
  return { status: languageStageStatus(stage), current_stage: stage, current_stage_source: unresolved ? latest.event.stage_source! : 'carrier_map',
    last_status_text: latest.event.description!, last_update: latest.event.time!, expected_delivery: null,
    history_truncated: true, events: scans.map(scan => scan.event) };
}

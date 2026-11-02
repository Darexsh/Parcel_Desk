import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifySeurStatus, isSeurDelay } from './status.js';

export function normalizeSeurNumber(raw: string): string {
  const number = raw.replace(/\s/g, '').toUpperCase();
  // Twenty-two digits is a sender's reference, which the lookup also finds, as
  // it finds twelve digits a provider names SEUR for, and a pickup's REC reference.
  if (!/^(?:\d{7}|\d{12}|\d{14}|\d{21}|\d{22}|REC\d{12})$/.test(number)) {
    throw new InvalidInputError('SEUR', 'SEUR requires a seven, twelve, fourteen, twenty-one or twenty-two digit identifier, or a pickup reference');
  }
  return number;
}

/**
 * A number recognition can ask about. The seven-digit expedition number is
 * reused: about a third of random ones find a recent shipment, so a hit says
 * nothing about whose parcel it is.
 */
export function normalizeSeurRecognitionNumber(raw: string): string {
  const number = normalizeSeurNumber(raw);
  if (number.length === 7) throw new InvalidInputError('SEUR', 'SEUR recognition does not ask about seven-digit expedition numbers');
  return number;
}

function field(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw new SchemaError('SEUR', 'SEUR returned an invalid scan field');
  return clean(value, limit);
}

function scanTime(value: unknown): { time?: string; local_time?: string; provider_time_text?: string } {
  if (value == null || value === '') return {};
  const raw = field(value, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):?(\d{2}))?$/i.exec(raw);
  if (match && calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
    && Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60
    && (!match[8] || (Number(match[8]) < 24 && Number(match[9]) < 60))) {
    if (!match[7]) return { local_time: raw };
    // SEUR marks Spanish wall clocks with Z: DPD reports the same scans with
    // Madrid's offset. A scan names no place, and SEUR also scans in the
    // Canary Islands, so its zone is unknown. Only a numeric offset makes an instant.
    if (match[7].toUpperCase() === 'Z') return { local_time: raw.slice(0, -1) };
    const parsed = explicitOffsetTime(raw);
    if (parsed) return { time: parsed.iso };
  }
  return raw ? { provider_time_text: raw } : {};
}

export function parseSeur(value: unknown, raw: string): CarrierResult {
  const number = normalizeSeurNumber(raw);
  if (!isRecord(value) || !Object.hasOwn(value, 'codigo_error')) throw new SchemaError('SEUR', 'SEUR tracking response changed');
  // The same lookup error covers absent, recent and out-of-range histories.
  // It does not establish that the requested parcel never existed. The reason
  // marks the known code as an answer about the number, not an outage.
  if (value.codigo_error != null) throw new IndeterminateError('SEUR', 'SEUR did not locate usable shipment history',
    value.codigo_error === 'ERR_CNSPLI_002' && value.situaciones == null ? { reason: 'portal_not_found' } : {});
  if (value.identificador_busqueda !== number || typeof value.clave_envio !== 'string'
    || !value.clave_envio || value.clave_envio.length > 80) throw new SchemaError('SEUR', 'SEUR returned a different or incomplete shipment');
  if (!Array.isArray(value.situaciones)) throw new SchemaError('SEUR', 'SEUR tracking scans changed');
  if (!value.situaciones.length) throw new IndeterminateError('SEUR', 'SEUR returned empty shipment history');
  if (value.situaciones.length > 500) throw new SchemaError('SEUR', 'SEUR returned too many tracking scans');
  if (value.num_bultos !== 1) throw new IndeterminateError('SEUR', 'SEUR single-piece shipment history is required');
  if (value.bultos != null && (!Array.isArray(value.bultos) || value.bultos.length > 1
    || value.bultos.some(piece => !isRecord(piece)))) {
    throw new IndeterminateError('SEUR', 'SEUR returned ambiguous parcel details');
  }
  const events: CarrierEvent[] = value.situaciones.map(row => {
    if (!isRecord(row)) throw new SchemaError('SEUR', 'SEUR returned an invalid scan');
    const code = field(row.cod_situacion, 12);
    const group = field(row.grupo_situacion, 80);
    const label = field(row.descripcion_situacion, 500);
    if (!/^[A-Z0-9]{2,12}$/.test(code) || !group || !label) throw new SchemaError('SEUR', 'SEUR returned an incomplete scan');
    const mapped = classifySeurStatus(code, group, label);
    return { description: mapped?.status === 'delivered' ? 'Delivered' : label, provider_status: label,
      provider_group: group, provider_code: code, ...(mapped ? { stage: mapped.stage } : {}), ...scanTime(row.fecha) };
  });
  const delay = (event: CarrierEvent) => isSeurDelay(event.provider_code!, String(event.provider_group), String(event.provider_status));
  // Oldest first: a delay notice keeps the stage of the scan before it. SEUR delays a shipment on
  // its way, so a notice with no stage before it, which may be all SEUR lists, is in transit.
  let previous: string | undefined;
  for (const event of [...events].reverse()) {
    if (!delay(event)) previous = event.stage ?? previous;
    else Object.assign(event, { stage: previous ?? 'in_transit', stage_source: 'none' });
  }
  // The official widget consumes situaciones[0]; unresolved clocks retain that position.
  // Its status is the newest scan's other than a delay notice.
  const latest = events[0]!;
  const current = events.find((event) => !delay(event));
  const mapped: ClassifiedStatus | undefined = current
    ? classifySeurStatus(current.provider_code!, String(current.provider_group), String(current.provider_status))
    : { status: 'in_transit', stage: 'in_transit' };
  const weight = value.peso;
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    ...(mapped?.status === 'delivered' && current?.time ? { delivered_at: current.time } : {}),
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight <= 100_000 ? { weight_kg: weight } : {}),
    events: events.slice(0, 100) };
}

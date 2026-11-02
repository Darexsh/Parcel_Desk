import { DateTime, IANAZone } from 'luxon';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { classifyCorreiosStatus } from './status.js';

export function normalizeCorreiosNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number) || !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError('Correios', 'Correios requires a valid postal S10 tracking number');
  }
  return number;
}

export function isCorreiosCaptchaError(payload: unknown): boolean {
  return isRecord(payload) && (payload.erro === true || payload.erro === 'true')
    && clean(payload.mensagem, 100).toLowerCase() === 'captcha inválido';
}

function scanClock(value: unknown): Pick<CarrierEvent, 'time'> & { local_time?: string; provider_time_text?: string } {
  const raw = clean(isRecord(value) ? value.date : value, 64);
  const digits = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/.exec(raw)?.[1];
  const wall = digits ? DateTime.fromFormat(digits, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }) : null;
  if (!wall?.isValid) return raw ? { provider_time_text: raw } : {};
  const local = wall.toISO({ includeOffset: false, suppressMilliseconds: true });
  const zone = isRecord(value) && value.timezone_type === 3 ? clean(value.timezone, 64) : '';
  if (!zone || !IANAZone.isValidZone(zone)) return { local_time: local };
  // Use the explicit per-row zone only when its clock exists uniquely. Do not
  // silently shift a nonexistent DST clock or choose between repeated clocks.
  const zoned = firstOccurrence(DateTime.fromFormat(digits!, 'yyyy-MM-dd HH:mm:ss', { zone }));
  if (!zoned.isValid || zoned.toFormat('yyyy-MM-dd HH:mm:ss') !== digits || zoned.getPossibleOffsets().length !== 1) {
    return { local_time: local };
  }
  return { time: zoned.toISO({ suppressMilliseconds: true }) };
}

// The portal shows its delivery forecast only for an object in transit
// (situacao T) that it does not mark as late.
function expectedDay(payload: JsonObject, stage: string | undefined): string | null {
  if (payload.situacao !== 'T' || payload.atrasado === true) return null;
  if (stage && ['delivered', 'returned', 'ready_for_pickup'].includes(stage)) return null;
  const day = DateTime.fromFormat(clean(payload.dtPrevista, 16), 'dd/MM/yyyy', { zone: 'UTC' });
  return day.isValid ? day.toISODate() : null;
}

const POSTINGS = new Set(['PO/01', 'PO/09']);

/**
 * Mail from abroad can list the sending post's posting twice, the second time
 * when that post dispatched the item: a later posting is the item moving on,
 * not a second acceptance. Events are newest first.
 */
function laterPostingsInTransit(events: CarrierEvent[]): void {
  let posted = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (!POSTINGS.has(event.provider_code ?? '')) continue;
    if (posted) events[index] = { ...event, stage: 'in_transit' };
    posted = true;
  }
}

export function parseCorreios(payload: unknown, number: string): CarrierResult {
  const requested = normalizeCorreiosNumber(number);
  if (!isRecord(payload)) throw new SchemaError('Correios');
  if (isCorreiosCaptchaError(payload)) throw new ChallengeError('Correios', 'Correios rejected the text CAPTCHA');
  // Period errors and other unbound error replies prove neither absence nor identity.
  if (payload.erro === true || payload.erro === 'true') throw new IndeterminateError('Correios', 'Correios returned an inconclusive tracking response');
  if (payload.codObjeto !== requested) throw new SchemaError('Correios', 'Correios returned a different tracking object');
  if (!Array.isArray(payload.eventos) || payload.eventos.length > 500) throw new SchemaError('Correios');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of payload.eventos) {
    if (!isRecord(row)) throw new SchemaError('Correios', 'Correios returned an incomplete scan');
    const code = clean(row.codigo, 8);
    const subtype = clean(row.tipo, 8);
    const description = clean(row.descricao, 500);
    if (!/^[A-Z]{2,4}$/.test(code) || !/^\d{2}$/.test(subtype) || !description) throw new SchemaError('Correios', 'Correios returned an incomplete scan');
    const providerCode = `${code}/${subtype}`;
    const clock = scanClock(row.dtHrCriado);
    const address = isRecord(row.unidade) && isRecord(row.unidade.endereco) ? row.unidade.endereco : null;
    const location = address ? [clean(address.cidade, 100), clean(address.uf, 8)].filter(Boolean).join(', ') : '';
    const key = `${clock.time ?? clock.local_time ?? clock.provider_time_text ?? ''}\u0000${providerCode}\u0000${description}\u0000${location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mapped = classifyCorreiosStatus(providerCode);
    events.push({ description, provider_code: providerCode, ...clock, ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage } : {}) });
  }
  if (!events.length) throw new IndeterminateError('Correios', 'Correios returned no tracking scans');
  laterPostingsInTransit(events);
  // The single-object response is newest first. Keep unresolved clocks there.
  const latest = events[0]!;
  const mapped = classifyCorreiosStatus(latest.provider_code ?? '');
  const service = isRecord(payload.tipoPostal) ? clean(payload.tipoPostal.categoria, 80) : '';
  return { status: mapped?.status ?? 'unknown', ...(latest.stage ? { current_stage: latest.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: expectedDay(payload, latest.stage), ...(mapped?.status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(service ? { service_name: service } : {}), events: events.slice(0, 100) };
}

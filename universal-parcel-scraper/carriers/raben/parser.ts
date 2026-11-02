import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { rabenStage } from './status.js';

export const PROVIDER = 'Raben';
// The session's data are about 60 kB, plus a few hundred bytes a status row.
export const RABEN_MAX_BYTES = 1024 * 1024;

// The search takes shipment numbers, references and colli labels alike.
const NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
const SHIPMENT_PAGE = 'Anonymous.Anon_Shipment_NP';
const NOT_FOUND_PAGE = 'Anonymous.AnonymousShipment_ShipmentNotFound';
// The planned delivery day is shown without a time; it is read in Raben's home zone.
const ZONE = 'Europe/Warsaw';
const SETTLED: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
const MAX_OBJECTS = 2000;
const MAX_ROWS = 500;
const GUID = /^\d{1,20}$/;
const KEY = /^[A-Za-z0-9_]{1,100}$/;
const CODE = /^(E\d{2})_/;
const DECIMAL = /^\d{1,9}(?:\.\d{1,9})?$/;
const INTEGER = /^-?\d{1,9}$/;

/** The number as the search reads it: letters and digits, with at least one digit. */
export function normalizeRabenNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (NUMBER.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Raben tracks shipment numbers of letters and digits');
}

interface Entity { type: string; guid: string; values: ReadonlyMap<string, unknown> }

/**
 * The reply's objects with their values. Each object lists its attributes
 * with empty defaults, and the reply's `changes` carry the values the session
 * gave them.
 */
function entitiesOf(payload: Record<string, unknown>): Map<string, Entity> {
  const { objects, changes = {} } = payload;
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS || !isRecord(changes)) {
    throw new SchemaError(PROVIDER, 'Raben returned a reply without its objects');
  }
  const entities = new Map<string, Entity>();
  for (const object of objects as unknown[]) {
    if (!isRecord(object) || typeof object.objectType !== 'string' || typeof object.guid !== 'string' || !GUID.test(object.guid)
      || !isRecord(object.attributes) || entities.has(object.guid)) {
      throw new SchemaError(PROVIDER, 'Raben returned an invalid object');
    }
    const values = new Map<string, unknown>();
    for (const [name, attribute] of Object.entries(object.attributes)) if (isRecord(attribute)) values.set(name, attribute.value);
    const changed: unknown = Object.hasOwn(changes, object.guid) ? changes[object.guid] : {};
    if (!isRecord(changed)) throw new SchemaError(PROVIDER, 'Raben returned invalid changes');
    for (const [name, change] of Object.entries(changed)) if (isRecord(change)) values.set(name, change.value);
    entities.set(object.guid, { type: object.objectType, guid: object.guid, values });
  }
  return entities;
}

/** An optional text attribute; anything but a string is a changed reply. */
function text(entity: Entity, key: string, maxLength: number): string {
  const value = entity.values.get(key);
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Raben returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An enumeration's key, such as `E03_The_shipment_delivered` or `Austria`. */
function enumKey(entity: Entity, key: string): string {
  const value = text(entity, key, 200);
  if (value && !KEY.test(value)) throw new SchemaError(PROVIDER, `Raben returned an invalid ${key}`);
  return value;
}

/** The object another refers to, by its id. */
function reference(entity: Entity, key: string): string {
  const value = entity.values.get(key);
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || !GUID.test(value)) throw new SchemaError(PROVIDER, `Raben returned an invalid ${key}`);
  return value;
}

/** A date and time, as epoch milliseconds. */
function epoch(entity: Entity, key: string): number | null {
  const value = entity.values.get(key);
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new SchemaError(PROVIDER, `Raben returned an invalid ${key}`);
  return value;
}

/** A positive decimal, which the reply writes as a string; zero is unset. */
function decimal(entity: Entity, key: string): number | null {
  const value = entity.values.get(key);
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new SchemaError(PROVIDER, `Raben returned an invalid ${key}`);
  const amount = Number(value);
  return amount > 0 ? amount : null;
}

/** A whole number, which the reply writes as a string; zero when unset. */
function integer(entity: Entity, key: string): number {
  const value = entity.values.get(key);
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'string' || !INTEGER.test(value)) throw new SchemaError(PROVIDER, `Raben returned an invalid ${key}`);
  return Number(value);
}

/** An enumeration's captions by key, in the language the page asked for. */
function captions(payload: Record<string, unknown>, name: string): Map<string, string> {
  const enumerations = payload.enumerations;
  const pairs = isRecord(enumerations) && Object.hasOwn(enumerations, name) ? enumerations[name] : undefined;
  if (!Array.isArray(pairs)) throw new SchemaError(PROVIDER, `Raben returned no ${name} captions`);
  const map = new Map<string, string>();
  for (const pair of pairs as unknown[]) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      throw new SchemaError(PROVIDER, `Raben returned invalid ${name} captions`);
    }
    map.set(pair[0], clean(pair[1], 200));
  }
  return map;
}

/** The page the session opened for the number, and its parameters. */
function openedPage(payload: Record<string, unknown>): { name: string; parameters: Record<string, unknown> } {
  if (!Array.isArray(payload.instructions)) throw new SchemaError(PROVIDER, 'Raben returned a reply without instructions');
  const forms = (payload.instructions as unknown[]).filter(instruction => isRecord(instruction) && instruction.type === 'open_form');
  if (!forms.length) throw new IndeterminateError(PROVIDER, 'Raben opened no page for the number');
  const args = forms.length === 1 && isRecord(forms[0]) ? forms[0].args : undefined;
  if (!isRecord(args) || typeof args.FormName !== 'string') throw new SchemaError(PROVIDER, 'Raben returned an invalid page');
  return { name: args.FormName, parameters: isRecord(args.FormParameters) ? args.FormParameters : {} };
}

/** A status key's own words, for a key the captions lack. */
function wordsOf(key: string): string {
  return key.replace(CODE, '').replaceAll('_', ' ').trim() || key;
}

interface Scan { event: CarrierEvent; at: number; zone: string; sequence: number; index: number }

interface Vocabulary { statuses: Map<string, string>; countries: Map<string, string> }

/** A status's code, its caption and its stage. */
function statusOf(key: string, vocabulary: Vocabulary): { code: string; description: string; staged: ClassifiedWording | null } {
  const code = CODE.exec(key)?.[1] ?? key;
  const description = vocabulary.statuses.get(key) || wordsOf(key);
  return { code, description, staged: rabenStage(code, description) };
}

/**
 * One row of the status history. `TimeStamp` is an instant, which the page
 * shows in the visitor's zone; it is written in the zone of the row's
 * country, or in UTC for a country with several zones or one it does not
 * know. Remarks are left out.
 */
function scanOf(row: Entity, index: number, vocabulary: Vocabulary): Scan {
  const key = enumKey(row, 'DisplayShipmentStatus');
  const at = epoch(row, 'TimeStamp');
  if (!key || at === null) throw new SchemaError(PROVIDER, 'Raben returned a status row without its status or time');
  const { code, description, staged } = statusOf(key, vocabulary);
  const country = enumKey(row, 'Country');
  const countryName = country ? vocabulary.countries.get(country) || country.replaceAll('_', ' ').trim() : '';
  const iso = countryCode(countryName);
  const zone = (iso ? countryTimeZone(iso) : null) ?? 'utc';
  const location = [text(row, 'City', 80), iso ?? countryName].filter(Boolean).join(', ');
  const event: CarrierEvent = {
    time: instant(at, zone),
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at, zone, sequence: integer(row, 'Sequence'), index };
}

function instant(at: number, zone: string): string {
  return DateTime.fromMillis(at, { zone }).toISO({ suppressMilliseconds: true })!;
}

/** The planned delivery day, as the page shows it: a calendar day, without a time. */
function plannedDay(shipment: Entity): string | null {
  const planned = epoch(shipment, 'DeliveryDate');
  return planned === null ? null : DateTime.fromMillis(planned, { zone: ZONE }).toISODate();
}

type Estimate = Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'>;

/**
 * The page's ETA, a slot from `EtaFrom` to `EtaTo` that the driver's position on the
 * delivery round sets, else the planned delivery day; nothing once the shipment is settled.
 * The slot's ends are instants, written in the zone of the newest row. A slot that ends
 * before that row is a round already gone, and one without both ends in order is not read.
 */
function estimate(shipment: Entity, stage: Stage | undefined, newest: Scan | undefined): Estimate {
  // Each field is read first, so a changed reply fails even for a settled shipment.
  const from = epoch(shipment, 'EtaFrom');
  const to = epoch(shipment, 'EtaTo');
  const planned = plannedDay(shipment);
  if (stage && SETTLED.has(stage)) return { expected_delivery: null };
  if (from !== null && to !== null && from <= to && to >= (newest?.at ?? 0)) {
    const zone = newest?.zone ?? 'utc';
    return { expected_delivery: instant(to, zone), ...(from < to ? { expected_delivery_from: instant(from, zone) } : {}) };
  }
  return { expected_delivery: planned };
}

/**
 * The session data of a myRaben deep link for one number. The session opens
 * the shipment page, whose shipment and status rows are in the reply, or the
 * page saying the shipment could not be found. The search also matches
 * references and colli labels, so the shipment must carry the whole number.
 * Customer-service contacts, colli, volume and remarks are not kept.
 */
export function parseRaben(payload: unknown, raw: string): CarrierResult {
  const number = normalizeRabenNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Raben returned an invalid reply');
  const page = openedPage(payload);
  const entities = entitiesOf(payload);
  const searches = [...entities.values()].filter(entity => entity.type === 'Anonymous.AnonymousPage');
  if (searches.length !== 1) throw new SchemaError(PROVIDER, 'Raben returned an unexpected search');
  const search = searches[0]!;
  if (normalizeTrackingNumber(text(search, 'SearchString', 100)) !== number) throw new SchemaError(PROVIDER, 'Raben answered for a different search');
  if (page.name === NOT_FOUND_PAGE) throw new NotFoundError(PROVIDER);
  if (page.name !== SHIPMENT_PAGE) throw new IndeterminateError(PROVIDER, `Raben opened another page: ${clean(page.name, 80)}`);
  if (page.parameters.$AnonymousPage_Hook !== search.guid) throw new SchemaError(PROVIDER, 'Raben opened the shipment page for another search');

  const shipment = entities.get(reference(search, 'Anonymous.AnonymousPage_ShipmentNP_NP'));
  if (shipment?.type !== 'Anonymous.ShipmentNP') throw new SchemaError(PROVIDER, 'Raben returned a shipment page without its shipment');
  if (normalizeTrackingNumber(text(shipment, 'ShipmentNumber', 100)) !== number) {
    throw new IndeterminateError(PROVIDER, 'The number matched only a reference or colli label of a Raben shipment', { reason: 'reference_only' });
  }

  const vocabulary = { statuses: captions(payload, 'translations.ShipmentStatus'), countries: captions(payload, 'CMS.Countries') };
  const rows = [...entities.values()].filter(entity => entity.type === 'Anonymous.StatusHistory'
    && reference(entity, 'Anonymous.StatusHistory_ShipmentNP') === shipment.guid);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Raben returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = scanOf(row, index, vocabulary);
    // A row the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  // Newest first, as the page lists them. The reply's objects come in no set order; of two rows at
  // the same instant, the page lists the one with the higher sequence first.
  scans.sort((left, right) => right.at - left.at || right.sequence - left.sequence || left.index - right.index);
  const events = scans.map(({ event }) => event);
  const weight = decimal(shipment, 'GrossWeight');

  if (!events.length) {
    // A shipment without rows still has the page's status.
    const key = enumKey(shipment, 'DisplayShipmentStatus');
    if (!key) throw new NoHistoryError(PROVIDER, 'Raben has no status for the shipment yet');
    const { code, description, staged } = statusOf(key, vocabulary);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: description,
      provider_code: code,
      last_update: null,
      ...estimate(shipment, staged?.stage, undefined),
      ...(weight ? { weight_kg: weight } : {}),
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  const decider = events.find(event => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...estimate(shipment, stage, scans[0]),
    ...(stage === 'delivered' ? { delivered_at: decider!.time! } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events,
  };
}

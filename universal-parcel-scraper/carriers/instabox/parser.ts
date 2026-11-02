import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Instabox';
export const MAX_BYTES = 3_000_000;

export function normalizeInstaboxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{4,40}$/.test(number) || !/\d/.test(number)) throw new InvalidInputError(PROVIDER, 'Instabox requires a complete parcel identifier');
  return number;
}

/** Read literal React Flight records only; carrier scripts are never executed. */
export function instaboxJourney(html: string, raw: string): unknown[] {
  const number = normalizeInstaboxNumber(raw);
  const $ = load(html);
  const chunks: string[] = [];
  $('script').each((_index, script) => {
    const literal = /^\s*self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/.exec($(script).text())?.[1];
    if (!literal) return;
    let value: unknown;
    try { value = JSON.parse(literal); } catch { throw new SchemaError(PROVIDER, 'Instabox returned invalid server data'); }
    if (Array.isArray(value) && value.length === 2 && value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1]);
  });
  const flight = chunks.join('');
  if (flight.length > MAX_BYTES || chunks.length > 100) throw new SchemaError(PROVIDER, 'Instabox returned too much server data');
  const modules = new Map<string, string>();
  const records: unknown[] = [];
  for (const line of flight.split('\n')) {
    const imported = /^([0-9a-f]+):I(\[.*\])$/.exec(line);
    if (imported) {
      let value: unknown;
      try { value = JSON.parse(imported[2]!); } catch { throw new SchemaError(PROVIDER, 'Instabox returned invalid component data'); }
      if (Array.isArray(value) && typeof value.at(-1) === 'string') modules.set(`$L${imported[1]}`, value.at(-1) as string);
      continue;
    }
    const model = /^[0-9a-f]+:([[{].*)$/.exec(line);
    if (model) {
      try { records.push(JSON.parse(model[1]!) as unknown); } catch { throw new SchemaError(PROVIDER, 'Instabox returned invalid parcel data'); }
    }
    if (records.length > 5000) throw new SchemaError(PROVIDER, 'Instabox returned too many server records');
  }
  const journeys: unknown[][] = [];
  const identities = new Set<string>();
  let visited = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++visited > 50000 || depth > 80) throw new SchemaError(PROVIDER, 'Instabox returned excessive nested data');
    if (Array.isArray(node)) {
      if (node[0] === '$' && typeof node[1] === 'string' && isRecord(node[3])) {
        const component = modules.get(node[1]);
        const props = node[3];
        if (component === 'ParcelJourneyItems') {
          if (!Array.isArray(props.items)) throw new SchemaError(PROVIDER, 'Instabox returned invalid journey items');
          journeys.push(props.items);
        }
        if (typeof props.value === 'string' && typeof props.itemName === 'string'
          && /^(?:Paket-ID|Parcel ID|Package ID|Pakket-ID|Pakke-ID|Paketti-ID)$/i.test(props.itemName)) identities.add(props.value);
      }
      for (const value of node) visit(value, depth + 1);
    } else if (isRecord(node)) {
      for (const value of Object.values(node)) visit(value, depth + 1);
    }
  };
  for (const record of records) visit(record, 0);
  if (identities.size !== 1 || !identities.has(number)) throw new IndeterminateError(PROVIDER, 'Instabox did not confirm this parcel for the notification link');
  if (journeys.length !== 1) throw new SchemaError(PROVIDER, 'Instabox returned no unique parcel journey');
  return journeys[0]!;
}

export function parseInstabox(html: string, raw: string): CarrierResult {
  const rows = instaboxJourney(html, raw);
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Instabox returned too many scans');
  const events: CarrierEvent[] = rows.map(row => {
    if (!isRecord(row) || typeof row.description !== 'string' || !row.description.trim() || typeof row.subtitle !== 'string'
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.subtitle) || (row.title != null && typeof row.title !== 'string')) {
      throw new SchemaError(PROVIDER, 'Instabox returned an invalid journey item');
    }
    const time = explicitOffsetTime(row.subtitle)?.iso;
    if (!time) throw new SchemaError(PROVIDER, 'Instabox returned an invalid scan clock');
    const description = clean(row.description, 1000);
    const stage = statusMap.stage(null, description);
    const classified = stage ? null : classifyWording(description);
    return { time, description, ...(row.title ? { location: clean(row.title, 300) } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : classified?.stage ? { stage: classified.stage, stage_source: classified.source } : {}) };
  }).sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', current_stage: stage, current_stage_source: current?.stage_source,
    last_status_text: events[0]!.description, last_update: events[0]!.time, events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}) };
}

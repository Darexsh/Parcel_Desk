import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Every SPS scan carries a numeric status code, and the code alone decides
// the stage. The tracking service words scans in Slovak only and the shared
// wording rules know no Slovak, so the wording is never read. Entries without
// a stage are payment and notice steps: they move nothing.
const CODES = new Map<number, Stage>(statuses.entries.flatMap(entry =>
  entry.stage ? [[Number(entry.code), entry.stage as Stage] as const] : []));

/** The code of the sender's electronic data record, which SPS files at no place the parcel was. */
export const DATA_RECORD_CODE = 8;

/** The stage of one SPS status code, or undefined for a payment or notice step or a code the map does not know. */
export function spsStage(code: number): Stage | undefined {
  return CODES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: code => (code && /^\d{1,4}$/.test(code) ? spsStage(Number(code)) : undefined),
  gaps: statuses.entries.flatMap(entry => (entry.stage ? [] : [{ code: entry.code, note: entry.note }])),
};

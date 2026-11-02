/**
 * Hermes Einrichtungs-Service status classification.
 *
 * The myhes.de order API returns a numeric `sendungsstatusId` per timeline row
 * plus the German wording shown to the customer. The numeric map below is the
 * authority; wording is only consulted for ids the map does not know, so a new
 * id degrades to a sensible stage instead of an invented one.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import type { Stage } from '../../generated/catalog.js';
import statuses from './statuses.json' with { type: 'json' };

/** Observed `sendungsstatusId` values and the status each one means. */
export const HERMES_STATUS = new Map<number, CarrierStatus>([
  [40, 'pending'],
  [100, 'in_transit'],
  [190, 'in_transit'],
  [300, 'in_transit'],
  [307, 'in_transit'],
  [318, 'exception'],
  [319, 'exception'],
  [320, 'exception'],
  [321, 'exception'],
  [314, 'in_transit'],
  [315, 'in_transit'],
  [500, 'in_transit'],
  [701, 'delivered'],
  [702, 'delivered'],
  [700, 'delivered'],
  [720, 'delivered'],
  [721, 'delivered'],
  [722, 'delivered'],
  [728, 'delivered'],
  [731, 'delivered'],
  [740, 'delivered'],
  [742, 'delivered'],
  [430, 'out_for_delivery'],
]);

function normalizedText(raw: unknown): string {
  return (typeof raw === 'string' ? raw : '').toLocaleLowerCase('de-DE').normalize('NFKD').replace(/\p{M}/gu, '');
}

export function hermesStatus(rawStatusId: unknown, rawDescription: unknown = ''): CarrierStatus {
  if (!['string', 'number'].includes(typeof rawStatusId)) return 'pending';
  const statusId = Number(rawStatusId);
  if (!Number.isFinite(statusId)) return 'pending';
  const known = HERMES_STATUS.get(statusId);
  if (known) return known;
  const description = normalizedText(rawDescription);
  if (/(nicht zugestellt|fehlgeschlagen|storniert|retour|zuruck)/.test(description)) {
    return 'exception';
  }
  if (/(erfolgreich zugestellt|ware geliefert|wurde .* zugestellt|delivered)/.test(description)) {
    return 'delivered';
  }
  if (/(befindet sich auf tour|fahrzeugbeladung|ankunft bei kundenadresse|out for delivery)/
    .test(description)) return 'out_for_delivery';
  if (description) return statusId === 40 ? 'pending' : 'in_transit';
  return 'pending';
}

/** The event-level stage that follows from the row's status. */
export function hermesEventStage(rawStatusId: unknown, rawDescription: unknown): Stage {
  const status = hermesStatus(rawStatusId, rawDescription);
  if (status === 'exception') return 'failed_attempt';
  if (status === 'pending') return 'registered';
  return status as Stage;
}

/** The stage of each wording statuses.json records with its id, left out where two ids word it alike with different stages. */
const STAGE_BY_WORDING = new Map<string, Stage | undefined>();
for (const entry of statuses.entries) {
  if (!('code' in entry) || !entry.wording) continue;
  const wording = normalizeStatusWording(entry.wording), stage = hermesEventStage(entry.code, entry.wording);
  STAGE_BY_WORDING.set(wording, STAGE_BY_WORDING.has(wording) && STAGE_BY_WORDING.get(wording) !== stage ? undefined : stage);
}

/**
 * What the map says about one scan. A row's id stages it, and the stored scan keeps only its
 * wording, so the wording stages it through the id statuses.json records it with. Wording not
 * recorded with an id stays open.
 */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => STAGE_BY_WORDING.get(wording), gaps: [] };

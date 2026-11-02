import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const FAILED = ['54', '101', '145', '152', '176', '201', '202', '203', '204', '206', '207', '208', '209', '210', '211',
  '212', '217', 'S20', 'S58', 'S63'];

/**
 * The tracker's status numbers and the stage each gives a consignment. Geis
 * publishes them in its Track & Trace status guide, grouped by phase; the page
 * words them differently from the guide, so the map reads the number. 30, the
 * loading for a linehaul, is missing from the guide but shown by the page.
 * Every reason in the guide's failed-delivery group leads to another attempt.
 * The C codes are full-truckload statuses.
 */
const STAGES = new Map<string, Stage>([
  ['10', 'accepted'],
  ['42', 'accepted'],
  ['20', 'in_transit'],
  ['30', 'in_transit'],
  ['40', 'in_transit'],
  ['51', 'in_transit'],
  ['120', 'in_transit'],
  ['151', 'in_transit'],
  ['156', 'in_transit'],
  ['215', 'in_transit'],
  ['216', 'in_transit'],
  ['50', 'out_for_delivery'],
  ['170', 'out_for_delivery'],
  ['70', 'delivered'],
  ['126', 'delivered'],
  ['127', 'delivered'],
  ...FAILED.map(code => [code, 'failed_attempt'] as const),
  ['69', 'returned'],
  ['116', 'exception'],
  ['200', 'exception'],
  ['205', 'exception'],
  ['C12', 'accepted'],
  ['C13', 'customs'],
  ['C23', 'customs'],
  ['C30', 'in_transit'],
  ['C20', 'out_for_delivery'],
  ['C21', 'out_for_delivery'],
  ['C32', 'exception'],
  ['C70', 'delivered'],
]);

/**
 * Statuses that move nothing: the guide's general notes about a consignment,
 * and a partial delivery, which leaves the rest of the consignment to come.
 * The consignment keeps the stage of the status before them.
 */
const QUIET = new Map<string, string>([
  ['24', 'A fixed delivery time was agreed; it moves nothing.'],
  ['41', 'Personal pick-up, a general note: the guide does not say whether the consignment was collected.'],
  ['71', 'Part of the consignment was delivered; the rest is still to come.'],
  ['76', 'Confirms that cash on delivery was collected; the delivery itself has its own status.'],
  ['77', 'Confirms that the recipient paid the carriage; the delivery itself has its own status.'],
  ['125', 'New delivery instructions; they move nothing.'],
  ['155', 'The recipient is to be advised; it moves nothing.'],
  ['213', 'The recipient asked for another delivery day; it moves nothing.'],
  ['300', "A dispatcher's note."],
  ['K01', 'A warehouse check; it moves nothing.'],
  ['HPH', 'A call to the recipient; it moves nothing.'],
  ['C10', 'A full truck reached the loading point; nothing is loaded yet.'],
  ['C11', 'A full truck started loading; nothing is loaded yet.'],
  ['C31', "A driver's mandatory break."],
]);

/** The stage a status number gives a consignment, if any. */
export function geisStage(code: string): Stage | undefined {
  return STAGES.get(code);
}

/** Whether a status number moves nothing, so the consignment keeps the stage before it. */
export function geisQuiet(code: string): boolean {
  return QUIET.has(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code) : undefined),
  gaps: [...QUIET].map(([code, note]) => ({ code, note })),
};

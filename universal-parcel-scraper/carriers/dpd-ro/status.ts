import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { speedyOperation, speedyPhase, statusMap as speedyStatusMap } from '../speedy/status.js';

/** One DPD Romania operation code or shipment phase: its English wording and stage. */
interface DpdRoStatus {
  readonly wording: string;
  readonly stage?: Stage;
}

// DPD Romania runs the Speedy group's platform. The track-and-trace operation
// codes in its API documentation are Speedy's, with the same meaning, so
// Speedy's map stages them. The documentation words three of them its own way.
const WORDINGS: ReadonlyMap<string, string> = new Map([
  ['134', 'Prepared for Self-collecting Consignee'],
  ['152', 'Routed to another DPD Location'],
  ['1134', 'Notification sent for parcel in office/locker'],
]);

/** A scan's operation code: its documented wording and stage, or the code alone when the map does not know it. */
export function dpdRoOperation(code: string): DpdRoStatus {
  const operation = speedyOperation(code);
  const wording = WORDINGS.get(code);
  return wording ? { ...operation, wording } : operation;
}

/** A shipment phase, or undefined when the map does not know it. */
export const dpdRoPhase: (phase: string) => DpdRoStatus | undefined = speedyPhase;

/** Speedy's map, with its intentional gaps: a deferred delivery, the contents checks and the Predict message. */
export const statusMap: CarrierStatusMap = speedyStatusMap;

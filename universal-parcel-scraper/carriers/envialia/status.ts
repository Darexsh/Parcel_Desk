import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** One Envialia shipment state: a wording known for it and its stage. */
interface EnvialiaStatus {
  readonly wording?: string;
  readonly stage?: Stage;
}

// The service sends a numeric state code with its own Spanish wording. The official app's
// state table names each code; an open-source client of Envialia's business web service
// words the first five, and the old tracking page grouped the rest into its progress steps.
const STATUSES = new Map<string, EnvialiaStatus>([
  ['0', { wording: 'Documentado', stage: 'registered' }],
  ['1', { wording: 'En transito', stage: 'in_transit' }],
  ['2', { wording: 'En reparto', stage: 'out_for_delivery' }],
  ['3', { wording: 'Incidencia', stage: 'exception' }],
  ['4', { wording: 'Entregado', stage: 'delivered' }],
  ['5', { stage: 'returned' }],
  ['8', { stage: 'exception' }],
  ['9', { stage: 'exception' }],
  ['10', { stage: 'failed_attempt' }],
  ['11', { stage: 'in_transit' }],
  ['13', { stage: 'exception' }],
  ['15', { wording: 'En tránsito', stage: 'in_transit' }],
  ['16', { wording: 'Documentado', stage: 'registered' }],
  ['17', { stage: 'exception' }],
  ['18', { stage: 'in_transit' }],
  ['19', { stage: 'ready_for_pickup' }],
  ['21', { stage: 'exception' }],
]);

/** The known wording and stage of a state code; an unknown code has neither. */
export function envialiaStatus(code: string): EnvialiaStatus {
  return STATUSES.get(code) ?? {};
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STATUSES.get(code)?.stage : undefined),
  gaps: [
    {
      code: '6',
      note: 'Rerouted (the app names it EstRecanalizado). The old tracking page ended the shipment there; no reply showed whether the parcel went on under another number or back to the sender.',
    },
    {
      code: '12',
      note: 'To be collected at the agency (EstRecDel, the app\'s "Recoger en delegación"). The old tracking page grouped it with incidents; no reply showed whether the parcel already waits there.',
    },
    {
      code: '14',
      note: 'Part of the shipment delivered (EstEntrRepPar). The old tracking page showed it as delivered, while the app keeps it open.',
    },
  ],
};

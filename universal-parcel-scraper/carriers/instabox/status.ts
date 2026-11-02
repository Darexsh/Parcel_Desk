import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: Readonly<Record<string, Stage>> = {
  'ditt paket har hämtats upp': 'delivered',
  'ditt paket är framme i skåpet': 'ready_for_pickup',
  'ditt paket är nu på väg till skåpet': 'out_for_delivery',
  'vi har tagit emot ditt paket': 'in_transit',
  'ditt paket är på väg till vår terminal': 'in_transit',
  'ditt paket har lämnats in av säljaren': 'accepted',
  'vi har fått information om en kommande leverans': 'registered',
};
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => {
  const normalized = normalizeStatusWording(wording);
  return Object.hasOwn(WORDINGS, normalized) ? WORDINGS[normalized] : undefined;
}, gaps: [] };

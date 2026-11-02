import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan codes. Each comes with a short category (`labelShort`)
 * and a sentence that can name the sorting centre; parcels of some services
 * carry an older sentence for the same code.
 */
const CODES: Readonly<Record<string, Stage>> = {
  // Paczka w trakcie przygotowania: the sender has created the parcel.
  200: 'registered',
  // Paczka nadana: dropped off at a point.
  210: 'accepted',
  // Paczka odebrana przez kuriera: a courier collected it from the sender.
  240: 'accepted',
  // Paczka w sortowni regionalnej, at the first sorting centre and at the
  // destination's (653); Paczka w sortowni centralnej (300).
  100: 'in_transit',
  300: 'in_transit',
  653: 'in_transit',
  // Paczka w drodze do punktu odbioru: on its way to the pickup point.
  680: 'in_transit',
  // Paczka do odbioru: waiting at the pickup point.
  690: 'ready_for_pickup',
  // Paczka odebrana: the recipient collected it.
  1000: 'delivered',
};

/**
 * A parcel ORLEN hands to another country's carrier gets code 690 and its
 * "ready for pickup" category, but its sentence says the parcel left with the
 * other carrier, or only that it is in another country ("Paczka w innym
 * kraju"): it is in transit, not waiting at a point.
 */
const HANDOFF = /^paczka (?:przekazana do przewoźnika )?w innym kraju\b/;

/** The stage of one scan from its code, or from its wording where the code's category does not fit it. */
export function orlenPaczkaStage(code: string, wording: string): Stage | undefined {
  if (HANDOFF.test(normalizeStatusWording(wording))) return 'in_transit';
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

/** Every scan carries a code; wording alone gets nothing. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code === null ? undefined : orlenPaczkaStage(code, wording),
  gaps: [],
};

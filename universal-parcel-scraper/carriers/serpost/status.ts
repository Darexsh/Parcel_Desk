import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Serpost's scan wordings, in Spanish. The tracker writes the office into
 * some ("ENVÍO ADMITIDO EN ADMINISTRACION POSTAL CUSCO"), so the map reads the
 * start of the wording, without accents. Its two systems number their events
 * apart, and the page itself sorts several codes under one icon, so the
 * wording sets the stage.
 */
const SERPOST_RULES: readonly (readonly [RegExp, Stage])[] = [
  [/^envio admitido\b/, 'accepted'],
  // An item from abroad handed to Serpost in Peru.
  [/^envio llego a serpost\b/, 'in_transit'],
  // Peruvian customs let the item through.
  [/^envio sin observacion por la aduana\b/, 'in_transit'],
  [/^envio sujeto a tramite ante aduana\b/, 'customs'],
  [/^envio salio de peru\b/, 'in_transit'],
  [/^envio en transito\b/, 'in_transit'],
  // Sorting at the head office, and preparing the round to the addressee's home.
  [/^envio en procesamiento\b/, 'in_transit'],
  // The office that delivers it received the item; its addressee may ask to collect it there instead.
  [/^envio llego a (?:la|el)\b/, 'in_transit'],
  [/^envio en proceso de distribucion\.?$|^salio a distribucion$/, 'out_for_delivery'],
  [/^envio disponible para entrega o recojo\b/, 'ready_for_pickup'],
  [/^intento fallido de entrega\b|^se intento entregar pero fue imposible$/, 'failed_attempt'],
  [/^(?:envio )?entregado\.?$|^fue entregado$/, 'delivered'],
];

// The codes the page itself marks delivered or not delivered, in either system, for a wording the map does not know.
const SERPOST_CODES: Readonly<Record<string, Stage>> = { '5': 'delivered', '020': 'delivered', '4': 'failed_attempt', '019': 'failed_attempt' };

/** Lower case, single spaces, no accents. */
function plain(wording: string): string {
  return wording.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es').trim().split(/\s+/).join(' ');
}

/** The stage the map gives a scan's wording, else its code, if it knows either. */
export function serpostEventStage(wording: string, code?: string | null): Stage | undefined {
  const text = plain(wording);
  return SERPOST_RULES.find(([rule]) => rule.test(text))?.[1]
    ?? (code && Object.hasOwn(SERPOST_CODES, code) ? SERPOST_CODES[code] : undefined);
}

/** A scan's stage from its wording or code, else the shared wording rules, else nothing, which keeps it visible for review. */
export function serpostStage(wording: string, code?: string | null): ClassifiedWording | null {
  const mapped = serpostEventStage(wording, code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The wording sets the stage, and the code only when the wording is unknown; Serpost's map leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => serpostEventStage(wording, code),
  gaps: [],
};

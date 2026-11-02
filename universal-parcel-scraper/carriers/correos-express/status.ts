import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** The languages the tracking form words its scans in. */
export type CorreosExpressLanguage = 'es' | 'pt';

/** The fixed opening of a failed round's note, which the form shows without a label. */
export const FAILED_ROUND = 'Su envío no ha podido ser entregado';
/** The same opening on the Portuguese form. */
export const FAILED_ROUND_PT = 'Não foi possivel entregar o seu envio';

const labels: Record<string, ClassifiedStatus> = {
  INFORMADO: { status: 'pending', stage: 'registered' },
  ADMITIDO: { status: 'in_transit', stage: 'accepted' },
  'ADMITIDO EN OFICINA DE CORREOS': { status: 'in_transit', stage: 'accepted' },
  'EN RUTA A LOCALIDAD DE DESTINO': { status: 'in_transit', stage: 'in_transit' },
  'EN DESTINO': { status: 'in_transit', stage: 'in_transit' },
  'EN REPARTO': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  // The fixed opening the parser keeps from an unlabelled failed round.
  'SU ENVIO NO HA PODIDO SER ENTREGADO': { status: 'exception', stage: 'failed_attempt' },
  // At the chosen pickup point, but the carrier says the collection
  // instructions are still to come; the next scan makes it available.
  'ENTREGADO EN PUNTO DE CONVENIENCIA': { status: 'in_transit', stage: 'in_transit' },
  'DISPONIBLE EN PUNTO DE CONVENIENCIA': { status: 'in_transit', stage: 'ready_for_pickup' },
  ENTREGADO: { status: 'delivered', stage: 'delivered' },
  DEVUELTO: { status: 'exception', stage: 'returned' },
  'EN ALMACEN': { status: 'exception', stage: 'exception' },
  // Customer service is handling an incident on the shipment.
  'EN GESTION': { status: 'exception', stage: 'exception' },
  // The pickup point's holding period ended and the parcel goes back.
  'EL PERIODO DE RECOGIDA DEL ENVIO EN EL PUNTO DE CONVENIENCIA SELECCIONADO HA FINALIZADO Y SE PROCEDERA A SU DEVOLUCION A ORIGEN':
    { status: 'exception', stage: 'returned' },
  ESTACIONADO: { status: 'exception', stage: 'exception' },
  // The accompanying carrier wording describes a rescheduled delivery after
  // an unsuccessful attempt, with the new delivery still in the future.
  'NUEVO REPARTO': { status: 'in_transit', stage: 'in_transit' },
  // The sender asked for delivery to another address; the parcel moves on.
  'CAMBIO DE DESTINO': { status: 'in_transit', stage: 'in_transit' },
};

/**
 * The situations of a Correos Express scan in the Correos group's localizador,
 * by the first three characters of its code, and the label the tracking form
 * shows for the same scan. The rest of the code names the reason.
 */
const SITUATIONS: Record<string, string> = {
  X01: 'INFORMADO',
  X02: 'EN RUTA A LOCALIDAD DE DESTINO',
  X04: 'EN RUTA A LOCALIDAD DE DESTINO',
  X06: 'EN DESTINO',
  X08: 'EN REPARTO',
  // Estacionado in the localizador; the form shows only the failed round's note.
  X09: FAILED_ROUND,
  X10: 'EN ALMACÉN',
  X11: 'NUEVO REPARTO',
  X12: 'ENTREGADO',
  X13: 'EN GESTIÓN',
  X14: 'CAMBIO DE DESTINO',
  X17: 'DEVUELTO',
  X38: 'ENTREGADO EN PUNTO DE CONVENIENCIA',
  X39: 'DISPONIBLE EN PUNTO DE CONVENIENCIA',
};

const key = (label: string) => label.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * The Portuguese form's label for each Spanish label, by the Spanish one: the
 * same scans with the same clocks and places. INFORMADO and ADMITIDO read the
 * same in both.
 */
const PORTUGUESE: Record<string, string> = {
  INFORMADO: 'INFORMADO',
  ADMITIDO: 'ADMITIDO',
  'EN RUTA A LOCALIDAD DE DESTINO': 'EM TRANSITO PARA A LOCALIDADE DE DESTINO',
  'EN DESTINO': 'NO DESTINO',
  'EN REPARTO': 'EM DISTRIBUIÇÃO',
  [key(FAILED_ROUND)]: FAILED_ROUND_PT,
  'ENTREGADO EN PUNTO DE CONVENIENCIA': 'ENTREGUE EM PONTO DE CONVENIÊNCIA',
  'DISPONIBLE EN PUNTO DE CONVENIENCIA': 'DISPONÍVEL EM PONTO DE CONVENIÊNCIA',
  ENTREGADO: 'ENTREGUE',
  DEVUELTO: 'DEVOLVIDO',
  'EN ALMACEN': 'EM ARMAZÉM',
  'EN GESTION': 'A SER GERENCIADO',
  'EL PERIODO DE RECOGIDA DEL ENVIO EN EL PUNTO DE CONVENIENCIA SELECCIONADO HA FINALIZADO Y SE PROCEDERA A SU DEVOLUCION A ORIGEN':
    'O PRAZO PARA RETIRADA DA REMESSA NO PONTO DE CONVENIÊNCIA SELECIONADO TERMINOU E ELA SERÁ DEVOLVIDA À SUA ORIGEM',
  'NUEVO REPARTO': 'EM REDISTRIBUIÇÃO',
};
const SPANISH: ReadonlyMap<string, string> = new Map(Object.entries(PORTUGUESE).map(([spanish, portuguese]) => [key(portuguese), spanish]));

/** A label in the form comparable across languages: the Spanish label's, for a Portuguese one. */
const spanishKey = (label: string) => {
  const name = key(label);
  return SPANISH.get(name) ?? name;
};

/** The stage of a form label, Spanish or Portuguese. */
export function classifyCorreosExpressStatus(label: string): ClassifiedStatus | undefined {
  const name = spanishKey(label);
  return Object.hasOwn(labels, name) ? labels[name] : undefined;
}

/** A Correos Express situation code: X, two digits for the situation, four for the reason, then V or R. */
export function isCorreosExpressCode(code: string): boolean {
  return /^X\d{6}[VR]$/.test(code);
}

/**
 * The label the form shows in `language` for a localizador code's situation,
 * when the situation is known. A situation no Portuguese page has shown keeps
 * its Spanish label.
 */
export function correosExpressCodeLabel(code: string, language: CorreosExpressLanguage = 'es'): string | undefined {
  const situation = code.slice(0, 3);
  if (!isCorreosExpressCode(code) || !Object.hasOwn(SITUATIONS, situation)) return undefined;
  const spanish = SITUATIONS[situation]!;
  return language === 'pt' ? PORTUGUESE[key(spanish)] ?? spanish : spanish;
}

/**
 * The situation a form label stands for, in a form comparable across labels and
 * languages; ESTACIONADO is the failed round's.
 */
export function correosExpressSituationKey(label: string): string {
  const name = spanishKey(label);
  return name === 'ESTACIONADO' ? key(FAILED_ROUND) : name;
}

/** Whether a label is a failed round's fixed opening, in either language. */
export function isCorreosExpressFailedRound(label: string): boolean {
  return label === FAILED_ROUND || label === FAILED_ROUND_PT;
}

/**
 * The label a scan's description opens with: the description is the label,
 * then any fixed explanation. A failed round's note opens with its fixed
 * opening, which the Portuguese localizador words its own way.
 */
export function correosExpressDescriptionLabel(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  if (/^su env[ií]o no ha podido ser entregado\b/iu.test(text)) return FAILED_ROUND;
  if (/^(?:não foi poss[ií]vel entregar o seu envio|o seu envio não pôde ser entregue)\b/iu.test(text)) return FAILED_ROUND_PT;
  return text.split('.')[0]!.trim();
}

export function classifyCorreosExpressDescription(description: string): ClassifiedStatus | undefined {
  if (description.trim().toLowerCase() === 'delivered') return labels.ENTREGADO;
  return classifyCorreosExpressStatus(correosExpressDescriptionLabel(description));
}

export const statusMap: CarrierStatusMap = {
  codeKey: (code) => (isCorreosExpressCode(code) ? code.slice(0, 3) : code),
  stage: (code, wording) => {
    const label = code ? correosExpressCodeLabel(code) : undefined;
    return (label ? classifyCorreosExpressStatus(label) : classifyCorreosExpressDescription(wording))?.stage;
  },
  gaps: [
    { wording: 'tracking update', note: 'A form scan whose label the map does not know, shown under a neutral wording so its note cannot carry personal details.' },
  ],
};

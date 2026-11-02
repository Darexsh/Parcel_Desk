import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scans of Delnext's Portuguese tracker. Scans carry no code; each says
 * what happened in a sentence or two, and many ask the recipient to act. The
 * shared rules misread several: a dispatch as a delivery round, a request to
 * pick a new day as a problem.
 */
const SCANS: Readonly<Record<string, Stage>> = {
  'Envio registado no sistema Delnext': 'registered',
  'Parcela registada no sistema Delnext': 'registered',
  // Delnext has the parcel and has sent it on; the estimate is shown above the history.
  'Encomenda enviada: verifique a estimativa de entrega acima. Será notificado quando a encomenda entrar em distribuição': 'in_transit',
  'Pedido enviado: por favor, consulte a estimativa de entrega acima. Será notificado no dia da entrega.': 'in_transit',
  'Encomenda lida em armazém': 'in_transit',
  // After a failed attempt, a new delivery booked or the address confirmed: the parcel goes out again.
  'Entrega reagendada. Tentaremos entregar a encomenda logo que possível': 'in_transit',
  'Endereço confirmado': 'in_transit',
  'Address updated by consignee': 'in_transit',
  // The system's notes under a failed attempt and after a new day, which the
  // adapter drops from the scan's line; they say the same.
  'Incidência resolvida pelo cliente. Foi agendada uma nova entrega para a data selecionada': 'in_transit',
  'Incidência resolvida pelo sistema automaticamente. Foi agendada uma nova entrega': 'in_transit',
  'A data de entrega foi atualizada. Vamos tentar entregar a encomenda na data selecionada': 'in_transit',
  'Encomenda em distribuição. Esperamos fazer a entrega durante o dia de hoje': 'out_for_delivery',
  "Destinatário ausente. Por favor ajude-nos a proceder à entrega clicando no botão 'Resolver'": 'failed_attempt',
  "Não foi possível entregar a sua encomenda hoje, ao contrário do previsto. Por favor ajude-nos a proceder à entrega clicando no botão 'Resolver'": 'failed_attempt',
  'Não foi possível proceder à entrega durante o dia de hoje': 'failed_attempt',
  'Incidência comunicada ao destinatário. Por favor clique em «Resolver problema» em cima para ajudar-nos a proceder à entrega ou contacte info@delnext.com': 'failed_attempt',
  "Morada não localizada ou incorreta. Por favor ajude-nos a proceder à entrega, corrigindo a morada, no botão 'Resolver'": 'failed_attempt',
  // The heading of the address-correction screen, in Portuguese and German.
  'O volume não foi entregue devido a morada incompleta/incorreta': 'failed_attempt',
  'Ihr Paket wurde wegen unvollständiger / falscher Adresse nicht zugestellt': 'failed_attempt',
  // A return under way; the parcel can still go out again before it reaches the sender.
  'Encomenda entrou em processo de Devolução': 'exception',
  'A Delnext recebeu corretamente os dados da sua encomenda mas o remetente cancelou o envio': 'exception',
  'Entregue': 'delivered',
  'Encomenda devolvida ao remetente': 'returned',
};

/**
 * Wording followed by a date or a reason: a new delivery day after a failed
 * attempt ("Nova data de entrega: 2026-01-02"), and a return announced with
 * the reason in brackets, as in "(Absent)". The return stops delivery, though
 * the recipient can still ask for the parcel.
 */
const PREFIXES: Readonly<Record<string, Stage>> = {
  'Nova data de entrega:': 'in_transit',
  'Encomenda não pôde ser entregue e será devolvida em breve. Se ainda a quiser receber entre em contacto com o nosso Apoio ao Cliente: info@delnext.com': 'exception',
};

/** The wording as the app keys it, without a closing full stop the page adds to some scans and not others. */
const keyOf = (wording: string) => normalizeStatusWording(wording).replace(/\.$/, '');
const SCAN_KEYS = new Map(Object.entries(SCANS).map(([wording, stage]) => [keyOf(wording), stage]));
const PREFIX_KEYS = Object.entries(PREFIXES).map(([prefix, stage]) => [keyOf(prefix), stage] as const);

/** The stage Delnext's wording gives a scan, if any. */
export function delnextScanStage(wording: string): Stage | undefined {
  const key = keyOf(wording);
  return SCAN_KEYS.get(key) ?? PREFIX_KEYS.find(([prefix]) => key === prefix || key.startsWith(`${prefix} `))?.[1];
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function delnextStage(wording: string): ClassifiedWording | null {
  const mapped = delnextScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : delnextScanStage(wording)),
  gaps: [],
};

import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Total Express's status ids (`statid`), which its tracking page labels from
 * the list it bundles. The codes seen in replies are mapped, and from that
 * list the failed deliveries, pickups, returns, holds and losses; another code
 * falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['100', 'registered'], // ARQUIVO APROVADO: the merchant's order file was accepted.
  ['99', 'registered'], // INÍCIO DE COLETA: a driver is on the way to the merchant.
  ['97', 'registered'], // INÍCIO DE COLETA C/ EDI
  ['82', 'registered'], // INÍCIO DE COLETA C/ NÃO CONFORMIDADE
  ['83', 'accepted'], // COLETA REALIZADA: collected from the merchant.
  ['84', 'accepted'], // COLETA REALIZADA C/ NÃO CONFORMIDADE: collected, with a discrepancy in the merchant's data.
  ['85', 'accepted'], // Handed in at a Total Express base.
  ['87', 'accepted'],
  ['68', 'in_transit'], // COLETA RECEBIDA NO CD: the collection reached the distribution centre.
  ['69', 'in_transit'],
  ['101', 'in_transit'], // RECEBIDA E PROCESSADA NO CD
  ['78', 'in_transit'], // EMBARCADO PARA: loaded for another base.
  ['79', 'in_transit'], // EMBARQUE RECEBIDO NO CD
  ['102', 'in_transit'], // TRANSFERENCIA PARA
  ['103', 'in_transit'], // RECEBIDO CD DE
  ['108', 'in_transit'], // DESCARREGADO: unloaded at a base.
  ['129', 'in_transit'], // Transshipments and crossing points on the way.
  ['130', 'in_transit'],
  ['131', 'in_transit'],
  ['132', 'in_transit'],
  ['159', 'in_transit'],
  ['160', 'in_transit'],
  ['74', 'in_transit'], // Missed its departure's cut-off; it leaves on the next.
  ['133', 'in_transit'], // LIBERADO DO POSTO FISCAL: released by a state tax checkpoint.
  ['38', 'in_transit'], // REDESPACHADO CORREIO: handed to Correios, whose number the reply gives.
  ['127', 'in_transit'], // Transferência para ECT: on its way to Correios.
  ['106', 'in_transit'], // Handed to another carrier or a local partner for the delivery.
  ['107', 'in_transit'],
  ['109', 'in_transit'],
  ['80', 'in_transit'], // EM AGENDAMENTO: a delivery being arranged.
  ['91', 'in_transit'], // ENTREGA PROGRAMADA: the recipient was contacted to arrange the delivery.
  // EM ROTA: put on a delivery round at the delivery base, which the page words
  // as the parcel reaching it. PROCESSO DE ENTREGA follows, up to a day later,
  // when the driver takes it.
  ['105', 'in_transit'],
  ['104', 'out_for_delivery'], // PROCESSO DE ENTREGA: with the driver.
  ['1', 'delivered'],
  // Deliveries that did not happen: the recipient was out, unknown or moved,
  // the address was incomplete or unreachable, or the parcel was refused.
  ['6', 'failed_attempt'],
  ['8', 'failed_attempt'],
  ['9', 'failed_attempt'],
  ['11', 'failed_attempt'],
  ['20', 'failed_attempt'],
  ['21', 'failed_attempt'],
  ['39', 'failed_attempt'],
  ['41', 'failed_attempt'],
  ['44', 'failed_attempt'],
  ['45', 'failed_attempt'],
  ['46', 'failed_attempt'],
  ['47', 'failed_attempt'],
  ['49', 'failed_attempt'],
  ['51', 'failed_attempt'],
  ['52', 'failed_attempt'],
  ['53', 'failed_attempt'],
  ['55', 'failed_attempt'],
  ['95', 'failed_attempt'],
  ['29', 'ready_for_pickup'], // To collect at a Total Express base.
  ['128', 'ready_for_pickup'],
  ['144', 'ready_for_pickup'], // At a pickup point, which the reply names.
  ['71', 'returned'], // On its way back to the merchant.
  ['61', 'returned'],
  ['146', 'returned'], // Sent back from a pickup point.
  ['147', 'returned'],
  // Held at a distribution centre after failed deliveries, or given back by Correios.
  ['25', 'exception'],
  ['26', 'exception'],
  ['34', 'exception'],
  ['145', 'exception'], // Not collected from the pickup point in time.
  ['40', 'exception'], // Cancelled by the recipient or the merchant.
  ['56', 'exception'],
  ['63', 'exception'],
  ['12', 'exception'], // A service Total Express does not provide.
  ['28', 'exception'], // Held for an investigation.
  ['110', 'exception'], // Held at a state tax checkpoint.
  ['112', 'exception'],
  // Lost, stolen, damaged, confiscated or destroyed.
  ['10', 'exception'],
  ['14', 'exception'],
  ['18', 'exception'],
  ['19', 'exception'],
  ['22', 'exception'],
  ['23', 'exception'],
  ['24', 'exception'],
  ['27', 'exception'],
  ['30', 'exception'],
  ['31', 'exception'],
  ['32', 'exception'],
  ['33', 'exception'],
  ['35', 'exception'],
  ['36', 'exception'],
  ['90', 'exception'],
  ['94', 'exception'],
  ['96', 'exception'],
  ['141', 'exception'],
  ['142', 'exception'],
  ['143', 'exception'],
  ['148', 'exception'],
]);

/** Bookkeeping the history records beside the scans; it moves nothing. */
const GAPS: ReadonlyMap<string, string> = new Map([
  ['98', 'Waiting to be measured, logged with the arrival at the distribution centre; the parcel moves on whatever it says.'],
  ['70', 'A delivery notice; it moves nothing.'],
  ['75', 'Taken off an earlier departure, then logged with the next one; it moves nothing.'],
  ['76', 'Taken off an earlier departure, then logged with the next one; it moves nothing.'],
  ['77', 'Taken off an earlier manifest, then logged with the next one; it moves nothing.'],
  ['111', 'Taken off an earlier master air waybill, then logged with the next one; it moves nothing.'],
  ['157', 'Stored at a shelf address in a warehouse; it moves nothing.'],
  ['158', 'Taken from a shelf address in a warehouse; it moves nothing.'],
  ['154', 'The record closed, after a delivery, a return or a loss the history already shows.'],
  ['155', 'The record closed, after a delivery, a return or a loss the history already shows.'],
]);

/** The stage Total Express's status ids give a scan. */
export function totalExpressMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its status id, else the shared wording rules, else nothing. */
export function totalExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = totalExpressMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAPS.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? totalExpressMappedStage(code) : undefined),
  gaps: [...GAPS].map(([code, note]) => ({ code, note })),
};

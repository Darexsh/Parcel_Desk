import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Liccardi's event codes (`codEsito`), as its tracker's `/codiciEsiti` list
 * names them. The page's script files most of them under its five progress
 * steps; the map follows it, apart from the steps that hide a pickup point, a
 * return or a failed delivery.
 */
const CODES: ReadonlyMap<number, Stage> = new Map([
  [50, 'registered'], // DATI SPEDIZIONE TRASMESSI A LICCARDI: the sender's data, before the parcel.
  [58, 'registered'], // SERVIZIO PROGRAMMATO
  [36, 'registered'], // RITIRO ASSEGNATO AD AUTISTA: a pickup given to a driver.
  [92, 'registered'], // IN RITIRO: the pickup is under way.
  [37, 'accepted'], // SPEDIZIONE RITIRATA
  [3, 'accepted'], // COLLO PRESO IN CARICO
  [4, 'accepted'], // SPEDIZIONE PRESA IN CARICO
  [23, 'in_transit'], // PESATO
  [47, 'in_transit'], // ARRIVATO IN FILIALE
  [48, 'in_transit'], // IN TRANSITO
  [91, 'in_transit'], // SPEDIZIONE PARTITA
  [64, 'in_transit'], // COLLO IN PARTENZA
  [73, 'in_transit'], // PALLET IN ARRIVO
  [74, 'in_transit'], // PALLET IN PARTENZA
  [104, 'in_transit'], // ARRIVO LINEA
  [14, 'in_transit'], // IN TRANSITO PARZIALE
  [15, 'in_transit'], // IN ARRIVO PARZIALE
  [17, 'in_transit'], // ARRIVO PARZIALE SU FILIALE DI DESTINO
  [72, 'in_transit'], // ARRIVO SU FILIALE DI DESTINO
  [78, 'in_transit'], // SPEDIZIONE CONSEGNATA ALLA FILIALE: handed to the branch, not to the recipient.
  [18, 'in_transit'], // RITARDO TRAZIONE: the line haul is late.
  [89, 'in_transit'], // SATURAZIONE LINEA: the line is full.
  [49, 'in_transit'], // IN GESTIONE: at the branch, as before each new delivery round.
  [69, 'in_transit'], // COLLO RIENTRATO IN FILIALE
  [70, 'in_transit'], // GIACENZA SVINCOLATA: a hold released on the sender's instructions.
  [79, 'in_transit'], // ORDINE RIPRISTINATO: ISTRUZIONI RICEVUTE
  [33, 'in_transit'], // IN PRENOTAZIONE: a delivery appointment being booked.
  [51, 'out_for_delivery'], // CARICO VETTURA: loaded on the delivery van.
  [95, 'out_for_delivery'], // CARICO VETTURA CONFERMATO
  [52, 'out_for_delivery'], // IN CONSEGNA
  // A delivery that did not happen that day, with the driver's reason.
  [28, 'failed_attempt'], // ASSENTE
  [40, 'failed_attempt'], // INDIRIZZO ERRATO
  [41, 'failed_attempt'], // CHIUSO PER FERIE
  [43, 'failed_attempt'], // CONSEGNA NON ESEGUITA
  [44, 'failed_attempt'], // MANCA CONTRASSEGNO: the cash on delivery was not ready.
  [45, 'failed_attempt'], // INDIRIZZO NON TROVATO
  [46, 'failed_attempt'], // CHIUSO
  [66, 'failed_attempt'], // DESTINATARIO SCONOSCIUTO AL CIVICO
  [67, 'failed_attempt'], // GIRO DI CONSEGNA NON ULTIMATO
  [75, 'failed_attempt'], // AVVERSE CONDIZIONI ATMOSFERICHE
  [94, 'failed_attempt'], // AUTENTICAZIONE FALLITA
  [96, 'failed_attempt'], // GIORNATA FESTIVA
  [97, 'failed_attempt'], // RITARDO PER CAUSA DI FORZA MAGGIORE
  [99, 'failed_attempt'], // STRADA CHIUSA
  [100, 'failed_attempt'], // FESTA PATRONALE
  [101, 'failed_attempt'], // GUASTO AUTOMEZZO: the van broke down on the round.
  [102, 'failed_attempt'], // ASSEGNAZIONE GIRO ERRATA
  // Waiting for the recipient to collect it: the page counts a locker as delivered.
  [6, 'ready_for_pickup'], // CONSEGNATA AL PUDO
  [80, 'ready_for_pickup'], // CHECK-IN AL PUDO
  [11, 'ready_for_pickup'], // SPEDIZIONE DEPOSITATA NEL LOCKER
  [32, 'ready_for_pickup'], // FERMO DEPOSITO: held at the branch for collection.
  [1, 'delivered'], // SPEDIZIONE CONSEGNATA
  [5, 'delivered'], // SPEDIZIONE CONSEGNATA A COMMITTENTE: the page counts it as a delivery.
  [12, 'delivered'], // SPEDIZIONE RITIRATA DA LOCKER DAL DESTINATARIO
  [31, 'returned'], // RIENTRO AL MITTENTE
  [53, 'returned'], // IN CONSEGNA AL MITTENTE
  [8, 'returned'], // RESO A MITTENTE
  [26, 'exception'], // PRENOTAZIONE FALLITA: DESTINATARIO NON CONTATTABILE
  [29, 'exception'], // OVERSIZE
  [30, 'exception'], // COLLO DANNEGGIATO
  [34, 'exception'], // VERBALE IN ATTESA DI DEFINIZIONE: a damage or shortage report.
  [35, 'exception'], // IN GIACENZA: held after a failed delivery, waiting for the sender.
  [39, 'exception'], // EXPIRED
  [42, 'exception'], // MERCE RESPINTA: refused.
  [54, 'exception'], // SPEDIZIONE SMARRITA: lost.
  [55, 'exception'], // Damaged
  [56, 'exception'], // SPEDIZIONE NON REGISTRATA AL LOCKER
  [57, 'exception'], // LOCKER GUASTO
  [60, 'exception'], // RITIRO ANNULLATO
  [61, 'exception'], // IMBALLAGGIO NON IDONEO
  [62, 'exception'], // CLAIMED
  [68, 'exception'], // COLLO DISGUIDATO: misrouted.
  [76, 'exception'], // ORDINE SOSPESO: IN ATTESA DI ISTRUZIONI MITTENTE
  [90, 'exception'], // SPEDIZIONE ANNULLATA
  [98, 'exception'], // FURTO
  [103, 'exception'], // DISCONOSCIMENTO FIRMA: the recipient disowns the signature.
  [105, 'exception'], // SPEDIZIONE INCOMPLETA
  [107, 'exception'], // CONTATTARE ASSISTENZA
]);

/** The codes left without a stage on purpose, and why. */
const GAPS: ReadonlyMap<number, string> = new Map([
  [13, 'The courier took the parcel out of a locker, which is a sender\'s drop-off being collected or an uncollected parcel being taken back.'],
  [38, 'A reminder that the parcel still waits in its locker; it moves nothing.'],
  [59, 'The sender\'s goods were not ready at pickup; the parcel has not moved.'],
  [63, 'A shortage noted on arrival at a branch, which the page shows without a warning.'],
  [71, 'A delivery planned for the next day, which is no scan.'],
  [77, 'A request to suspend the shipment was turned down; nothing moved.'],
  [81, 'The parcel left the pickup point, collected by the recipient or taken back by the courier.'],
  [82, 'A delivery appointment cancelled; the parcel stays where it was.'],
  [83, 'A return by a partner carrier, which does not say where the parcel goes.'],
  [93, 'A request to deliver to another address; the parcel has not moved.'],
  [106, 'The parcel was taken out, by a courier or the recipient, without saying which.'],
]);

/** A code as the reply gives it, a whole number, or null. */
function codeNumber(code: string | null): number | null {
  return code !== null && /^\d{1,4}$/.test(code.trim()) ? Number(code.trim()) : null;
}

/** The stage Liccardi's code gives a scan code. */
export function liccardiMappedStage(code: string | null): Stage | undefined {
  const value = codeNumber(code);
  return value === null ? undefined : CODES.get(value);
}

/** A scan's stage: its code, else the shared wording rules for a code the list does not hold, else nothing. */
export function liccardiStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = liccardiMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const value = codeNumber(code);
  if (value !== null && GAPS.has(value)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => liccardiMappedStage(code),
  gaps: [...GAPS].map(([code, note]) => ({ code: String(code), note })),
};

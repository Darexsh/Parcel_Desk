import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

type Entry = readonly [wording: string, stage?: Stage];

/**
 * The scan codes Kazpost's tracking page shows, with the Russian wording it
 * shows them under. The page reads them from its dictionary at
 * post.kz/static/new_mappings.json. `_I` and `_O` mark an inbound and an
 * outbound international leg; the E codes are the UPU's.
 */
export const KAZPOST_CODES: Readonly<Record<string, Entry>> = {
  Registered: ['Принято почтовое отправление', 'accepted'],
  BAT: ['Принято почтовое отправление', 'accepted'],
  RCPOPS: ['Принято почтовое отправление для отправки', 'accepted'],
  RCP_I: ['Принято почтовое отправление для отправки', 'accepted'],
  RCP_O: ['Принято почтовое отправление для отправки', 'accepted'],
  RCPOPS_I: ['Принято почтовое отправление для отправки', 'accepted'],
  RCPOPS_O: ['Принято почтовое отправление для отправки', 'accepted'],
  // The summary's code for an item registered with no scan since.
  RCP: ['Зарегистрирован', 'accepted'],
  EMA: ['Почтовое отправление принято в стране отправления', 'accepted'],

  Departed: ['Отправлено из центра сортировки', 'in_transit'],
  Transit: ['Прибытие в центр сортировки', 'in_transit'],
  Arrived: ['Прибытие в центр сортировки', 'in_transit'],
  Postcripted: ['Прибытие в центр сортировки', 'in_transit'],
  PRC: ['Прибыло в центр сортировки', 'in_transit'],
  TRANSITRCV: ['Прибыло в центр сортировки', 'in_transit'],
  SND: ['Отправлено из центра сортировки', 'in_transit'],
  // Arrived at the office that delivers the item, before it waits there or goes out.
  STR_EMS: ['Прибыло в пункт доставки', 'in_transit'],
  FromCustom: ['Выпущен с таможни', 'in_transit'],
  SNDZONE_T: ['Прошло таможенное оформление', 'in_transit'],
  SNDDELAY: ['Выпущен с таможни (был под наблюдением таможни)', 'in_transit'],
  CUSTOM_RET: ['Возвращено с таможни', 'in_transit'],
  Redirected: ['Перенаправлено', 'in_transit'],
  Forwarded: ['Перенаправлено', 'in_transit'],
  RDR: ['Перенаправлено', 'in_transit'],
  RDRSTR: ['Перенаправлено', 'in_transit'],
  RDRSC: ['Перенаправлено', 'in_transit'],
  RDRSCSTR: ['Перенаправлено', 'in_transit'],
  RDR_I: ['Перенаправлено', 'in_transit'],
  RDR_O: ['Перенаправлено', 'in_transit'],
  RDRSTR_I: ['Перенаправлено', 'in_transit'],
  RDRSTR_O: ['Перенаправлено', 'in_transit'],
  RDRSC_I: ['Перенаправлено', 'in_transit'],
  RDRSC_O: ['Перенаправлено', 'in_transit'],
  EMB: ['Прибыло в исходящее учреждение обмена в стране отправления', 'in_transit'],
  EMC: ['Отправлено в страну назначения', 'in_transit'],
  EMD: ['Прибыло в учреждение обмена страны назначения', 'in_transit'],
  EMF: ['Отправлено из входящего учреждения обмена в сортировочный центр страны назначения', 'in_transit'],
  EMG: ['Прибыло в отделение доставки страны назначения', 'in_transit'],
  EMJ: ['Прибыло в учреждение обмена транзитной страны', 'in_transit'],
  EMK: ['Отправлено из учреждения обмена транзитной страны', 'in_transit'],
  EXC: ['Выпущено с экспортной таможни/безопасности в стране отправления', 'in_transit'],
  // The dictionary also lists EXC spelt with a Cyrillic С.
  'EX\u0421': ['Выпущено с экспортной таможни/безопасности в стране отправления', 'in_transit'],
  EXD: ['Задержано в исходящем учреждении обмена страны отправления', 'in_transit'],
  EDA: ['Находится на входящем учреждении обмена страны назначения', 'in_transit'],
  EDC: ['Выпущено с таможни импорта в стране назначения', 'in_transit'],
  EDD: ['Прибыло в центр сортировки страны назначения', 'in_transit'],
  EDE: ['Отправлено из центра сортировки в отделение доставки страны назначения', 'in_transit'],

  AtCustom: ['Передано на таможенный досмотр', 'customs'],
  DeliveredSVX: ['На хранении под наблюдением таможни', 'customs'],
  RPODELAY: ['РПО под наблюдением таможни', 'customs'],
  EME: ['Отправление задержано на таможне в стране назначения', 'customs'],
  EXA: ['Представлено экспортной таможне/безопасности в стране отправления', 'customs'],
  EXB: ['Задержано в экспортной таможне/безопасности в стране отправления', 'customs'],
  EDB: ['Предъявлено импортной таможне в стране назначения', 'customs'],

  DLV: ['Передано почтальону/курьеру на доставку', 'out_for_delivery'],
  DLV_I: ['Передано почтальону/курьеру на доставку', 'out_for_delivery'],
  DLV_O: ['Передано почтальону/курьеру на доставку', 'out_for_delivery'],
  EDG: ['Передано почтальону/курьеру на доставку в стране назначения', 'out_for_delivery'],

  NONDLV: ['Доставка почтальоном/курьером не состоялась', 'failed_attempt'],
  // The dictionary's own spelling.
  EMH: ['Доставка почтальоном/курьером не состоялась в стране назнаяения', 'failed_attempt'],

  STR_CLIENT: ['В ожидании клиента', 'ready_for_pickup'],
  DeliveredPVZ: ['Принято на хранение в пункте выдачи заказов', 'ready_for_pickup'],
  AbonementBox: ['Поступило в место выдачи', 'ready_for_pickup'],
  // Delivered to the pickup point, where the item waits for the recipient.
  Delivered: ['Ожидает получателя в пункте выдачи', 'ready_for_pickup'],
  STR: ['Ожидает получателя в пункте выдачи', 'ready_for_pickup'],
  STRSC: ['Ожидает получателя в пункте выдачи', 'ready_for_pickup'],
  SM_STR: ['Ожидает получателя в пункте выдачи', 'ready_for_pickup'],
  DLV_POBOX: ['Вложено в абонентский ящик', 'ready_for_pickup'],
  EDF: ['Ожидает получателя в пункте выдачи страны назначения', 'ready_for_pickup'],
  EDH: ['Передано на хранение в отделении доставки в стране назначения', 'ready_for_pickup'],

  Handed: ['Вручено', 'delivered'],
  HandedPVZ: ['Вручено в пункте выдачи заказов', 'delivered'],
  DLV_HAND: ['Доставлено курьером', 'delivered'],
  DPAY: ['Успешно вручено адресату', 'delivered'],
  ISSPAY: ['Успешно вручено адресату', 'delivered'],
  ISSSC: ['Успешно вручено адресату', 'delivered'],
  BOXISS: ['Успешно вручено адресату', 'delivered'],
  BOXISS_I: ['Вручено', 'delivered'],
  BOXISS_O: ['Вручено', 'delivered'],
  DLV_POBOX_I: ['Вручено', 'delivered'],
  DLV_POBOX_O: ['Вручено', 'delivered'],
  DPAY_I: ['Вручено', 'delivered'],
  DPAY_O: ['Вручено', 'delivered'],
  ISSPAY_I: ['Вручено', 'delivered'],
  ISSPAY_O: ['Вручено', 'delivered'],
  ISSSC_I: ['Вручено', 'delivered'],
  ISSSC_O: ['Вручено', 'delivered'],
  EMI: ['Отправление вручено в стране назначения', 'delivered'],

  ReturnedCompany: ['Почтовое отправление возвращено', 'returned'],
  ReturnedToCompany: ['Почтовое отправление возвращено', 'returned'],
  ReturnedPVZ: ['Возврат из пункта выдачи заказов', 'returned'],
  RET: ['Почтовое отправление возвращено', 'returned'],
  RETSTR: ['Почтовое отправление возвращено', 'returned'],
  RETSCSTR: ['Почтовое отправление возвращено', 'returned'],
  RETCC: ['Почтовое отправление возвращено', 'returned'],
  RETSC: ['Почтовое отправление возвращено', 'returned'],
  RET_I: ['Почтовое отправление возвращено', 'returned'],
  RET_O: ['Почтовое отправление возвращено', 'returned'],
  RETSTR_I: ['Почтовое отправление возвращено', 'returned'],
  RETSTR_O: ['Почтовое отправление возвращено', 'returned'],
  RETSC_I: ['Почтовое отправление возвращено', 'returned'],
  RETSC_O: ['Почтовое отправление возвращено', 'returned'],
  // The page words these as waiting at the pickup point, the dictionary as a
  // return from storage at a sorting centre.
  RETSCSTR_I: ['Ожидает получателя в пункте выдачи'],
  RETSCSTR_O: ['Ожидает получателя в пункте выдачи'],

  EXX: ['Экспорт почтового отправления отменен в стране отправления', 'exception'],
  EDX: ['Импорт отправления отменен в стране назначения', 'exception'],

  // Codes from the earlier dictionary at track.kazpost.kz, worded as it words them.
  SRTSND: ['Отправка из участка сортировки', 'in_transit'],
  SRTSNDB: ['Отправка из СЦ', 'in_transit'],
  TRNSRT: ['Прибытие транспорта в сортцентр', 'in_transit'],
  TRNRPO: ['Прибытие', 'in_transit'],
  AVIASND: ['Отправка на рейс', 'in_transit'],
  TRNPST: ['Прибытие в постамат', 'ready_for_pickup'],
};

/**
 * Codes the page hides: bag, list and act paperwork, customs handovers it
 * reports again on release, and corrections.
 */
const HIDDEN = new Set([
  'Sended_from_FLS', 'ArrivedCorpDep', 'PacketList', 'LabelList', 'DestinationList', 'DestinationListInternational',
  'TransportList', 'Collated', 'DetainedByCustom', 'Returned', 'Adjustment', 'RemovedFromForeign',
  'AddedToDeliveryList', 'SND_U', 'DLVADD', 'DLVPAY', 'NONDST', 'SendedToDeadLetter', 'Destroyed', 'TO_CUSTOM',
  'PAY_COD', 'FROM_CUSTOM', 'SRT_CUSTOM', 'UTL', 'STR_EXTEND', 'FPA', 'CORRECT', 'SRTRPOREG', 'TRN_ADD', 'TRNBAG',
  'TRANSITSND', 'TRN', 'BAT_I', 'BAT_O', 'STR_I', 'STR_O', 'STRSC_I', 'STRSC_O', 'SRTRPOREG_I', 'SRTRPOREG_O',
  'PRC_I', 'PRC_O', 'Send_act',
]);
// Acts of every kind, which the dictionary lists in part.
const ACT = /^(?:Act|New_act)(?:_[A-Z])?$/;
// A correction that cancels an earlier scan of the code before it.
const UNDO = /^(.+)_UNDO(_[IO])?$/;

/** Whether the page hides scans with this code. */
export function isHiddenKazpostCode(code: string): boolean {
  return HIDDEN.has(code) || ACT.test(code) || UNDO.test(code);
}

/**
 * The codes a correction cancels: `X_UNDO_I` cancels `X_I`, and `X_UNDO`
 * cancels `X` on either leg. Null for a code that cancels nothing.
 */
export function kazpostUndone(code: string): readonly string[] | null {
  const match = UNDO.exec(code);
  if (!match) return null;
  const [, base, leg] = match;
  return leg ? [`${base}${leg}`] : [base!, `${base}_I`, `${base}_O`];
}

/** The page's wording for a code it shows, if the dictionary has one. */
export function kazpostWording(code: string): string | undefined {
  return Object.hasOwn(KAZPOST_CODES, code) ? KAZPOST_CODES[code]![0] : undefined;
}

/** The stage the map gives a code. */
export function kazpostStage(code: string): Stage | undefined {
  return Object.hasOwn(KAZPOST_CODES, code) ? KAZPOST_CODES[code]![1] : undefined;
}

/** Every scan and summary carries its code, which alone gives the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? kazpostStage(code) : undefined),
  gaps: ['RETSCSTR_I', 'RETSCSTR_O'].map((code) => ({ code,
    note: 'The page words it as waiting at the pickup point, while Kazpost\'s dictionary names a return from storage at a sorting centre.' })),
};

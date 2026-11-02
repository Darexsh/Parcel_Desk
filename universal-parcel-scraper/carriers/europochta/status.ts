import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: Readonly<Record<string, Stage>> = {
  'Заявка на почтовое отправление зарегистрирована': 'registered',
  'Почтовое отправление принято на ОПС': 'accepted',
  'Оплачено на ОПС': 'accepted',
  'Почтовое отправление принято на ОПС с изменениями': 'accepted',
  'Почтовое отправление в доставке на центральный сортировочный пункт': 'in_transit',
  'Почтовое отправление прибыло на центральный сортировочный пункт': 'in_transit',
  'В пути на ОПС назначения': 'in_transit',
  'Почтовое отправление подготовлено в ОПС к доставке на сортировочный пункт': 'in_transit',
  'Почтовое отправление прибыло на сортировочный пункт': 'in_transit',
  'Почтовое отправление подготовлено в сортировочном пункте к доставке на ОПС назначения': 'in_transit',
  'Почтовое отправление прибыло на ОПС выдачи': 'ready_for_pickup',
  'Почтовое отправление выдано. Наложенный платеж оплачен': 'delivered',
  'Почтовое отправление выдано': 'delivered',
};
const mapped = new Map(Object.entries(WORDINGS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** Recipient notifications include a number, an office address and collection terms. */
export function europochtaWording(wording: string): string {
  if (/^Почтовое отправление прибыло для выдачи в Отделение /i.test(wording)
    || /^(?:Добрый день\.\s*)?Отправление .+ прибыло в Отделение /i.test(wording)) {
    return 'Почтовое отправление прибыло на ОПС выдачи';
  }
  if (/^(?:Добрый день\.\s*)?Срок бесплатного хранения почтового отправления /i.test(wording)) {
    return 'Срок бесплатного хранения почтового отправления истекает';
  }
  return wording;
}

export function europochtaMappedStage(wording: string): Stage | undefined {
  return mapped.get(normalizeStatusWording(europochtaWording(wording)));
}

export function europochtaStage(wording: string): ClassifiedWording | null {
  const stage = europochtaMappedStage(wording);
  if (stage) return { stage, source: 'carrier_map' };
  // Relabelling and storage reminders move nothing.
  if (/^(?:Почтовое отправление перемаркировано|Срок бесплатного хранения почтового отправления истекает)$/.test(europochtaWording(wording))) return null;
  const answer = classifyWording(wording, 'in_transit');
  return answer.source === 'none' ? null : answer;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : europochtaMappedStage(wording),
  gaps: [
    { wording: 'почтовое отправление перемаркировано', note: 'A replacement label does not establish movement.' },
    { wording: 'срок бесплатного хранения почтового отправления истекает', note: 'A storage reminder does not establish movement.' },
  ],
  gapNote: (code, wording) => !code && /^срок бесплатного хранения почтового отправления истекает$/i.test(europochtaWording(wording))
    ? 'A storage reminder does not establish movement.' : undefined,
};

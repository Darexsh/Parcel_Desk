import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The German sentences IDS's tracking page shows, from the messages file it
 * loads (`/files/trackingAppMessages/de.json`). The page names a scan by its
 * status code; a scan whose code has no sentence is named by its `mp` code
 * instead, and only at the depot that code belongs to (`IDS_MP`). It hides
 * every other scan.
 */
const DELIVERY_PLANNED = 'Die Zustellung Ihrer Sendung ist zum angekündigten Zustelltermin geplant.';
const DELAYED = 'Es sind leider unvorhersehbare Zustellverzögerungen aufgetreten. Bei Sendungen mit vereinbartem Liefertermin melden wir uns erneut bei Ihnen.';
const REFUSED = 'Ihre Sendung wurde annahmeverweigert. Bitte wenden Sie sich für weitere Fragen an Ihren Versender.';
const DELIVERED = 'Ihre Sendung wurde zugestellt.';
const AT_DELIVERY_DEPOT = 'Ihre Sendung ist im Zustelldepot eingetroffen und wird für die Zustellung vorbereitet.';

type Named = { wording: string; stage: Stage };
const each = (codes: readonly string[], named: Named): [string, Named][] => codes.map((code) => [code, named]);

export const IDS_CODES: ReadonlyMap<string, Named> = new Map([
  // The page files these at the delivering depot: the parcel is there, with a delivery appointment.
  ...each(['24', '25', '55', '25G', '25 G'], { wording: DELIVERY_PLANNED, stage: 'in_transit' }),
  ...each(['10', '12'], { wording: DELAYED, stage: 'exception' }),
  ['40', { wording: 'Ihre Sendung befindet sich in der Zustellung.', stage: 'out_for_delivery' }],
  // Refused at the door; the sender decides what happens next.
  ...each(['23', '23A', '23B', '23M', '23P', '23Q', '23U', '23V', '23W', '23X', '23Y', '23Z'], { wording: REFUSED, stage: 'exception' }),
  ...each(['27', '26A', '26C', '26M', '26P', '26Q'], { wording: DELIVERED, stage: 'delivered' }),
  ['22', { wording: 'Wir konnten Sie nicht antreffen oder Ihre Warenannahme war bereits geschlossen. Bei Sendungen mit vereinbartem Liefertermin melden wir uns erneut bei Ihnen.', stage: 'failed_attempt' }],
  // The shipment's data or address is wrong; IDS checks with the sender.
  ['04', { wording: 'Leider liegen IDS unvollständige oder falsche Sendungsdaten vor. Bitte haben Sie Geduld. Wir befinden uns in Prüfung mit Ihrem Versender.', stage: 'exception' }],
  ['04C', { wording: 'Leider liegen IDS ungültige Adressdaten vor. Bitte haben Sie Geduld. Wir befinden uns in Prüfung mit ihrem Versender', stage: 'exception' }],
]);

/** Codes whose scan the page moves to the delivering depot, whatever depot the reply names. */
export const AT_END_DEPOT_CODES: ReadonlySet<string> = new Set(['24', '25', '25G', '25 G', '55']);

/**
 * The `mp` codes, with the depot whose scan they name, the collecting
 * (`start`) or the delivering (`end`) one, and the step of the page's
 * progress rail such a scan reaches.
 */
export const IDS_MP: ReadonlyMap<string, { wording: string; stage: Stage; depot: 'start' | 'end'; step: number }> = new Map([
  ['02', { wording: 'Ihre Sendung wurde abgeholt und befindet sich in unserem Versanddepot.', stage: 'accepted', depot: 'start', step: 2 }],
  ['05', { wording: AT_DELIVERY_DEPOT, stage: 'in_transit', depot: 'end', step: 4 }],
  ['09', { wording: AT_DELIVERY_DEPOT, stage: 'in_transit', depot: 'end', step: 4 }],
  ['08', { wording: DELIVERED, stage: 'delivered', depot: 'end', step: 6 }],
]);

/**
 * The scan the page adds at the collecting depot when the shipment went on a
 * linehaul manifest (`header.bordered`), which reaches step 3.
 */
export const IDS_BORDERED = { wording: 'Ihre Sendung befindet sich auf dem Weg zu unserem Zustelldepot.', stage: 'in_transit' as Stage, step: 3 };

/**
 * The page's progress rail, `result.status` raised by the scans it shows,
 * by step: its label and stage. Step 0 is a shipment without data.
 */
export const IDS_STEPS: readonly ({ label: string; stage: Stage } | null)[] = [
  null,
  { label: 'Daten übermittelt.', stage: 'registered' },
  { label: 'Im Versanddepot.', stage: 'accepted' },
  { label: 'Unterwegs zum Zustelldepot.', stage: 'in_transit' },
  { label: 'Im Zustelldepot.', stage: 'in_transit' },
  { label: 'In der Zustellung.', stage: 'out_for_delivery' },
  { label: 'Zugestellt.', stage: 'delivered' },
];

/** The page's own sentences and step labels, in `normalizeStatusWording` form. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ...[...IDS_CODES.values(), ...IDS_MP.values(), IDS_BORDERED].map(({ wording, stage }) => [normalizeStatusWording(wording), stage] as const),
  ...IDS_STEPS.flatMap((step) => (step ? [[normalizeStatusWording(step.label), step.stage] as const] : [])),
]);

/** The stage IDS gives a status code, else one of the page's sentences or step labels. */
export function idsMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? IDS_CODES.get(code)?.stage : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: idsMappedStage,
  gaps: [],
};

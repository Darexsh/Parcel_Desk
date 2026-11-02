import type { Stage } from '../../core/status/index.js';
import { escapeRegExp } from '../../core/transport/text.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const TOWN = '<town>';
const WORDINGS = new Map<string, Stage>(statuses.entries.filter((entry) => !entry.wording.includes(TOWN))
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// Wordings that name the destination town, which can hold letters, spaces, dots, apostrophes and hyphens.
const PLACED = statuses.entries.filter((entry) => entry.wording.includes(TOWN)).map((entry) => ({
  pattern: new RegExp(`^${normalizeStatusWording(entry.wording).split(TOWN).map(escapeRegExp).join("\\p{L}[\\p{L}\\p{M} .'’-]*")}$`, 'u'),
  stage: entry.stage as Stage,
}));

/** The stage MeiHoo Pegasus's map gives a row, by its `normalizeStatusWording` wording. Its rows have no kind code. */
export function meihooPegasusStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? PLACED.find(({ pattern }) => pattern.test(wording))?.stage;
}

export const statusMap: CarrierStatusMap = { stage: meihooPegasusStage, gaps: [] };

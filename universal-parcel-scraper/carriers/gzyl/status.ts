import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** Wordings GZYL writes a town after, leaving the row's own place empty. */
export const PLACED_WORDINGS: readonly string[] = ['Arrival sorting, distribution center', 'Leaving the sorting center', 'Package is on the way', 'Delivered'];
const PLACED = PLACED_WORDINGS.map((wording) => `${normalizeStatusWording(wording)} `);
// A town: a letter, then letters, digits, spaces, dots, apostrophes, hyphens or the question
// marks GZYL writes for letters it lost, but not a phrase such as "to the neighbour" that goes on the wording.
export const TOWN = /^(?!(?:to|at|in|on|by|with|from|for)\b)\p{L}[\p{L}\p{N} .'?-]*$/iu;
// The city some rows name after the wording, in brackets: "[Los Angeles]".
const PLACE_TAIL = / \[[^\]]+\]$/;

/**
 * The stage GZYL's map gives a row, by its `normalizeStatusWording` wording.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 * A placed wording that still carries its town, as a provider relays it, and a
 * wording with its city in brackets, read as the wording alone.
 */
export function gzylStage(_code: string | null, wording: string): Stage | undefined {
  const prefix = PLACED.find((placed) => wording.startsWith(placed) && TOWN.test(wording.slice(placed.length)));
  return WORDINGS.get(wording) ?? (prefix ? WORDINGS.get(prefix.trimEnd()) : undefined) ?? WORDINGS.get(wording.replace(PLACE_TAIL, ''));
}

export const statusMap: CarrierStatusMap = { stage: gzylStage, gaps: [] };

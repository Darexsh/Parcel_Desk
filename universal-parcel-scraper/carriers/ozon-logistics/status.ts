import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const codes = new Map<string, Stage>();
const words = new Map<string, Stage>();
const labels = new Map<string, string>();
for (const entry of statuses.entries) {
  if (entry.code && entry.wording) labels.set(entry.code, entry.wording);
  if (entry.stage) {
    if (entry.code) codes.set(entry.code, entry.stage as Stage);
    if (entry.wording) words.set(normalizeStatusWording(entry.wording), entry.stage as Stage);
  }
}

export const ozonStage = (code: string): Stage | undefined => codes.get(code);
export const ozonWording = (code: string): string => labels.get(code) ?? code;
export const statusMap: CarrierStatusMap = { stage: (code, wording) => (code ? codes.get(code) : undefined) ?? words.get(wording), gaps: [] };

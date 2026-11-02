import { describe, expect, it } from 'vitest';
import { NoHistoryError } from '../errors/index.js';
import { dueScans, withoutEvents } from './due.js';
import type { CarrierResult } from './index.js';

// Synthetic clocks and wording.
const READ_AT = Date.parse('2026-01-03T10:00:00Z');
const departed = { time: '2026-01-03T13:00:00+02:00', description: 'Departed facility', stage: 'in_transit' };
const arrived = { time: '2026-01-03T09:30:00Z', description: 'Arrived at facility', stage: 'in_transit' };
const accepted = { time: '2026-01-02T18:00:00Z', description: 'Accepted', stage: 'accepted' };
const answer = {
  status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', provider_code: 'DP',
  last_status_text: departed.description, last_update: departed.time, events: [departed, arrived, accepted],
} satisfies CarrierResult;

describe('scans entered at their planned time', () => {
  it('are held back until due, and the status is read from the scans left', () => {
    const due = dueScans(answer, 'example', READ_AT);
    expect(due).toMatchObject({ status: 'unknown', last_status_text: 'Arrived at facility', last_update: arrived.time, events: [arrived, accepted] });
    for (const field of ['current_stage', 'current_stage_source', 'provider_code']) expect(due).not.toHaveProperty(field);
    // Due a few minutes after the lookup is a clock running fast, and no plan.
    expect(dueScans(answer, 'example', Date.parse('2026-01-03T10:57:00Z'))).toBe(answer);
  });

  it('leave an answer of nothing but them without history', () => {
    expect(() => dueScans({ ...answer, events: [departed] }, 'example', READ_AT)).toThrow(NoHistoryError);
    expect(() => dueScans({ status: 'in_transit', last_update: departed.time, summary_only: true, events: [] }, 'example', READ_AT)).toThrow(NoHistoryError);
  });

  it('keep the summary when an older row goes', () => {
    expect(withoutEvents(answer, event => event === accepted)).toMatchObject({ current_stage: 'in_transit', provider_code: 'DP', events: [departed, arrived] });
    expect(withoutEvents(answer, () => false)).toBe(answer);
  });
});

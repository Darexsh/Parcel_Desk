import { describe, expect, it } from 'vitest';
import type { CarrierResult } from './index.js';
import { fillPartialAnswer, isPartialAnswer, withoutWrittenAhead } from './partial.js';

// Synthetic numbers, clocks and wording.
const NUMBER = '1Z999AA10123456784';
const summary: CarrierResult = {
  status: 'in_transit', last_status_text: 'Synthetic status', last_update: '2026-01-03T09:00:00Z',
  expected_delivery: '2026-01-05', summary_only: true, events: [],
};
const history = {
  status: 'in_transit', last_status_text: 'Departed facility', last_update: '2026-01-03T09:00:00Z',
  events: [
    { time: '2026-01-03T09:00:00Z', description: 'Departed facility' },
    { time: '2026-01-02T18:00:00Z', description: 'Arrived at facility' },
    { time: '2026-01-01T12:00:00Z', description: 'Picked up' },
  ],
} satisfies CarrierResult;

describe('partial carrier answers', () => {
  it('are the ones marked status-only or truncated', () => {
    expect(isPartialAnswer(summary)).toBe(true);
    expect(isPartialAnswer({ ...history, history_truncated: true })).toBe(true);
    expect(isPartialAnswer(history)).toBe(false);
  });

  it('take a fuller history as it came, with the carrier facts it lacks', () => {
    const import_charges = { currency: 'EUR', customs: 12.34 };
    const filled = fillPartialAnswer('ups', NUMBER, { ...summary, import_charges }, { ...history, tracking_provider: 'Ship24' });
    expect(filled).toMatchObject({ tracking_provider: 'Ship24', expected_delivery: '2026-01-05', last_status_text: 'Departed facility',
      import_charges });
    // The provider's events are not resolved: hosts classify them as they persist them.
    expect(filled?.events).toEqual(history.events);
  });

  it('stand against a history that is no fuller, names another carrier or is behind the carrier', () => {
    expect(fillPartialAnswer('ups', NUMBER, { ...history, history_truncated: true }, history)).toBeNull();
    expect(fillPartialAnswer('ups', NUMBER, summary, { ...history, discovered_carrier: 'fedex' })).toBeNull();
    expect(fillPartialAnswer('ups', NUMBER, { ...summary, last_update: '2026-01-04T09:00:00Z' }, history)).toBeNull();
  });

  it('take a history that names another network of the carrier\'s brand', () => {
    expect(fillPartialAnswer('gofo-fr', NUMBER, summary, { ...history, discovered_carrier: 'gofo' })).not.toBeNull();
    expect(fillPartialAnswer('dpd', NUMBER, summary, { ...history, discovered_carrier: 'dpd-de' })).not.toBeNull();
    expect(fillPartialAnswer('gofo-fr', NUMBER, summary, { ...history, discovered_carrier: 'gls-fr' })).toBeNull();
    // A carrier whose id merely starts like a brand is not one of its networks.
    expect(fillPartialAnswer('dhl', NUMBER, summary, { ...history, discovered_carrier: 'dhlink' })).toBeNull();
  });

  it('keep the carrier\'s delivery over a history that has not reached it', () => {
    const delivered = { ...summary, status: 'delivered', last_status_text: 'Delivered', last_update: '2026-01-02T08:00:00Z' } as const;
    expect(fillPartialAnswer('ups', NUMBER, delivered, history)).toBeNull();
    const after = { ...history, events: [{ time: '2026-01-03T09:00:00Z', description: 'Processing' },
      { time: '2026-01-02T08:00:00Z', description: 'Delivered' }, ...history.events.slice(2)] };
    expect(fillPartialAnswer('ups', NUMBER, delivered, after)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_status_text: 'Delivered' });
    expect(fillPartialAnswer('ups', NUMBER, delivered, after)).not.toHaveProperty('expected_delivery');
  });
});

describe('rows a carrier wrote ahead', () => {
  // A timeline on a Beijing clock: the provider relays two rows the carrier holds back, and one scan of its own.
  const customs = { time: '2026-01-03T01:00:17Z', description: 'Customs clearance', stage: 'customs' };
  const arrived = { time: '2026-01-02T18:00:00Z', description: 'Arrived at facility', stage: 'in_transit' };
  const departed = { time: '2026-01-01T02:06:28Z', description: 'Departed facility', stage: 'in_transit' };
  const relayed = {
    status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map', last_status_text: 'Customs clearance',
    last_update: customs.time, events: [customs, arrived, departed],
  } satisfies CarrierResult;
  const ahead = ['2026-01-03T09:00:17+08:00', '2026-01-01T10:06:28+08:00'];

  it('are set aside from a provider\'s answer, at the same instant within a minute or the same wall time', () => {
    expect(withoutWrittenAhead(relayed, ahead)).toMatchObject({ status: 'unknown', last_status_text: 'Arrived at facility',
      last_update: arrived.time, events: [arrived] });
    expect(withoutWrittenAhead(relayed, ahead)).not.toHaveProperty('current_stage');
    // A provider that drops the seconds, or labels the carrier's wall clock as UTC.
    expect(withoutWrittenAhead({ ...relayed, events: [arrived, { ...departed, time: '2026-01-01T02:06:00Z' }] }, ahead)?.events).toEqual([arrived]);
    expect(withoutWrittenAhead({ ...relayed, events: [arrived, { ...departed, time: '2026-01-01T10:06:28Z' }] }, ahead)?.events).toEqual([arrived]);
    // The newest row stays, and with it the provider's status.
    expect(withoutWrittenAhead(relayed, ahead.slice(1))).toMatchObject({ current_stage: 'customs', events: [customs, arrived] });
  });

  it('are set aside from a fallback that fills a carrier\'s partial answer that names them', () => {
    const direct = { ...summary, last_update: '2026-01-01T00:00:00Z', written_ahead: ahead };
    expect(fillPartialAnswer('ups', NUMBER, direct, relayed)?.events).toEqual([arrived]);
    // A fallback left with nothing, or no fuller than the carrier, leaves the carrier's answer.
    expect(fillPartialAnswer('ups', NUMBER, direct, { ...relayed, events: [customs, departed] })).toBeNull();
    expect(fillPartialAnswer('ups', NUMBER, { ...direct, events: [{ ...arrived, time: '2026-01-02T18:30:00Z' }], summary_only: false,
      history_truncated: true }, { ...relayed, events: [customs, { ...arrived, time: '2026-01-02T18:31:00Z' }, departed] })).toBeNull();
  });

  it('leave nothing of an answer made only of them, and an answer without them as it came', () => {
    expect(withoutWrittenAhead({ ...relayed, events: [departed], last_update: departed.time }, ahead)).toBeNull();
    expect(withoutWrittenAhead({ ...summary, last_update: '2026-01-03T01:00:40Z' }, ahead)).toBeNull();
    // A scan on the same wall minute with other seconds is another scan.
    expect(withoutWrittenAhead(history, ahead)).toBe(history);
    expect(withoutWrittenAhead(relayed, [])).toBe(relayed);
  });
});

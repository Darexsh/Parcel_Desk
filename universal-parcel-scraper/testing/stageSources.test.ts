import { describe, expect, it } from 'vitest';
import { classifyStage, inferStage, normalizeCarrierResult, resolveResult, resultHasUpdate, resultStage, stageSource, type CarrierResult } from '../index.js';
import { event, localEvent, result } from '../providers/shared/result.js';

const TIME = '2026-01-01T12:00:00Z';

describe('classification provenance', () => {
  it.each([
    ['Unrecognized carrier message', undefined, 'pending', 'none'],
    ['Sorted in regional hub', undefined, 'in_transit', 'wording:language'],
    ['Item received for transport', undefined, 'accepted', 'wording:language'],
    ['Provider milestone 42', 'InTransit', 'in_transit', 'carrier_map'],
    ['Unrecognized carrier message', 'UnrecognizedCategory', 'pending', 'none'],
    ['Delivered to local carrier', 'Delivered', 'in_transit', 'wording:provider'],
    ['Delivered, signed by SYNTHETIC RECIPIENT', undefined, 'delivered', 'wording:provider'],
  ])('retains the decision for %s (%s)', (description, category, stage, source) => {
    const parsed = event(TIME, description, category)!;
    expect(parsed).toMatchObject({ stage, stage_source: source });
    const normalized = normalizeCarrierResult({ events: [parsed] });
    expect(resolveResult(normalized).events[0]).toMatchObject({ stage, stage_source: source });
    if (stage === 'delivered') expect(parsed.description).toBe('Delivered');
  });

  it('retains wording provenance for local clocks and the milestone chosen for the summary', () => {
    const movement = localEvent('2026-01-01T11:00:00', 'Sorted in regional hub')!;
    const unknown = localEvent('2026-01-01T12:00:00', 'Unrecognized carrier message')!;
    expect(unknown).toMatchObject({ stage: 'pending', stage_source: 'none' });
    expect(result([unknown, movement], 'Postal Ninja')).toMatchObject({
      current_stage: 'in_transit', current_stage_source: 'wording:language',
    });
    expect(result([unknown], 'Postal Ninja')).toMatchObject({ current_stage: 'pending', current_stage_source: 'none' });
  });

  it('keeps legacy adapter maps while preserving explicit pending and wording decisions', () => {
    expect(stageSource('accepted', 'Vague description')).toBe('carrier_map');
    expect(stageSource('pending', 'Unrecognized carrier message', 'none')).toBe('none');
    expect(stageSource('in_transit', 'Sorted in regional hub', 'wording:provider')).toBe('wording:provider');
    expect(stageSource('', 'Sorted in regional hub', 'carrier_map')).toBe('wording:language');
    for (const invalid of ['', 42, 'other', 'wording:', `wording:${'x'.repeat(100)}`]) {
      expect(stageSource('accepted', 'Vague description', invalid)).toBe('carrier_map');
    }
  });
});

// GENERATED notices: a delivery still to come is no scan, so the newest one
// does not step a parcel back to registered.
describe('a delivery notice as the newest scan', () => {
  const NOTICE = 'We emailed you that your parcel will be delivered on Tuesday between 10:00 a.m. and 11:00 a.m.';
  const history = (status: CarrierResult['status']): CarrierResult => ({ status, last_status_text: NOTICE, events: [
    { time: '2026-01-02T08:00:00Z', description: NOTICE },
    { time: '2026-01-01T18:00:00Z', description: status === 'out_for_delivery' ? 'Out for delivery' : 'Arrived at the delivery depot' },
  ] });

  it.each(['in_transit', 'out_for_delivery'] as const)('keeps the %s stage the scans before it reached', (stage) => {
    expect(resultStage(history(stage))).toBe(stage);
    const resolved = resolveResult(history(stage));
    expect(resolved.current_stage).toBe(stage);
    expect(resolved.events[0]).toMatchObject({ stage: 'in_transit', stage_source: 'none' });
    expect(resolved.events[1]).toMatchObject({ stage, stage_source: 'wording:language' });
  });

  it('gives the notice itself no stage and no update', () => {
    expect(classifyStage(NOTICE, 'pending')).toEqual({ stage: 'pending', source: 'none' });
    expect(inferStage(NOTICE)).toBe('in_transit');
    expect(resultStage({ status: 'pending', last_status_text: NOTICE, events: [{ time: TIME, description: NOTICE, stage: 'customs' }] }))
      .toBe('customs');
    expect(resultHasUpdate({ status: 'pending', last_status_text: NOTICE, events: [{ time: TIME, description: NOTICE }] })).toBe(false);
    const notice = event('2026-01-02T08:00:00Z', NOTICE)!;
    expect(notice).toMatchObject({ stage: 'pending', stage_source: 'none' });
    expect(result([notice, event(TIME, 'Arrived at the delivery depot')!], 'Postal Ninja'))
      .toMatchObject({ current_stage: 'in_transit', current_stage_source: 'wording:language' });
  });
});

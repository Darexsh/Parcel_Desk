import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isJntCargoTrackingNumber, JNT_CARGO_MASTER_PATTERN, JNT_CARGO_PIECE_PATTERN } from '../../core/detection/jntCargo.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import metadata from './carrier.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { normalizeJntCargoNumber, parseJntCargo, parseJntCargoJson } from './parser.js';
import { statusMap } from './status.js';

const MASTER = '200000000001';
const PIECE = '200000000001002';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const payload = (name = 'master.json') => JSON.parse(fixture(name)) as {
  code: number; succ: boolean; fail: boolean; data: Record<string, unknown>[];
};
const scans = (value: ReturnType<typeof payload>) => value.data[0]!.details as Record<string, unknown>[];

describe('J&T Cargo parser', () => {
  it('retains exact master history with its own progress, unresolved clocks and departure location', () => {
    const result = normalizeCarrierResult(parseJntCargoJson(fixture('master.json'), MASTER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-01-02T12:30:00', service_name: 'MassTrack',
      events: [
        { provider_code: '92', stage: 'in_transit', local_time: '2026-01-02T12:30:00', location: 'Example City, Example Province' },
        { provider_code: '50', stage: 'in_transit', location: 'Example Origin, Example Origin Province' },
        { provider_code: '10', stage: 'accepted' },
      ] });
    expect(result.timezone).toBeUndefined();
    expect(result.events!.every(event => !event.time && !event.instant)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('2026-01-05');
    expect(result.weight_kg).toBeUndefined();
    expect(result.packageNumber).toBeUndefined();
  });

  it('keeps a delivered piece separate from the unfinished master and drops private details and totals', () => {
    const piece = parseJntCargoJson(fixture('piece.json'), PIECE);
    const master = parseJntCargoJson(fixture('master.json'), MASTER);
    expect(piece).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-01-03T15:45:00',
      events: [{ provider_code: '100', stage: 'delivered' }, { provider_code: '94', stage: 'out_for_delivery' }, { provider_code: '90', stage: 'in_transit' }] });
    expect(master.status).toBe('in_transit');
    for (const result of [piece, master]) {
      const serialized = JSON.stringify(result);
      for (const privateText of ['Example Recipient', 'Example Staff', 'Example Courier', '00000000000', 'Private', 'private-proof']) {
        expect(serialized).not.toContain(privateText);
      }
      expect(result.weight_kg).toBeUndefined();
      expect(result.canonical_tracking_number).toBeUndefined();
    }
  });

  it('rejects a master substituted for a requested piece and a delivered child mixed into the master', () => {
    expect(() => parseJntCargoJson(fixture('master.json'), PIECE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJntCargoJson(fixture('piece.json'), MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const value = payload();
    scans(value).unshift(scans(payload('piece.json'))[0]!);
    expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([`${MASTER}0`, `0${MASTER}`, 200000000001, { value: MASTER }, null])('rejects nonexact keyword identity %j', keyword => {
    const value = payload(); value.data[0]!.keyword = keyword;
    expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('validates identities before deduplication and past the retained 100 scans', () => {
    const value = payload();
    const row = scans(value)[0]!;
    value.data[0]!.details = Array.from({ length: 101 }, () => ({ ...row }));
    scans(value)[100]!.billCode = PIECE;
    expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    value.data.push({ ...value.data[0]! });
    expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[null, 'portal_not_found'], [[], undefined]])('keeps a bound placeholder or empty history inconclusive (%j)', (details, reason) => {
    const value = payload('unknown.json'); value.data[0]!.details = details;
    expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason }));
  });

  it('keeps generic empty and failed replies inconclusive, while malformed schema is rejected', () => {
    expect(() => parseJntCargo({ code: 1, succ: true, fail: false, data: [] }, MASTER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJntCargo({ code: 4000, succ: false, fail: true, data: null }, MASTER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const value of [null, {}, { code: 1, succ: 'true', fail: false, data: [] }, { code: 1, succ: true, fail: false, data: {} }]) {
      expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = payload(); delete value.data[0]!.details;
    expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['2026-02-30 12:00:00', '2026-01-01 25:00:00', '2026-01-01 12:60:00', '2026-01-01 12:00:00+07:00', '0000-00-00 00:00:00', null, {}])(
    'rejects malformed or changed clock %j without manufacturing an instant', scanTime => {
      const value = payload(); scans(value)[0]!.scanTime = scanTime;
      expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    });

  it('keeps upstream order when facility clocks cannot be compared across zones', () => {
    const value = payload(); scans(value)[0]!.scanTime = '2026-01-02 06:00:00';
    const events = parseJntCargo(value, MASTER).events!;
    expect(events.map(event => event.local_time)).toEqual(['2026-01-02T06:00:00', '2026-01-02T08:00:00', '2026-01-01T09:00:00']);
  });

  it('deduplicates exact projected scans and bounds distinct retained history', () => {
    const value = payload(); const row = scans(value)[0]!;
    scans(value).push({ ...row, customerTracking: 'Other Example Recipient' });
    expect(parseJntCargo(value, MASTER).events).toHaveLength(3);
    value.data[0]!.details = Array.from({ length: 101 }, (_, index) => ({ ...row,
      scanTime: `2026-01-02 ${String(23 - Math.floor(index / 60)).padStart(2, '0')}:${String(59 - index % 60).padStart(2, '0')}:00` }));
    expect(parseJntCargo(value, MASTER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseJntCargo(value, MASTER).events).toHaveLength(100);
    value.data[0]!.details = Array.from({ length: 501 }, () => row);
    expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects objects as projected labels, codes or locations and keeps unmapped provenance honest', () => {
    for (const [field, bad] of [['status', {}], ['code', -1], ['code', {}], ['scanNetworkCity', []]] as const) {
      const value = payload(); scans(value)[0]![field] = bad;
      expect(() => parseJntCargo(value, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = payload(); Object.assign(scans(value)[0]!, { code: 999, status: 'Unclassified operation' });
    const result = parseJntCargo(value, MASTER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toMatchObject({ provider_code: '999', stage_source: 'none' });
  });

  it('classifies blocked HTML without treating challenge words in discarded JSON fields as a challenge', () => {
    for (const body of ['<html><title>Just a moment...</title></html>', '<html>CAPTCHA required</html>', 'Access denied']) {
      expect(() => parseJntCargoJson(body, MASTER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
    for (const body of ['{', '<html>Changed tracking page</html>']) {
      expect(() => parseJntCargoJson(body, MASTER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = payload(); value.data[0]!.receiverName = 'Captcha Access Denied';
    scans(value)[0]!.customerTracking = 'captcha access denied';
    expect(parseJntCargoJson(JSON.stringify(value), MASTER).status).toBe('in_transit');
  });

  it.each([148013016, 148013017])('preserves documented authentication refusal code %s as a challenge', code => {
    expect(() => parseJntCargo({ code, succ: false, fail: true, data: null }, MASTER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps shared eligibility aligned with both catalog rules and refuses unsupported whole identifiers', () => {
    expect(metadata.detection.map(rule => rule.pattern)).toEqual([JNT_CARGO_MASTER_PATTERN, JNT_CARGO_PIECE_PATTERN]);
    expect(normalizeJntCargoNumber('20 0000 000001.002')).toBe(PIECE);
    for (const number of [MASTER, PIECE]) expect(isJntCargoTrackingNumber(number)).toBe(true);
    for (const number of ['20000000001', '570000000001', '20000000000100', 'X' + MASTER, PIECE + '0', MASTER + ';' + MASTER]) {
      expect(isJntCargoTrackingNumber(number)).toBe(false);
      expect(() => normalizeJntCargoNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it.each(statuses.entries)('maps observed Cargo scan $code with explicit provenance', entry => {
    expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
    const value = payload(); Object.assign(scans(value)[0]!, { code: Number(entry.code), status: entry.wording });
    expect(parseJntCargo(value, MASTER).events![0]).toMatchObject({ stage: entry.stage, stage_source: 'carrier_map' });
  });
});

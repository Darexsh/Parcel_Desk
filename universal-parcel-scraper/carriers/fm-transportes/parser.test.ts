import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeFmTransportesNumber, parseFmTransportes } from './parser.js';
import { fmTransportesMappedStage, fmTransportesStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '011126AB7C9D2E4F6G';
const OTHER = '021126QX7Z9H2J4K6M';
interface Fixture {
  success: boolean;
  data: {
    trackingCode: unknown;
    deliveryForecast: unknown;
    volumes: { receivedBy: unknown; events: Record<string, unknown>[] }[];
    [key: string]: unknown;
  };
}
const fixture = (): Fixture => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const rows = (value: Fixture) => value.data.volumes[0]!.events;
const fail = (payload: unknown, kind: string) => expect(() => parseFmTransportes(payload, NUMBER)).toThrow(expect.objectContaining({ kind }));

describe('FM Transportes guest response parser', () => {
  it('reads all milestones newest first, preserving explicit UTC precision and the forecast calendar day', () => {
    const result = parseFmTransportes(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Encomenda Entregue', last_update: '2026-11-03T21:01:02.321Z', expected_delivery: '2026-11-04' });
    expect(result.events!.map(event => [event.time, event.stage])).toEqual([
      ['2026-11-03T21:01:02.321Z', 'delivered'],
      ['2026-11-03T17:49:00.003Z', 'out_for_delivery'],
      ['2026-11-03T13:33:00Z', 'failed_attempt'],
      ['2026-11-03T13:29:00.1Z', 'in_transit'],
      ['2026-11-02T17:48:00.001Z', 'out_for_delivery'],
      ['2026-11-01T22:46:00Z', 'in_transit'],
      ['2026-11-01T18:39:00.12Z', 'accepted'],
      ['2026-11-01T12:08:01.123Z', 'registered'],
    ]);
    expect(result.events!.every(event => event.stage_source === 'carrier_map' && !event.local_time && !event.provider_code)).toBe(true);
  });

  it('projects only scan fields and does not retain addresses, references or signatories', () => {
    const result = parseFmTransportes(fixture(), NUMBER);
    const output = JSON.stringify(result);
    for (const privateText of [NUMBER, 'SYNTHETIC', 'Example Street', 'Example District', 'Example City', '8000000', 'fiscalNoteNumber', 'receivedBy', 'orderNumber']) {
      expect(output, privateText).not.toContain(privateText);
    }
    expect(result.sender_name).toBeUndefined();
    expect(result.receiver_name).toBeUndefined();
  });

  it('shares detection eligibility without admitting Zeleris or arbitrary eighteen-character labels', () => {
    expect(detectCarrierMatch(NUMBER).candidates).toContain('fm-transportes');
    expect(normalizeFmTransportesNumber('01 11 26 ab7c-9d2e4f6g')).toBe(NUMBER);
    for (const number of ['011126AF123456789K', '011126123456789012', 'ZZ1126AB7C9D2E4F6G', NUMBER + '9']) {
      expect(() => normalizeFmTransportesNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it.each([OTHER, NUMBER + '7', NUMBER + ' '.repeat(300) + OTHER])('rejects a different whole response identity', identity => {
    const value = fixture(); value.data.trackingCode = identity;
    fail(value, 'indeterminate');
  });

  it.each([null, 123, {}, [NUMBER]])('rejects a non-string response identifier', identity => {
    const value = fixture(); value.data.trackingCode = identity;
    fail(value, 'schema');
  });

  it('does not complete a second unfinished volume because the first was delivered', () => {
    const value = fixture();
    value.data.volumes.push({ receivedBy: '', events: [{ date: '2026-11-03T20:00:00Z', description: 'Processo de Entrega Iniciado' }] });
    fail(value, 'indeterminate');
  });

  it('does not infer delivery from recipient metadata without an actual delivery scan', () => {
    const value = fixture();
    value.data.status = 'Encomenda Entregue';
    rows(value).splice(1);
    expect(parseFmTransportes(value, NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it.each([undefined, null, { success: true }, { success: true, data: null }, { success: true, data: {} },
    { success: true, data: { trackingCode: NUMBER, volumes: [] } },
    { success: true, data: { trackingCode: NUMBER, volumes: [{ receivedBy: 'SYNTHETIC', events: [] }] } },
  ])('keeps empty or missing history inconclusive', payload => fail(payload, 'indeterminate'));

  it.each([{ success: false }, { success: false, error: 'unrecognized backend error' }])('does not turn an upstream error into parcel absence', payload => {
    fail(payload, 'indeterminate');
  });

  it.each([{}, { success: 'true', data: {} }, { success: true, data: [] },
    { success: true, data: { trackingCode: NUMBER } },
    { success: true, data: { trackingCode: NUMBER, volumes: [null] } },
    { success: true, data: { trackingCode: NUMBER, volumes: [{ events: {} }] } },
  ])('rejects a changed response schema', payload => fail(payload, 'schema'));

  it.each(['2026-02-30T10:00:00Z', '2026-11-01T24:00:00Z', '2026-11-01T10:00:60Z',
    '2026-11-01T10:00:00', '2026-11-01T10:00:00+03:00', '2026-11-01', null, {},
  ])('rejects a malformed or unobserved scan clock', clock => {
    const value = fixture(); rows(value)[0]!.date = clock;
    fail(value, 'schema');
  });

  it('keeps future forecast days as estimates without manufacturing scans', () => {
    const value = fixture(); rows(value).splice(1); value.data.deliveryForecast = '2031-01-02T00:00:00';
    const result = parseFmTransportes(value, NUMBER);
    expect(result).toMatchObject({ expected_delivery: '2031-01-02', last_update: '2026-11-01T12:08:01.123Z' });
    expect(result.events).toHaveLength(1);
  });

  it.each(['2026-02-30T00:00:00', '2026-11-01T24:00:00', '2026-11-01T00:00:00Z', {}, 0])('rejects an invalid forecast without guessing its day', value => {
    const payload = fixture(); payload.data.deliveryForecast = value;
    fail(payload, 'schema');
  });

  it('deduplicates equal instants and keeps distinct equal-time wordings in source order', () => {
    const value = fixture();
    value.data.volumes[0]!.events = [
      { date: '2026-11-01T12:00:00Z', description: 'Encomenda Conferida' },
      { date: '2026-11-01T12:00:00.000Z', description: 'Encomenda Conferida' },
      { date: '2026-11-01T12:00:00.100Z', description: 'Novidade A' },
      { date: '2026-11-01T12:00:00.1Z', description: 'Novidade B' },
    ];
    const result = parseFmTransportes(value, NUMBER);
    expect(result.events!.map(event => [event.time, event.description])).toEqual([
      ['2026-11-01T12:00:00.100Z', 'Novidade A'], ['2026-11-01T12:00:00.1Z', 'Novidade B'],
      ['2026-11-01T12:00:00Z', 'Encomenda Conferida'],
    ]);
    expect(result.events!.slice(0, 2).every(event => event.stage === undefined)).toBe(true);
  });

  it('preserves unknown wording without assigning a default progress stage', () => {
    const value = fixture(); value.data.volumes[0]!.events = [{ date: '2026-11-01T12:00:00Z', description: 'Nova formulação' }];
    const result = parseFmTransportes(value, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Nova formulação' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]!.stage).toBeUndefined();
  });

  it('accepts an optional scan location while ignoring the recipient city', () => {
    const value = fixture(); rows(value)[0]!.location = '  Example sorting hub  ';
    expect(parseFmTransportes(value, NUMBER).events!.at(-1)).toMatchObject({ location: 'Example sorting hub' });
    rows(value)[0]!.location = { city: 'Example' }; fail(value, 'schema');
  });

  it('rejects malformed wording and bounded-history overflow', () => {
    for (const description of ['', {}, null]) {
      const value = fixture(); rows(value)[0]!.description = description; fail(value, 'schema');
    }
    const value = fixture(); value.data.volumes[0]!.events = Array(501).fill(rows(value)[0]); fail(value, 'schema');
  });

  it.each(statuses.entries)('maps only the recorded wording: $wording', entry => {
    expect(fmTransportesMappedStage(entry.wording)).toBe(entry.stage);
    expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    expect(statusMap.stage('synthetic-code', entry.wording)).toBeUndefined();
  });

  it('keeps preparation in transit and gives a delivery round its separate stage', () => {
    expect(fmTransportesStage('Em Rota | Preparando para entrega')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(fmTransportesStage('Processo de Entrega Iniciado')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(fmTransportesStage('Outra novidade')).toBeNull();
    expect(statusMap.gaps).toEqual([]);
  });
});

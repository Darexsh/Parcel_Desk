import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeGofoSpainNumber, parseGofoSpain } from '../gofo-es/parser.js';
import { gofoSpainStage } from '../gofo-es/status.js';
import { normalizeGofoItalyNumber, parseGofoItaly } from '../gofo-it/parser.js';
import { gofoItalyStage } from '../gofo-it/status.js';
import { normalizeGofoNetherlandsNumber, parseGofoNetherlands } from '../gofo-nl/parser.js';
import { gofoNetherlandsStage } from '../gofo-nl/status.js';
import { gofoPlace, normalizeGofoFranceNumber, parseGofoFrance, regionalGofoRequestNumber } from './parser.js';
import { gofoFranceStage } from './status.js';

const cases = [
  { region: 'fr', number: 'GFFR00000000000001', parse: parseGofoFrance, normalize: normalizeGofoFranceNumber, stage: gofoFranceStage, delivery: 'Livré', count: 7 },
  { region: 'it', number: 'GFIT00000000000001', parse: parseGofoItaly, normalize: normalizeGofoItalyNumber, stage: gofoItalyStage, delivery: 'Consegnato', count: 10 },
  { region: 'nl', number: 'GFNL00000000000001', parse: parseGofoNetherlands, normalize: normalizeGofoNetherlandsNumber, stage: gofoNetherlandsStage, delivery: 'Bezorgd', count: 9 },
  { region: 'es', number: 'GFES00000000000001', parse: parseGofoSpain, normalize: normalizeGofoSpainNumber, stage: gofoSpainStage, delivery: 'Entregado', count: 10 },
];
const fixture = (region: string) => JSON.parse(readFileSync(new URL(`../gofo-${region}/fixtures/delivered.json`, import.meta.url), 'utf8'));
const item = (value: ReturnType<typeof fixture>) => value.data[0];
const bind = (value: ReturnType<typeof fixture>) => { item(value).lastTrackEvent = { ...item(value).trackEventList[0] }; item(value).trackEventCount = item(value).trackEventList.length; };

describe.each(cases)('GOFO $region identity and history', ({ region, number, parse, normalize, stage, delivery, count }) => {
  it('binds the whole national parcel and keeps explicit instants, service and code evidence', () => {
    const result = normalizeCarrierResult(parse(fixture(region), number));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      destination_country: region.toUpperCase(), canonical_tracking_number: number, service_name: 'GOFO Parcel',
      expected_delivery: null, delivered_at: region === 'fr' ? '2026-01-04T12:00:00+01:00' : '2026-01-05T12:00:00+01:00' });
    expect(result.events).toHaveLength(count);
    expect(result.events?.[0]).toMatchObject({ description: delivery, provider_code: '205', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|weight|proof|pin|civico|deurnummer|puerta|reference/i);
  });

  it('accepts only the complete official national families', () => {
    for (const prefix of ['GF', 'CI']) for (const digits of [13, 14]) {
      const candidate = prefix + region.toUpperCase() + '0'.repeat(digits - 1) + '1';
      expect(normalize(candidate.toLowerCase())).toBe(candidate);
    }
    for (const candidate of ['GFUS00000000000001', region === 'nl' ? 'GFIT00000000000001' : 'GFNL00000000000001', region === 'es' ? 'GFFR00000000000001' : 'GFES00000000000001', `${number}0`, number.slice(0, -2), `${number}&other=1`]) {
      expect(() => normalize(candidate)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('rejects a wrong or ambiguous identity, malformed scalar and different national destination', () => {
    for (const [field, value] of [['waybillNo', number.slice(0, -1) + '2'], ['trackingNumber', 'GFUS00000000000001'],
      ['waybillNo', { value: number }], ['trackingNumber', [number]], ['toCountry', region === 'fr' ? 'IT' : 'FR'], ['toCountry', null]]) {
      const wrong = fixture(region); item(wrong)[String(field)] = value;
      expect(() => parse(wrong, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const duplicate = fixture(region); duplicate.data.push(item(duplicate));
    expect(() => parse(duplicate, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const unbound = fixture(region); item(unbound).trackEventList[1].waybillNo = number.slice(0, -1) + '2';
    expect(() => parse(unbound, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const otherReference = fixture(region); item(otherReference).trackEventList[1].trackingNumber = 'ORDER-2';
    expect(() => parse(otherReference, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds a record by its waybill when the shipper reference is missing or free text', () => {
    for (const value of [null, undefined, '', ' ', 'Order #A_1/2', 'SAMPLE ORDER', `${'X'.repeat(60)}1`]) {
      const reply = fixture(region); item(reply).trackingNumber = value;
      expect(parse(reply, number).canonical_tracking_number).toBe(number);
      expect(JSON.stringify(parse(reply, number))).not.toMatch(/order|sample|XXXX/i);
    }
  });

  it('answers an empty list or scan list as no history, and keeps unsuccessful replies inconclusive and malformed envelopes distinct', () => {
    expect(() => parse({ code: 200, data: [] }, number)).toThrow(NoHistoryError);
    for (const payload of [{ code: 500, data: [] }, { code: '200', data: [] }]) {
      expect(() => parse(payload, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
      expect(() => parse(payload, number)).not.toThrow(NoHistoryError);
    }
    for (const payload of [null, {}, { code: 200, data: {} }, { code: 200, data: [null] }]) {
      expect(() => parse(payload, number)).toThrow();
    }
    const empty = fixture(region); item(empty).trackEventList = [];
    expect(() => parse(empty, number)).toThrow(NoHistoryError);
  });

  it('checks the current summary and declares a counter-limited history partial', () => {
    for (const field of ['processCode', 'processDate', 'mainContent', 'processContent', 'processLocation']) {
      const mismatch = fixture(region); item(mismatch).lastTrackEvent[field] = 'Different';
      expect(() => parse(mismatch, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const partial = fixture(region); item(partial).trackEventCount++;
    expect(parse(partial, number).history_truncated).toBe(true);
    const contradictory = fixture(region); item(contradictory).trackEventCount--;
    expect(() => parse(contradictory, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const excessive = fixture(region); item(excessive).trackEventList = Array(501).fill(item(excessive).trackEventList[0]); bind(excessive);
    expect(() => parse(excessive, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps local, missing and unparseable clocks unresolved instead of borrowing a delivery instant', () => {
    const local = fixture(region); item(local).trackEventList[0].processDate = '2026-01-05T12:00:00.000'; bind(local);
    const result = parse(local, number);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-05T12:00:00' });
    expect(result).not.toHaveProperty('delivered_at'); expect(result.events?.[0]).not.toHaveProperty('time');
    for (const { date, expected } of [{ date: null, expected: {} }, { date: 'Jan 5', expected: { provider_time_text: 'Jan 5' } }]) {
      const unresolved = fixture(region); item(unresolved).trackEventList[0].processDate = date; bind(unresolved);
      expect(parse(unresolved, number).events?.[0]).toMatchObject(expected);
      expect(parse(unresolved, number).last_update).toBeNull();
    }
  });

  it.each(['2026-02-30T12:00:00Z', '2026-01-05T24:00:00Z', '2026-01-05T12:00:00+99:00', '2026-01-05T12:00:00+02:99', '2026-01-05T12:00:00+14:01'])('rejects impossible or malformed explicit clock %s', processDate => {
    const value = fixture(region); item(value).trackEventList[0].processDate = processDate; bind(value);
    expect(() => parse(value, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('preserves equal and unresolved scan order, unknown operations and bounded completeness', () => {
    const value = fixture(region);
    item(value).trackEventList.unshift({ ...item(value).trackEventList[0], processCode: '999', mainContent: 'Awaiting review' }); bind(value);
    expect(parse(value, number)).toMatchObject({ status: 'unknown', last_status_text: 'Awaiting review' });
    expect(parse(value, number).events?.[1]?.description).toBe(delivery);
    item(value).trackEventList.push(item(value).trackEventList[0]); bind(value);
    expect(parse(value, number).events).toHaveLength(count + 1);
    for (let i = 0; i < 105; i++) item(value).trackEventList.push({ ...item(value).trackEventList[0], processLocation: `Example ${i}` }); bind(value);
    expect(parse(value, number)).toMatchObject({ history_truncated: true }); expect(parse(value, number).events).toHaveLength(100);
  });

  it('maps observed milestones and reserves returns for the actual return category', () => {
    const catalogue = JSON.parse(readFileSync(new URL(`../gofo-${region}/statuses.json`, import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage: string }[] };
    for (const entry of catalogue.entries) expect(stage(entry.code, entry.wording)).toBe(entry.stage);
    expect(stage('203', 'Preparing')).toBe('in_transit'); expect(stage('204', 'Returned to sorting centre')).toBe('exception');
    expect(stage('206', { fr: 'Alerte', it: 'Avviso', nl: 'Waarschuwing', es: 'Alerta' }[region]!)).toBe('exception');
    if (region !== 'nl') expect(parse(fixture(region), number).events?.find(event => event.provider_code === '206')?.stage).toBe('failed_attempt');
    expect(stage('257', 'Returned')).toBe('returned'); expect(stage('__proto__', 'Unknown')).toBeUndefined();
    expect(stage('205', 'Not delivered')).toBeUndefined();
    const contradictory = fixture(region); item(contradictory).trackEventList[0].mainContent = 'Not delivered'; bind(contradictory);
    expect(() => parse(contradictory, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});

it("leaves no place for a GOFO hub's code or the country alone, and keeps a French town written alike", () => {
  const placeOf = (region: 'fr' | 'it', written: string) => {
    const reply = fixture(region); item(reply).trackEventList[0].processLocation = written; bind(reply);
    return region === 'it' ? parseGofoItaly(reply, 'GFIT00000000000001').events?.[0]?.location
      : parseGofoFrance(reply, 'GFFR00000000000001').events?.[0]?.location;
  };
  for (const hub of ['FI-ARS', 'GOFO-NA']) expect(placeOf('it', hub)).toBeUndefined();
  for (const hub of ['75-LED', 'FR']) expect(placeOf('fr', hub)).toBeUndefined();
  for (const hub of ['GOFO-MD', 'ES']) expect(gofoPlace(hub, 'ES')).toBe('');
  expect(gofoPlace('Madrid,Madrid', 'ES')).toBe('Madrid,Madrid');
  expect(placeOf('fr', 'ST-LO')).toBe('St-Lo');
});

it('writes a French town given in capitals in the case its other scans use', () => {
  for (const [written, place] of [['MARSEILLE', 'Marseille'], ['SAINT-MICHEL-SUR-ORGE', 'Saint-Michel-sur-Orge'],
    ["L'ISLE-D'ABEAU", "L'Isle-d'Abeau"], ['LA SEYNE-SUR-MER,VAR', 'La Seyne-sur-Mer,Var'], ['La seyne-sur-mer', 'La seyne-sur-mer']]) {
    expect(gofoPlace(written!, 'FR')).toBe(place);
  }
  expect(gofoPlace('MILANO', 'IT')).toBe('MILANO');
});

it('reconstructs the French shipper reference and binds it to the national waybill in the same reply', () => {
  const raw = 'PK-0000000000000000001-0', number = normalizeGofoFranceNumber(raw);
  expect(regionalGofoRequestNumber(number)).toBe(raw);
  expect(parseGofoFrance(fixture('fr'), number).canonical_tracking_number).toBe('GFFR00000000000001');
  expect(() => normalizeGofoItalyNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  const wrong = fixture('fr'); item(wrong).trackingNumber = raw.slice(0, -1) + '1';
  expect(() => parseGofoFrance(wrong, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  const missing = fixture('fr'); item(missing).trackingNumber = null;
  expect(() => parseGofoFrance(missing, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers } from '../catalog/recognition.js';
import { isPhoneNumber, isValidDhlExpressWaybill } from './index.js';

const carriers = new URL('../../carriers/', import.meta.url);

describe('phone numbers', () => {
  it('reads a Paraguayan mobile number as dialled at home', () => {
    for (const number of ['0981000001', '0971 000 002', '0991-000-003', '0961000004', '0986000006'])
      expect(isPhoneNumber(number, 'PY'), number).toBe(true);
    expect(isPhoneNumber('0981000001', ' py ')).toBe(true);
  });

  it('needs the reader country', () => {
    for (const country of [undefined, null, '', 'AR', 'BR', 'PRY'])
      expect(isPhoneNumber('0981000001', country), String(country)).toBe(false);
  });

  it('leaves other ranges, lengths and letters alone', () => {
    for (const number of ['0960000001', '0987000001', '0990000001', '0981 00000', '09810000011', '981000001', 'A981000001', '+595981000001'])
      expect(isPhoneNumber(number, 'PY'), number).toBe(false);
  });

  it('leaves a number with a passing DHL Express check digit to DHL Express', () => {
    // 98100000 is 5 modulo 7.
    expect(isValidDhlExpressWaybill('0981000005')).toBe(true);
    expect(isPhoneNumber('0981000005', 'PY')).toBe(false);
  });

  it('asks no carrier about a phone number of the caller country', () => {
    expect(recognitionAskedCarriers('0981000001', { countryHint: 'PY' })).toEqual([]);
    expect(recognitionAskedCarriers('0981000001')).not.toEqual([]);
  });

  it('matches no shipment number a carrier was seen to issue, in any country', () => {
    const issued = readdirSync(carriers).flatMap((id) => {
      try {
        const { records } = JSON.parse(readFileSync(new URL(`${id}/numbers.json`, carriers), 'utf8')) as
          { records: { number: string; evidence: string }[] };
        return records.filter(({ evidence }) => evidence === 'public_shipment_report' || evidence === 'merchant_published_example');
      } catch { return []; }
    });
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const countries = [...letters].flatMap((first) => [...letters].map((second) => first + second));
    expect(issued.length).toBeGreaterThan(1_000);
    expect(issued.filter(({ number }) => countries.some((country) => isPhoneNumber(number, country)))
      .map(({ number }) => number)).toEqual([]);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPlaceholderNumber } from './index.js';

const carriers = new URL('../../carriers/', import.meta.url);

describe('placeholder numbers', () => {
  it('reads repeated digits and straight runs as placeholders', () => {
    for (const number of [
      '000000', '0000000000', '99999999999999', 'AAA0000000000', 'TBA000000000000', '000000000000000000000000ZR',
      '123456', '1234567890', '12345678901234', '0123456789', '23456789', '987654321', '9876543210987', 'ASL1234567890',
      // An S10 item by its serial: zeros or the UPU's example, with the check digit or a wrong one.
      'RR123456785CN', 'EB000000005CN', 'ML000000001MH', 'cio 0000000 5nl', '1234 5678 90',
      // A run of nine or more with one digit after it, as a check digit would be.
      '2345678903', '98765432102', 'ASL0123456789017', '3456 7890 15',
      // An example number that says so, as an app's demo parcel does.
      '123EXAMPLE', 'example-0001', '12 EXAMPLE 34',
    ]) expect(isPlaceholderNumber(number), number).toBe(true);
  });

  it('leaves issued-looking numbers, short ones and letters inside the digits alone', () => {
    for (const number of [
      '00000', '12345', '0000000001', '123456780', '2345678013', '23456789124', '100000000', 'TH0101000000A',
      'JJD000000000000000000001', '1Z0000000000000000', 'A1B2C3D4E5', 'EB000000014CN', 'RR123456799GB', 'TESTA1', 'EXAMPL123', '1MEXAMPLE0012345678', '',
    ]) expect(isPlaceholderNumber(number), number).toBe(false);
  });

  it('matches no shipment number a carrier was seen to issue', () => {
    const issued = readdirSync(carriers).flatMap((id) => {
      try {
        const { records } = JSON.parse(readFileSync(new URL(`${id}/numbers.json`, carriers), 'utf8')) as
          { records: { number: string; evidence: string }[] };
        return records.filter(({ evidence }) => evidence === 'public_shipment_report' || evidence === 'merchant_published_example');
      } catch { return []; }
    });
    expect(issued.length).toBeGreaterThan(1_000);
    expect(issued.filter(({ number }) => isPlaceholderNumber(number)).map(({ number }) => number)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { returnedTrackingNumber } from './returned.js';

describe('complete provider identifiers', () => {
  it('normalizes formatting without hiding any part of a returned identifier', () => {
    expect(returnedTrackingNumber(' aa.123-456 ')).toBe('AA123456');
    expect(returnedTrackingNumber('(00) 300000000000000018')).toBe('00300000000000000018');
    expect(returnedTrackingNumber('AA123456' + '-'.repeat(128) + 'BB999999')).toBe('AA123456BB999999');
    expect(returnedTrackingNumber('AA123456' + ' '.repeat(4096))).toBe('');
  });

  it('accepts numeric identifiers only for protocols that supply exact integers', () => {
    expect(returnedTrackingNumber(12345678)).toBe('');
    expect(returnedTrackingNumber(12345678, true)).toBe('12345678');
    for (const value of [12345.6, -123456, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, {}, [], null]) {
      expect(returnedTrackingNumber(value, true)).toBe('');
    }
  });
});

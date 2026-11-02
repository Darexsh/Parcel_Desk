import { describe, expect, it } from 'vitest';
import { carrierRequirements, requirementSatisfied } from './index.js';
import { normalizeCarrierInputs, normalizeDeliveryPostcode } from './inputs.js';
describe('universal recipient postcode', () => {
  it.each(['8000', '75001', 'SW1A 1AA', 'M5V 3L9', '1000-001'])('retains country-specific separators: %s', (postcode) => {
    expect(normalizeDeliveryPostcode(postcode.toLowerCase())).toBe(postcode);
  });
  it.each(['', 'ABC', '<script>123', '12', '1'.repeat(13), '123/456'])('rejects an invalid value', (postcode) => {
    expect(() => normalizeDeliveryPostcode(postcode)).toThrow(TypeError);
  });
});

describe('DPD postcode', () => {
  it('stays optional', () => {
    expect(normalizeCarrierInputs('dpd', '06080000000001', '', '')).toEqual({ trackingUrl: null, postcode: null });
  });
  it.each([
    ['8000', '8000'], [' 75001 ', '75001'], ['sw1a  1aa', 'SW1A 1AA'], ['1012 ab', '1012 AB'], ['00-001', '00-001'],
  ])('takes the postcode of any country DPD delivers in: %s', (typed, stored) => {
    expect(normalizeCarrierInputs('dpd', '06080000000001', '', typed)).toEqual({ trackingUrl: null, postcode: stored });
  });
  it.each(['12', 'ABCDE', '1'.repeat(13), '75001/2', '75 - 001'])('rejects what no country writes: %s', (postcode) => {
    expect(() => normalizeCarrierInputs('dpd', '06080000000001', '', postcode)).toThrow('DPD Switzerland requires a valid delivery postcode');
  });
  it('asks the form for the same shape', () => {
    const [requirement] = carrierRequirements('dpd', '06080000000001');
    for (const value of ['8000', '75001', 'SW1A 1AA', 'sw1a 1aa', '1000-001']) expect(requirementSatisfied(requirement!, value)).toBe(true);
    for (const value of ['12', 'ABCDE', '1'.repeat(13), '75001/2']) expect(requirementSatisfied(requirement!, value)).toBe(false);
    // Browsers compile the field's pattern with the `v` flag.
    expect(() => new RegExp(requirement!.pattern!, 'v')).not.toThrow();
  });
});

describe('DPD Germany postcode', () => {
  it('keeps the postcode optional and retains leading zeroes when supplied', () => {
    expect(normalizeCarrierInputs('dpd-de', '01000000000001', '', '')).toEqual({ trackingUrl: null, postcode: null });
    expect(normalizeCarrierInputs('dpd-de', '01000000000001', '', ' 01001 ')).toEqual({ trackingUrl: null, postcode: '01001' });
  });
  it.each(['8000', '123456', 'ABCDE'])('rejects an invalid German postcode: %s', postcode => {
    expect(() => normalizeCarrierInputs('dpd-de', '01000000000001', '', postcode)).toThrow('five-digit delivery postcode');
  });
});

describe.each([
  ['mondial-relay', 'Mondial Relay', '12345678'],
  ['gls-de', 'GLS Germany', '123456789018'],
] as const)('%s postcode', (carrier, name, number) => {
  it('stays required', () => {
    expect(() => normalizeCarrierInputs(carrier, number, '', '')).toThrow(`${name} requires the delivery postcode`);
  });
  it.each([
    ['75001', '75001'], ['1000', '1000'], [' 1012 ab ', '1012 AB'], ['1000-001', '1000-001'], ['L-1234', 'L-1234'],
  ])('takes the postcode of any country it delivers in: %s', (typed, stored) => {
    expect(normalizeCarrierInputs(carrier, number, '', typed)).toEqual({ trackingUrl: null, postcode: stored });
  });
  it.each(['12', 'ABCDE', '1'.repeat(13), '75001/2'])('rejects what no country writes: %s', (postcode) => {
    expect(() => normalizeCarrierInputs(carrier, number, '', postcode)).toThrow(`${name} requires a valid delivery postcode`);
  });
  it('asks the form for the same shape, with no example of its own', () => {
    const [requirement] = carrierRequirements(carrier, number);
    expect(requirement).toMatchObject({ validator: 'internationalPostcode', maxLength: 12, inputMode: 'text' });
    expect(requirement!.placeholder).toBeUndefined();
    for (const value of ['1000', '75001', '1012 AB', '1000-001']) expect(requirementSatisfied(requirement!, value)).toBe(true);
    for (const value of ['12', 'ABCDE', '75001/2']) expect(requirementSatisfied(requirement!, value)).toBe(false);
  });
});

describe('Mondial Relay numbers that need no postcode', () => {
  it.each(['1212345678', '121234567801'])('asks no postcode for the brand form %s, and keeps one an older client sends', (number) => {
    expect(carrierRequirements('mondial-relay', number)).toEqual([]);
    expect(normalizeCarrierInputs('mondial-relay', number, '', '')).toEqual({ trackingUrl: null, postcode: null });
    expect(normalizeCarrierInputs('mondial-relay', number, '', '1012 ab')).toEqual({ trackingUrl: null, postcode: '1012 AB' });
    expect(() => normalizeCarrierInputs('mondial-relay', number, '', '12')).toThrow('requires a valid delivery postcode');
  });
});

describe('Colis Privé postcode', () => {
  it('asks for it only beside a bare 12-character number', () => {
    expect(carrierRequirements('colis-prive', '991122334455')).toMatchObject([{ field: 'postcode', validator: 'colisPrivePostcode' }]);
    expect(() => normalizeCarrierInputs('colis-prive', '991122334455', '', '')).toThrow('Colis Privé requires the delivery postcode');
    for (const number of ['99112233445575012', '991122334455B1000', '9911223344551000']) {
      expect(carrierRequirements('colis-prive', number)).toEqual([]);
      expect(normalizeCarrierInputs('colis-prive', number, '', '')).toEqual({ trackingUrl: null, postcode: null });
      expect(() => normalizeCarrierInputs('colis-prive', number, '', '75012')).toThrow('not used');
    }
  });
  it.each([
    ['75012', '75012'], [' 75 012 ', '75012'], ['1000', '1000'], ['b1000', 'B1000'], ['B-1000', 'B1000'], ['be 1000', 'B1000'],
    ['L-1234', 'L1234'], ['lu1234', 'L1234'],
  ])('takes a French, Belgian or Luxembourg postcode: %s', (typed, stored) => {
    expect(normalizeCarrierInputs('colis-prive', '991122334455', '', typed)).toEqual({ trackingUrl: null, postcode: stored });
  });
  it.each(['96000', '0999', '123', '750012', 'D1000', 'BL1000', 'SW1A 1AA'])('rejects what those countries do not write: %s', (postcode) => {
    expect(() => normalizeCarrierInputs('colis-prive', '991122334455', '', postcode))
      .toThrow('Colis Privé requires a French, Belgian or Luxembourg delivery postcode');
  });
  it('asks the form for the same shape', () => {
    const [requirement] = carrierRequirements('colis-prive', '991122334455');
    for (const value of ['75012', '1000', 'B1000', 'b-1000', 'BE 1000', 'L-1234', 'LU1234']) expect(requirementSatisfied(requirement!, value)).toBe(true);
    for (const value of ['123', '750012', '00000', '96000', '99999', '0999', 'D1000', 'BL1000', 'SW1A 1AA']) {
      expect(requirementSatisfied(requirement!, value)).toBe(false);
    }
    expect(() => new RegExp(requirement!.pattern!, 'v')).not.toThrow();
  });
});

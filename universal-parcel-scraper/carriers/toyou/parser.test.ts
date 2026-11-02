import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeToyouNumber, parseToyou } from './parser.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/return.json', import.meta.url), 'utf8'));
const NUMBER = fixture().payload[0].parcelId as string;
function absent(number = NUMBER) {
  return { status: 'FAIL', payload: null, errors: [{ code: '102', category: 'REQUEST', description: 'No content found for given input',
    errorIdentifiers: { entry: [{ key: 'fields', value: { parcelID: number } }] } }] };
}

describe('toyou public customer history', () => {
  it('keeps complete local clocks, drops the rail and does not finish a return at dispatch', () => {
    const result = parseToyou(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null,
      last_update_local: '2024-09-06T19:49:03', events: { length: 6 } });
    expect(result.events![0]).toEqual({ local_time: '2024-09-06T19:49:03', description: 'Your returned parcel has been despatched to your retailer', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)!.stage).toBe('accepted');
    expect(result.events!.every(event => event.time === undefined && !event.description!.includes('Future'))).toBe(true);
    expect(result.expected_delivery).toBeNull();
    for (const excluded of ['SYNTHETIC-CAPABILITY', 'Fixture Recipient', 'Synthetic address', 'recipient@example.invalid', 'Discarded fixture detail', 'MASKED-SYNTHETIC-ORDER']) {
      expect(JSON.stringify(result)).not.toContain(excluded);
    }
  });

  it('normalizes the whole response identifier without truncating its suffix', () => {
    const data = fixture(); data.payload[0].parcelId = NUMBER.toLowerCase();
    expect(parseToyou(data, NUMBER).events).toHaveLength(6);
    data.payload[0].parcelId = NUMBER + 'OTHER';
    expect(() => parseToyou(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts only the explicit negative bound to the whole requested id', () => {
    expect(() => parseToyou(absent(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseToyou(absent(NUMBER + 'OTHER'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const data = absent(); data.errors[0]!.errorIdentifiers.entry = [];
    expect(() => parseToyou(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([{ payload: null }, { payload: [] }, { payload: undefined }])('leaves an empty success inconclusive', ({ payload }) => {
    const data = fixture(); data.payload = payload;
    expect(() => parseToyou(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses to combine several orders into one completion', () => {
    const data = fixture(); data.payload.push(structuredClone(data.payload[0]));
    expect(() => parseToyou(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([null, {}, 'changed', { status: 'OK', errors: {} }, { status: 'OK', errors: ['contradiction'], payload: [] }])('rejects malformed tracking envelopes', data => {
    expect(() => parseToyou(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['Feb 30, 2024, 4:40:02 PM', 'Sep 4, 2024, 13:40:02 PM', 'Sep 4, 2024, 4:60:02 PM', 'Sep 4, 24, 4:40:02 PM', 'Sep 4, 2024, 4:40:02 PM UTC', {}, null])('rejects invalid or changed clock representations', clock => {
    const data = fixture(); data.payload[0].customerDetails[0].dateAndTime = clock;
    expect(() => parseToyou(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('converts midnight and noon digits without attaching a zone', () => {
    const data = fixture(); data.payload[0].customerDetails = [{ message: 'Unknown event', dateAndTime: 'Feb 29, 2024, 12:00:00 AM' },
      { message: 'Another event', dateAndTime: 'Feb 29, 2024, 12:00:00 PM' }];
    const result = parseToyou(data, NUMBER);
    expect(result.events!.map(event => event.local_time)).toEqual(['2024-02-29T12:00:00', '2024-02-29T00:00:00']);
    expect(result.current_stage).toBeUndefined();
  });

  it('deduplicates exact scans and sorts the complete calendar, including New Year', () => {
    const data = fixture(); data.payload[0].customerDetails = [{ message: 'Earlier', dateAndTime: 'Dec 31, 2023, 11:59:00 PM' },
      { message: 'Later', dateAndTime: 'Jan 1, 2024, 12:01:00 AM' }, { message: 'Later', dateAndTime: 'Jan 1, 2024, 12:01:00 AM' }];
    expect(parseToyou(data, NUMBER).events!.map(event => event.description)).toEqual(['Later', 'Earlier']);
  });

  it.each([{ rows: [] }, { rows: Array(501).fill({}) }])('bounds event lists and keeps no history inconclusive', ({ rows }) => {
    const data = fixture(); data.payload[0].customerDetails = rows;
    expect(() => parseToyou(data, NUMBER)).toThrow(expect.objectContaining({ kind: rows.length ? 'schema' : 'indeterminate' }));
  });

  it.each([{}, null, { message: [], dateAndTime: 'Sep 4, 2024, 4:40:02 PM' }, { message: '', dateAndTime: 'Sep 4, 2024, 4:40:02 PM' }])('validates event wording before projection', row => {
    const data = fixture(); data.payload[0].customerDetails[0] = row;
    expect(() => parseToyou(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['short', 'A'.repeat(65), '<script>not-a-parcel</script>'])('rejects invalid parcel inputs', value => {
    expect(() => normalizeToyouNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

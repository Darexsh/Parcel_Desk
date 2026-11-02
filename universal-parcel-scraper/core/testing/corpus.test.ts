import { readFileSync } from 'node:fs';
import { Ajv, type SchemaObject } from 'ajv';
import { describe, expect, it } from 'vitest';
import { NUMBERS_SCHEMA_PATH, positiveRecords, type CorpusRecord } from './corpus.js';

const schema = JSON.parse(readFileSync(NUMBERS_SCHEMA_PATH, 'utf8')) as SchemaObject;
const validate = new Ajv({ allErrors: true }).compile(schema);
const synthetic: CorpusRecord = {
  carrier: 'ups', number: 'SYNTHETIC00001', role: 'shipment',
  evidence: 'synthetic', derivedFrom: 'invented',
  expect: { carrier: 'ups', confidence: 'high' },
};
const published = {
  number: 'SYNTHETIC00002', role: 'shipment', evidence: 'public_shipment_report',
  source: { url: 'https://example.org/public-report', date: '2026-01-01' },
  expect: { carrier: 'ups', confidence: 'high' },
};
const document = (record: unknown) => ({ carrier: 'ups', records: [record] });

describe('number evidence metadata', () => {
  it('keeps existing records valid without optional metadata', () => {
    const { carrier, ...record } = synthetic;
    expect(validate({ carrier, records: [record] })).toBe(true);
    expect(validate(document(published))).toBe(true);
  });

  it('lets a confirmed or candidate report act as an oracle without quarantine', () => {
    for (const assessment of ['confirmed', 'candidate']) {
      expect(validate(document({ ...published, context: { assessment } }))).toBe(true);
    }
  });

  it('accepts source access, date meaning and a separately cited relationship', () => {
    expect(validate(document({
      ...published,
      source: { ...published.source, access: 'indexed_excerpt', dateKind: 'comment publication' },
      context: { assessment: 'candidate', service: 'repair return', reportedRole: 'return_shipment' },
      relationships: [{ kind: 'return_of', number: synthetic.number,
        source: { url: 'https://example.org/carrier-reply', access: 'full_page' } }],
    }))).toBe(true);
  });

  it.each(['scope_review', 'review', 'quarantine', 'auxiliary'])(
    'requires quarantine for %s even when detection has high confidence', (assessment) => {
      const record = { ...published, context: { assessment } };
      expect(validate(document(record))).toBe(false);
      expect(validate(document({ ...record, quarantine: true }))).toBe(true);
    },
  );

  it('refuses a quarantine that does not say why', () => {
    expect(validate(document({ ...published, quarantine: true }))).toBe(false);
    expect(validate(document({ ...published, quarantine: true, context: { assessment: 'candidate' } }))).toBe(false);
    expect(validate(document({ ...published, quarantine: true, context: { assessment: 'review' } }))).toBe(true);
  });

  it('does not give an absent date a publication meaning', () => {
    expect(validate(document({ ...published,
      source: { url: published.source.url, dateKind: 'publication' },
    }))).toBe(false);
  });

  it('requires evidence for a relationship and rejects an unsupported relation', () => {
    expect(validate(document({ ...published,
      relationships: [{ kind: 'child_of', number: synthetic.number }],
    }))).toBe(false);
    expect(validate(document({ ...published,
      relationships: [{ kind: 'same_prefix', number: synthetic.number, source: published.source }],
    }))).toBe(false);
  });

  it('keeps high-confidence quarantined evidence out of positive oracles', () => {
    const held: CorpusRecord = { ...synthetic, number: 'SYNTHETIC00003', quarantine: true,
      context: { assessment: 'scope_review', service: 'another network' } };
    expect(positiveRecords([synthetic, held])).toEqual([synthetic]);
  });
});

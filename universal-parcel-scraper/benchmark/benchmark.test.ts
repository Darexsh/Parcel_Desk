// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Source { url: string; date?: string }
interface BenchmarkNumber { number: string; source?: Source; postcode?: string; review?: Record<string, string>; note?: string }
interface BenchmarkCarrier { carrier: string; name?: string; aliasOf?: string; group: string; numbers: BenchmarkNumber[] }

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, '..');
const { carriers } = JSON.parse(readFileSync(path.join(directory, 'carriers.json'), 'utf8')) as { carriers: BenchmarkCarrier[] };
const results = readFileSync(path.join(directory, 'results.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((line) => JSON.parse(line) as { carrier: string; number: string; source: string; outcome: string; checked: string; rows?: number });
const SOURCES = ['direct', 'Ship24', 'ParcelsApp', '17TRACK', 'Postal Ninja', 'UPU'];
const OUTCOMES = ['history', 'summary_only', 'no_history', 'undated', 'postcode_prompt', 'refused', 'blocked', 'error', 'no_adapter', 'n/a'];
const REVIEWS = ['wrong_carrier', 'refused', 'no_history'];
const inCatalog = (carrier: string) => existsSync(path.join(root, 'carriers', carrier, 'carrier.json'));
const corpus = (carrier: string) => (JSON.parse(readFileSync(path.join(root, 'carriers', carrier, 'numbers.json'), 'utf8')) as {
  records: Array<{ number: string; evidence: string; quarantine?: true }>;
}).records;

describe('carrier benchmark', () => {
  it('lists each carrier once, in a group, with public numbers', () => {
    const ids = carriers.map((entry) => entry.carrier);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of carriers) {
      expect(entry.group, entry.carrier).toBeTruthy();
      expect(entry.numbers.length, entry.carrier).toBeGreaterThan(0);
      expect(new Set(entry.numbers.map((item) => item.number)).size, entry.carrier).toBe(entry.numbers.length);
      for (const item of entry.numbers) {
        if (item.source) {
          expect(item.source.url, item.number).toMatch(/^https:\/\//);
          expect(item.source.date, item.number).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        } else {
          // Without its own source, a number is one of the carrier's public corpus records.
          expect(inCatalog(entry.carrier), entry.carrier).toBe(true);
          const record = corpus(entry.carrier).find((candidate) => candidate.number === item.number);
          expect(record, `${entry.carrier} ${item.number}`).toBeDefined();
          expect(record!.evidence, item.number).not.toBe('synthetic');
          expect(record!.quarantine, item.number).toBeUndefined();
        }
        for (const [source, review] of Object.entries(item.review ?? {})) {
          expect(SOURCES, item.number).toContain(source);
          expect(REVIEWS, item.number).toContain(review);
          expect(item.note, `${item.number} needs a note for its review`).toBeTruthy();
        }
      }
      if (!inCatalog(entry.carrier)) expect(entry.name, entry.carrier).toBeTruthy();
      if (entry.aliasOf) {
        // The catalog files this network's parcels under another carrier, by this name.
        expect(inCatalog(entry.carrier), entry.carrier).toBe(false);
        expect(inCatalog(entry.aliasOf), entry.aliasOf).toBe(true);
        const definition = JSON.parse(readFileSync(path.join(root, 'carriers', entry.aliasOf, 'carrier.json'), 'utf8')) as { aliases?: string[] };
        expect(definition.aliases, entry.carrier).toContain(entry.name);
      }
    }
    expect(carriers.filter((entry) => !inCatalog(entry.carrier) && !entry.aliasOf).length).toBeLessThanOrEqual(15);
  });

  it('keeps one answer per listed number and source', () => {
    const listed = new Set(carriers.flatMap((entry) => entry.numbers.map((item) => `${entry.carrier}|${item.number}`)));
    const keys = results.map((record) => `${record.carrier}|${record.number}|${record.source}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const record of results) {
      expect(listed.has(`${record.carrier}|${record.number}`), `${record.carrier} ${record.number}`).toBe(true);
      expect(SOURCES).toContain(record.source);
      expect(OUTCOMES, `${record.carrier} ${record.number} ${record.source}`).toContain(record.outcome);
      expect(record.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (record.outcome === 'history') expect(record.rows).toBeGreaterThan(0);
    }
  });
});

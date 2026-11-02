/**
 * The checksum vectors.
 *
 * What it does: rebuilds the vectors from the validators and compares them with
 * the committed `data/checksum-vectors.json`, which the Swift port replays.
 * A failure means a checksum or the generator changed: decide whether that
 * change was intended, then run `node scripts/checksum-vectors.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { CHECKSUMS } from '../detection/checksums.js';
import {
  buildChecksumVectors,
  readChecksumVectorsText,
  serializeChecksumVectors,
  writeChecksumVectors,
  type ChecksumVector,
} from './checksumVectors.js';

const STALE = 'data/checksum-vectors.json is stale: run node scripts/checksum-vectors.mjs';

describe('checksum vectors', () => {
  it('matches the committed data/checksum-vectors.json', () => {
    if (process.env.UPDATE_CHECKSUM_VECTORS) writeChecksumVectors();
    const built = buildChecksumVectors();
    const committed = readChecksumVectorsText();
    expect(JSON.parse(committed), STALE).toEqual(built);
    expect(committed, STALE).toBe(serializeChecksumVectors(built));
  });

  it('gives every checksum id both answers', () => {
    const { vectors } = JSON.parse(readChecksumVectorsText()) as { vectors: Record<string, ChecksumVector[]> };
    expect(Object.keys(vectors).sort()).toEqual(Object.keys(CHECKSUMS).sort());
    for (const [id, list] of Object.entries(vectors)) {
      expect(list.length, id).toBeGreaterThanOrEqual(20);
      expect(list.some(([, valid]) => valid), id).toBe(true);
      expect(list.some(([, valid]) => !valid), id).toBe(true);
      expect(new Set(list.map(([input]) => input)).size, id).toBe(list.length);
    }
  });

  it('draws the same vectors every time', () => {
    expect(serializeChecksumVectors(buildChecksumVectors())).toBe(serializeChecksumVectors(buildChecksumVectors()));
  });
});

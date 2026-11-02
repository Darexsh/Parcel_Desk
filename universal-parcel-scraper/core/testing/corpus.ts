/**
 * The tracking-number corpus.
 *
 * What it is: the loader for every `carriers/<id>/numbers.json`, the types that
 * mirror `numbers.schema.json`, and the helpers the detection sweep uses to walk
 * positives and negatives.
 * What it is not: no detection logic and no expectations of its own. A record's
 * `expect` is a characterization of what the engine answers today, so this file
 * only reads and validates it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type SchemaObject, type ValidateFunction } from 'ajv';

export type NumberRole =
  | 'shipment'
  | 'full_barcode'
  | 'order_reference'
  | 'composite'
  | 'negative'
  | 'quarantined';

export type NumberEvidence =
  | 'public_shipment_report'
  | 'official_documentation_example'
  | 'open_source_example'
  | 'merchant_published_example'
  | 'synthetic';

export type SyntheticOrigin =
  | 'donated_real'
  | 'observed_request'
  | 'official_shape'
  | 'invented';

export interface NumberSource {
  readonly url: string;
  readonly date?: string;
  /** How the cited observation was read; absent means unspecified. */
  readonly access?: 'full_page' | 'indexed_excerpt';
  /** What the source date refers to, such as a comment or carrier reply. */
  readonly dateKind?: string;
}

export interface NumberContext {
  /** Source-labelled service, without inferring it from the number's shape. */
  readonly service?: string;
  /** The source's description of the identifier, separate from its corpus role. */
  readonly reportedRole?: string;
  /**
   * Evidence assessment, independent of the detector's recorded answer.
   * `confirmed` means the carrier's own tracking knew the number.
   */
  readonly assessment: 'confirmed' | 'candidate' | 'scope_review' | 'review' | 'quarantine' | 'auxiliary';
}

export interface NumberRelationship {
  readonly kind: 'child_of' | 'return_of' | 'pickup_for';
  /** A published identifier in the same carrier corpus, never an inferred suffix. */
  readonly number: string;
  readonly source: NumberSource;
}

export type NumberExpectation =
  | { readonly carrier: string; readonly confidence: 'high' }
  | {
    readonly carrier: 'unknown';
    readonly confidence: 'low';
    readonly candidates: readonly string[];
    readonly not?: readonly string[];
  }
  | { readonly carrier: 'unknown'; readonly confidence: 'none'; readonly not?: readonly string[] };

export interface NumberRecord {
  /** Exactly as a user would type it: punctuation is kept where it carries meaning. */
  readonly number: string;
  readonly role: NumberRole;
  readonly evidence: NumberEvidence;
  /** Required for every published family, forbidden for `synthetic`. */
  readonly source?: NumberSource;
  /** Synthetic numbers only: how the number was made. */
  readonly derivedFrom?: SyntheticOrigin;
  readonly shapeConfirmed?: string;
  /** Never a positive oracle; the expectation only records today's answer. */
  readonly quarantine?: true;
  readonly context?: NumberContext;
  readonly relationships?: readonly NumberRelationship[];
  readonly expect: NumberExpectation;
  readonly note?: string;
}

export interface NumberCorpusFile {
  readonly carrier: string;
  readonly gap?: string;
  readonly records: readonly NumberRecord[];
}

/** A record together with the carrier folder it was read from. */
export interface CorpusRecord extends NumberRecord {
  readonly carrier: string;
}

const testingDirectory = path.dirname(fileURLToPath(import.meta.url));
export const CARRIERS_DIRECTORY = path.resolve(testingDirectory, '..', '..', 'carriers');
export const NUMBERS_SCHEMA_PATH = path.join(testingDirectory, 'numbers.schema.json');

function compileSchema(): ValidateFunction {
  const schema = JSON.parse(readFileSync(NUMBERS_SCHEMA_PATH, 'utf8')) as SchemaObject;
  return new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);
}

export function carrierFolders(): string[] {
  return readdirSync(CARRIERS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every `numbers.json`, validated, in folder order. */
export function loadNumberCorpusFiles(): NumberCorpusFile[] {
  const validate = compileSchema();
  return carrierFolders().map((folder) => {
    const file = path.join(CARRIERS_DIRECTORY, folder, 'numbers.json');
    const document: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!validate(document)) {
      const errors = (validate.errors ?? [])
        .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`.trim())
        .join('; ');
      throw new Error(`${folder}/numbers.json does not match numbers.schema.json: ${errors}`);
    }
    const corpus = document as NumberCorpusFile;
    if (corpus.carrier !== folder) {
      throw new Error(`${folder}/numbers.json declares carrier "${corpus.carrier}"`);
    }
    return corpus;
  });
}

/** Every record in the package, flattened and tagged with its folder id. */
export function loadNumberCorpus(): CorpusRecord[] {
  return loadNumberCorpusFiles().flatMap((corpus) => corpus.records
    .map((record) => ({ ...record, carrier: corpus.carrier })));
}

/** Records the engine resolves to exactly one carrier and that may act as an oracle. */
export function positiveRecords(records: readonly CorpusRecord[]): CorpusRecord[] {
  return records.filter((record) => record.expect.confidence === 'high' && record.quarantine !== true);
}

/** Records that must not resolve to a single carrier. */
export function negativeRecords(records: readonly CorpusRecord[]): CorpusRecord[] {
  return records.filter((record) => record.expect.confidence !== 'high');
}

/** Records held back from the oracles: wording, role or attribution is unconfirmed. */
export function quarantinedRecords(records: readonly CorpusRecord[]): CorpusRecord[] {
  return records.filter((record) => record.quarantine === true);
}

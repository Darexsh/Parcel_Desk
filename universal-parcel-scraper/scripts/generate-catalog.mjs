import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const carriersPath = path.join(root, 'carriers');
const carrierSchemaPath = path.join(root, 'core/catalog/carrier.schema.json');
async function readCarrierDocuments() {
  const entries = await readdir(carriersPath, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const documents = [];
  for (const folder of folders) {
    const file = path.join(carriersPath, folder, 'carrier.json');
    const source = await readFile(file, 'utf8').catch(() => null);
    if (source === null) {
      throw new Error(
        `carriers/${folder} has no carrier.json. `
        + 'Every carrier folder must define one; use npm run carrier:new to scaffold it.',
      );
    }
    let document;
    try {
      document = JSON.parse(source);
    } catch (cause) {
      throw new Error(`carriers/${folder}/carrier.json is not valid JSON: ${cause.message}`, { cause });
    }
    if (document.id !== folder) {
      throw new Error(
        `carriers/${folder}/carrier.json declares id ${JSON.stringify(document.id)}; `
        + 'the id must equal the folder name.',
      );
    }
    documents.push(document);
  }
  return documents;
}

/**
 * Folders that ship their own `adapter.ts`. An automatic carrier either runs a
 * universal provider or names one of these folders — its own, or the folder
 * whose adapter serves it (delivengo -> la-poste, quickpac -> planzer). There
 * is no free-text adapter name any more: a typo must fail the generator rather
 * than reach the registry.
 */
async function readAdapterFolders() {
  const entries = await readdir(carriersPath, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const withAdapter = new Set();
  for (const folder of folders) {
    const found = await access(path.join(carriersPath, folder, 'adapter.ts'))
      .then(() => true, () => false);
    if (found) withAdapter.add(folder);
  }
  return withAdapter;
}

const carrierInputValidators = {
  trackingUrl: new Set(['planzerSharedUrl', 'dachserCapabilityUrl', 'instaboxCapabilityUrl', 'freightwaysCapabilityUrl']),
  postcode: new Set([
    'swissPostcode',
    'francePostcode',
    'germanyPostcode',
    'swissOrFrancePostcode',
    'internationalPostcode',
    'paackPostcode',
    'colisPrivePostcode',
  ]),
};

/** Structural validation: the shape is owned by core/catalog/carrier.schema.json. */
async function validateCarrierSchema(documents) {
  const schema = JSON.parse(await readFile(carrierSchemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(schema);
  for (const carrier of documents) {
    if (!validate(carrier)) {
      const details = validate.errors
        .map((error) => `${error.instancePath || '/'} ${error.message}${error.params.allowedValues ? `: ${error.params.allowedValues.join(', ')}` : ''}`)
        .join('; ');
      throw new Error(`carriers/${carrier.id}/carrier.json is invalid: ${details}`);
    }
  }
}

/** Checks the schema cannot express: adapter/mode agreement, canary URLs, regexes. */
function validateCarrierSemantics(carrier, adapterFolders) {
  const where = `carriers/${carrier.id}/carrier.json`;
  const { tracking, portal } = carrier;
  if (
    (tracking.mode === 'automatic' && typeof tracking.adapter !== 'string')
    || (tracking.mode === 'link-only' && tracking.adapter !== null)
  ) {
    throw new Error(`${where} has an invalid tracking adapter`);
  }
  if (
    tracking.mode === 'automatic'
    && tracking.adapter !== 'universal'
    && !adapterFolders.has(tracking.adapter)
  ) {
    throw new Error(
      `${where} names tracking.adapter ${JSON.stringify(tracking.adapter)}, which is neither `
      + '"universal" nor a carrier folder containing adapter.ts.',
    );
  }
  if (tracking.mode === 'automatic') {
    let canaryUrl;
    try {
      canaryUrl = new URL(portal.canaryUrl);
    } catch {
      throw new Error(`${where} must define a valid portal.canaryUrl`);
    }
    if (
      canaryUrl.protocol !== 'https:'
      || canaryUrl.username
      || canaryUrl.password
      || canaryUrl.search
      || canaryUrl.hash
    ) {
      throw new Error(`${where} must define a public HTTPS portal.canaryUrl`);
    }
  }
  if (portal.searchUrl !== undefined) {
    let searchUrl;
    try {
      searchUrl = new URL(portal.searchUrl);
    } catch {
      throw new Error(`${where} must define a valid portal.searchUrl`);
    }
    if (searchUrl.username || searchUrl.password) {
      throw new Error(`${where} must define a credential-free portal.searchUrl`);
    }
  }
  const fields = new Set();
  for (const requirement of tracking.requirements ?? []) {
    const validators = carrierInputValidators[requirement.field];
    if (!validators || fields.has(requirement.field) || !validators.has(requirement.validator)) {
      throw new Error(`${where} has an invalid input requirement`);
    }
    fields.add(requirement.field);
    if (requirement.showsMore && !requirement.optional) throw new Error(`${where} shows more only with an optional input`);
    if (requirement.readsCountry && requirement.field !== 'postcode') throw new Error(`${where} reads a country only with a postcode`);
    if (requirement.whenTrackingNumber) new RegExp(requirement.whenTrackingNumber);
    if (requirement.pattern) new RegExp(requirement.pattern);
  }
  if (tracking.recognition?.pattern) new RegExp(tracking.recognition.pattern);
  for (const rule of carrier.detection) {
    new RegExp(rule.pattern);
    if (rule.rawPattern) new RegExp(rule.rawPattern);
    // Preference orders suggestions; a high-confidence rule already selects.
    if (rule.preferred !== undefined && (rule.preferred !== true || rule.confidence !== 'low')) {
      throw new Error(`${where} detection rule ${rule.id} may only prefer a low-confidence match`);
    }
  }
  for (const rule of carrier.links) {
    for (const field of ['query', 'path', 'pathPattern', 'fragment']) {
      if (rule[field] !== undefined) new RegExp(rule[field], 'i');
    }
  }
}

/** Detection rule ids are referenced by the sweep and the collision file. */
function validateDetectionRuleIds(documents) {
  const owners = new Map();
  for (const carrier of documents) {
    for (const rule of carrier.detection) {
      const owner = owners.get(rule.id);
      if (owner) {
        throw new Error(`Detection rule id ${rule.id} is used by both ${owner} and ${carrier.id}`);
      }
      owners.set(rule.id, carrier.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Folders -> x-carriers
// ---------------------------------------------------------------------------

function contractDetectionRule(rule) {
  // `id` stays out of the published contract, which keeps the old shape; DETECTION_RULE_IDS carries it.
  const contractRule = { pattern: rule.pattern, confidence: rule.confidence };
  if (rule.rawPattern !== undefined) contractRule.rawPattern = rule.rawPattern;
  if (rule.checksum !== undefined) contractRule.checksum = rule.checksum;
  if (rule.preferred !== undefined) contractRule.preferred = rule.preferred;
  return contractRule;
}

function contractTracking(tracking) {
  const contractValue = { mode: tracking.mode, adapter: tracking.adapter };
  if (tracking.upstreamName !== undefined) contractValue.upstreamName = tracking.upstreamName;
  if (tracking.requirements !== undefined) contractValue.requirements = tracking.requirements;
  // Clients predict which carriers the Add sheet's recognition asks.
  if (tracking.recognition !== undefined) contractValue.recognitionRank = tracking.recognition.rank;
  if (tracking.recognition?.pattern !== undefined) contractValue.recognitionPattern = tracking.recognition.pattern;
  if (tracking.recognition?.servedCountriesOnly) contractValue.recognitionServedCountriesOnly = true;
  if (tracking.browserRecognition !== undefined) contractValue.browserRecognitionRank = tracking.browserRecognition.rank;
  if (tracking.refresh !== undefined) contractValue.refresh = tracking.refresh;
  if (tracking.localClocks !== undefined) contractValue.localClocks = tracking.localClocks;
  // Consumers need not ask fallback providers for the clock of a scan dated by its day alone.
  if (tracking.dateOnlyScans !== undefined) contractValue.dateOnlyScans = tracking.dateOnlyScans;
  // Clients space out repeated lookups that can open a browser.
  if (tracking.browser !== undefined) contractValue.browser = tracking.browser;
  return contractValue;
}

/** Projects one carrier.json onto the published x-carriers entry shape. */
function contractEntry(carrier) {
  const entry = { displayName: carrier.displayName };
  if (carrier.displayNames !== undefined) entry.displayNames = carrier.displayNames;
  entry.color = carrier.brand.color;
  // The carrier pickers search other names and show and search countries.
  if (carrier.aliases.length) entry.aliases = carrier.aliases;
  if (carrier.region.countries.length) entry.countries = carrier.region.countries;
  entry.selectable = carrier.selectable;
  entry.timezone = carrier.timezone;
  entry.tracking = contractTracking(carrier.tracking);
  if (carrier.portal.canaryUrl !== undefined) entry.canaryUrl = carrier.portal.canaryUrl;
  if (carrier.portal.url !== undefined) entry.trackingUrlTemplate = carrier.portal.url;
  if (carrier.portal.searchUrl !== undefined) entry.trackingSearchUrl = carrier.portal.searchUrl;
  if (carrier.portal.siteName !== undefined) entry.trackingSiteName = carrier.portal.siteName;
  if (carrier.portal.helpUrl !== undefined) entry.helpUrl = carrier.portal.helpUrl;
  if (carrier.portal.hidesDestinationLeg !== undefined) entry.hidesDestinationLeg = carrier.portal.hidesDestinationLeg;
  entry.linkRules = carrier.links;
  entry.detectionRules = carrier.detection.map(contractDetectionRule);
  return entry;
}


const documents = await readCarrierDocuments();
await validateCarrierSchema(documents);
const adapters = await readAdapterFolders();
documents.forEach(document => validateCarrierSemantics(document, adapters));
validateDetectionRuleIds(documents);
const order = JSON.parse(await readFile(path.join(root, 'data/carrier-order.json'), 'utf8'));
const byId = new Map(documents.map(document => [document.id, document]));
const ids = [...order.filter(id => byId.has(id)), ...documents.map(document => document.id).filter(id => !order.includes(id))];
const catalog = Object.fromEntries(ids.map(id => [id, contractEntry(byId.get(id))]));
const ruleIds = ids.map(id => `  ${JSON.stringify(id)}: ${JSON.stringify(byId.get(id).detection.map(rule => rule.id))},`);
const stages = JSON.parse(await readFile(path.join(root, 'data/stages.json'), 'utf8'));
const generated = [
  '/* Generated by scripts/generate-catalog.mjs. Do not edit. */', '',
  `export const CARRIER_CATALOG = ${JSON.stringify(catalog, null, 2)} as const;`, '',
  `export const CARRIER_IDS = ${JSON.stringify(ids, null, 2)} as const;`,
  'export type CarrierId = (typeof CARRIER_IDS)[number];', '',
  '/** Each carrier\'s detection rule ids, in the order of its `detectionRules`. */',
  'export const DETECTION_RULE_IDS: Readonly<Record<CarrierId, readonly string[]>> = {', ...ruleIds, '};', '',
  `export const STAGES = ${JSON.stringify(stages, null, 2)} as const;`,
  'export type Stage = (typeof STAGES)[number];', '',
].join('\n');
const outputs = { 'data/catalog.json': JSON.stringify(catalog, null, 2)+'\n', 'data/carrier.schema.json': await readFile(carrierSchemaPath, 'utf8'), 'generated/catalog.ts': generated };
for (const [relative, content] of Object.entries(outputs)) {
  const file = path.join(root, relative);
  if (process.argv.includes('--check')) {
    if (await readFile(file, 'utf8').catch(() => '') !== content) throw new Error(`${relative} is stale; run npm run generate`);
  } else { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
}
console.log(`Catalog: ${ids.length} carriers.`);

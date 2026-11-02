import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// Reads a private JSONL corpus. Its output retains no number, prefix or country.
const MIN_COHORT = 20;
const MIN_CARRIER = 5;

/** Deduplicate direct confirmations and discard conflicting carrier labels. */
export function confirmedEvidence(records, api) {
  const byNumber = new Map();
  let rejected = 0;
  for (const record of records) {
    if (record?.confirmation !== 'direct' || typeof record.number !== 'string'
      || typeof record.carrier !== 'string' || !api.carrierIds.has(record.carrier)
      || record.carrier === 'unknown' || record.carrier === 'intl-post') {
      rejected++;
      continue;
    }
    const number = api.normalizeTrackingNumber(record.number);
    const shape = api.recognitionNumberShape(number);
    if (!shape) { rejected++; continue; }
    const previous = byNumber.get(number);
    if (previous) previous.carriers.add(record.carrier);
    else byNumber.set(number, { number, shape, carriers: new Set([record.carrier]) });
  }
  const rows = [];
  let conflicting = 0;
  for (const row of byNumber.values()) {
    if (row.carriers.size !== 1) { conflicting++; continue; }
    rows.push({ number: row.number, shape: row.shape, carrier: [...row.carriers][0] });
  }
  return { rows, rejected, conflicting };
}

/** Emit coarse priority counts only when enough independent evidence exists. */
export function buildPriorities(rows) {
  const groups = new Map();
  for (const { shape, carrier } of rows) {
    const group = groups.get(shape) ?? { total: 0, carriers: new Map() };
    group.total++;
    group.carriers.set(carrier, (group.carriers.get(carrier) ?? 0) + 1);
    groups.set(shape, group);
  }
  const cohorts = {};
  for (const [shape, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    if (group.total < MIN_COHORT) continue;
    const supported = [...group.carriers].filter(([, count]) => count >= MIN_CARRIER)
      .sort(([left], [right]) => left.localeCompare(right));
    if (supported.length) cohorts[shape] = Object.fromEntries(supported);
  }
  return { version: 1, cohorts };
}

function coverage(rows, api, model) {
  const counts = { total: rows.length, detectedCorrectly: 0, httpEligible: 0, httpTopFive: 0, httpTopTen: 0, browserEligible: 0, browserTopFive: 0, absent: 0 };
  for (const row of rows) {
    const detected = api.detectCarrierMatch(row.number);
    if (detected.carrier === row.carrier && detected.confidence === 'high') {
      counts.detectedCorrectly++;
      continue;
    }
    const options = { priorities: model?.cohorts[row.shape] };
    const http = api.recognitionCandidates(row.number, options).map(({ carrier }) => carrier);
    const browser = api.recognitionCandidates(row.number, { ...options, phase: 'browser' }).map(({ carrier }) => carrier);
    if (http.includes(row.carrier)) {
      counts.httpEligible++;
      if (http.slice(0, 5).includes(row.carrier)) counts.httpTopFive++;
      if (http.slice(0, 10).includes(row.carrier)) counts.httpTopTen++;
    }
    if (browser.includes(row.carrier)) {
      counts.browserEligible++;
      if (browser.slice(0, 5).includes(row.carrier)) counts.browserTopFive++;
    }
    if (!http.includes(row.carrier) && !browser.includes(row.carrier)) counts.absent++;
  }
  return counts;
}

export function analyzeRecognition(records, api) {
  const { rows, rejected, conflicting } = confirmedEvidence(records, api);
  // Stable split by identifier keeps repeated sightings out of both halves.
  const holdout = [], training = [];
  for (const row of rows) {
    const bucket = createHash('sha256').update(row.number).digest()[0] % 5;
    (bucket === 0 ? holdout : training).push(row);
  }
  const model = buildPriorities(rows);
  return {
    model,
    report: {
      independentConfirmations: rows.length, rejected, conflicting,
      cohortMinimum: MIN_COHORT, carrierMinimum: MIN_CARRIER,
      supportedCohorts: Object.keys(model.cohorts).length,
      baseline: coverage(rows, api),
      holdout: {
        training: training.length,
        baseline: coverage(holdout, api),
        ranked: coverage(holdout, api, buildPriorities(training)),
      },
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
  if (!values.input) throw new Error('Use --input <private JSONL file> and optional --output <private aggregate file>. Run npm run build first.');
  let records;
  try {
    records = readFileSync(values.input, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    throw new Error('Could not read the private corpus as JSONL.');
  }
  const api = await import('../dist/index.js');
  const { model, report } = analyzeRecognition(records, { ...api, carrierIds: new Set(api.CARRIER_IDS) });
  if (values.output) writeFileSync(values.output, `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Recognition analysis failed. Check input, arguments and built package.\n');
    process.exitCode = 1;
  });
}

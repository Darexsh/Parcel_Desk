import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBenchmark, renderBenchmark, summarize } from './benchmark-data.mjs';
import { coverageChart, stagesFigure, terminal } from './readme-graphics.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const documents = readdirSync(path.join(root, 'carriers'), { withFileTypes: true }).filter(entry => entry.isDirectory())
  .map(entry => read(`carriers/${entry.name}/carrier.json`));
const benchmark = loadBenchmark(root);
const measured = summarize(benchmark);
const sources = ['ParcelsApp','Postal Ninja','17TRACK','Ship24','UPU'];
const counts = Object.fromEntries(sources.map(source => [source, measured.providers[source]]));
const union = measured.combined;
const activeAdapters = documents.filter(document => document.tracking.mode === 'automatic' && document.tracking.adapter === document.id
  && existsSync(path.join(root,'carriers',document.id,'adapter.ts'))).length;
const countries = new Set(documents.flatMap(document => document.region.countries)).size;
const summary = { catalog: documents.length, activeAdapters, countries, referenceCarriers: benchmark.length,
  comparison: { combined: union, direct: measured.direct, providers: counts } };
const count = value => value.toLocaleString('en-US');
// The fallbacks reach what the largest aggregator says it follows.
const reach = Math.max(...Object.values(read('docs/reach.json')).map(provider => provider.carriers));
const rows = [
  { label: 'This project, all fallbacks enabled', count: union, own: true },
  { label: 'This project, dedicated adapters alone', count: summary.comparison.direct, own: true },
  ...sources.map(source => ({ label: source, count: counts[source], own: false })).sort((a, b) => b.count - a.count),
];
// Every status a carrier folder records, and one delivery round as six of them report it.
const statuses = documents.flatMap(document => existsSync(path.join(root,'carriers',document.id,'statuses.json'))
  ? read(`carriers/${document.id}/statuses.json`).entries.map(entry => ({ ...entry, carrier: document })) : []);
const stage = 'out_for_delivery';
const samples = [['dhl','Die Sendung wurde in das Zustellfahrzeug geladen.'], ['mondial-relay','En cours de livraison'],
  ['correios-br','Objeto saiu para entrega ao destinatário'], ['correos-express','EN REPARTO'], ['yamato','配達中'], ['la-poste','DISTOU']]
  .map(([carrier, label]) => {
    const entry = statuses.find(status => status.carrier.id === carrier && (status.wording ?? status.code) === label && status.stage === stage);
    if (!entry) throw new Error(`${carrier} no longer records "${label}" as ${stage}; pick another sample for the README`);
    return { carrier: entry.carrier.displayName, label, code: !entry.wording };
  });
// The terminal prints what detection answers for a number the corpus holds.
const sample = read('data/detection-golden.json').find(record => record.input === '1Z999AA10123456784');
if (sample?.confidence !== 'high') throw new Error('The README terminal needs a corpus number that detection names with high confidence');
const detected = JSON.stringify({ trackingNumber: sample.input, source: 'number', carrier: sample.carrier,
  confidence: sample.confidence, candidates: sample.candidates, preferred: [] }, null, 2).split('\n');
const picture = (name, alt) => `<img src="docs/assets/${name}.svg" alt="${alt}" width="760">`;
const best = Math.max(...Object.values(counts));
const undated = sources.filter(source => measured.undated[source] > 0);
const blocks = {
  summary: [
    `**${count(reach)}+ carriers** through **${activeAdapters} dedicated adapters** and **${sources.length} universal fallbacks**`,
    '', `<sub>${documents.length} catalog entries · ${countries} countries represented</sub>`,
  ].join('\n'),
  stages: [
    picture('stages', `${samples.map(entry => `${entry.carrier}: ${entry.label}`).join('; ')}. All are filed under ${stage}.`),
    '', `The carrier folders record ${count(statuses.length)} such statuses, each filed under one stage.`,
  ].join('\n'),
  coverage: [
    `In a benchmark of ${benchmark.length} carriers picked for shoppers in Europe, run on public tracking numbers anyone can recheck, dedicated adapters return history for **${summary.comparison.direct}**, rising to **${union}** with all fallbacks enabled. The best single aggregator returns ${best}.${undated.length
      ? ` Histories whose scans cannot be placed in time, which the library does not use, would add ${undated.map(source => `${measured.undated[source]} for ${source}`).join(' and ')}.` : ''}`,
    '', picture('coverage', `Carriers with tracking history: ${rows.map(row => `${row.label} ${row.count}`).join(', ')}.`),
  ].join('\n'),
};
const fill = (name, blocks) => {
  let text = readFileSync(path.join(root,name),'utf8');
  for (const [block, content] of Object.entries(blocks)) {
    const start = `<!-- GENERATED:${block} -->`, end = `<!-- /GENERATED:${block} -->`;
    if (!text.includes(start) || !text.includes(end)) throw new Error(`Missing ${name} ${block} markers`);
    text = text.replace(new RegExp(`${start}[\\s\\S]*?${end}`), () => `${start}\n${content}\n${end}`);
  }
  return text;
};
const outputs = { 'README.md': fill('README.md', blocks), 'benchmark/README.md': fill('benchmark/README.md', renderBenchmark(benchmark, root)),
  'data/coverage-summary.json': JSON.stringify(summary,null,2)+'\n',
  'docs/assets/terminal.svg': terminal(`npx universal-parcel-scraper detect ${sample.input}`, detected),
  'docs/assets/coverage.svg': coverageChart(rows, benchmark.length),
  'docs/assets/stages.svg': stagesFigure(samples, stage, read('data/stages.json')) };
for (const [name, content] of Object.entries(outputs)) {
  const file = path.join(root,name);
  if (process.argv.includes('--check')) {
    if (!existsSync(file) || readFileSync(file,'utf8') !== content) throw new Error(`${name} is stale; run npm run generate`);
  } else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file,content); }
}
console.log('The README counts and pictures are generated from the catalog, the status records and the benchmark.');

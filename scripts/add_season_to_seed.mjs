import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);

const NAME_MAP = {
  'California Scrub-Jay': 'Western Scrub-Jay',
  'American Herring Gull': 'Herring Gull',
  'American Barn Owl': 'Barn Owl',
  'Northern House Wren': 'House Wren',
  'Western Marsh Wren': 'Marsh Wren',
  'Accipitrine hawk sp. (former Accipiter sp.)': 'Accipiter sp.',
  'Great Blue Heron': 'Great Blue Heron (Blue form)',
  'Great Blue Heron (Great Blue)': 'Great Blue Heron (Blue form)',
  "Yellow-rumped Warbler (Audubon's x Myrtle)": "Yellow-rumped Warbler (Myrtle x Audubon's)",
  'Red-breasted Sapsucker X Red-naped Sapsucker (hybrid)': 'Red-naped x Red-breasted Sapsucker (hybrid)',
  'Fox Sparrow (Sooty)': 'Fox Sparrow',
};

function usage() {
  console.error('Usage: node scripts/add_season_to_seed.mjs <CODE> <YEAR> <COUNT_INDEX> <table.tsv> [--date MM/DD/YYYY] [--source "text"]');
  console.error('The TSV has a header row; the first column is the species and the last column is the count.');
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const countDate = opt('--date');
const source = opt('--source');
const [code, yearArg, idxArg, tsvPath] = args;
if (!code || !yearArg || !idxArg || !tsvPath) usage();
const year = parseInt(yearArg, 10);
const countIndex = parseInt(idxArg, 10);
if (!Number.isFinite(year) || !Number.isFinite(countIndex)) usage();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(repoRoot, 'public', 'seed', `${code.toUpperCase()}.sqlite`);

const SQL = await initSqlJs({ wasmBinary: await fs.readFile(require.resolve('sql.js/dist/sql-wasm.wasm')) });
const db = new SQL.Database(await fs.readFile(dbPath));
const kv = new Map();
for (const [k, v] of db.exec('SELECT key, value FROM kv')[0].values) kv.set(k, JSON.parse(v));

const base = (s) => String(s || '').replace(/\s*\[.*$/s, '').trim();
const species = kv.get('species');
const byName = new Map(species.map((r) => [base(r.Species), r]));

function resolveName(raw) {
  const name = raw.replaceAll('’', "'").trim();
  const mapped = NAME_MAP[name] || name;
  if (byName.has(mapped)) return { target: mapped, how: mapped === name ? 'exact' : 'renamed' };
  const stripped = mapped.replace(/\s*\([^)]*\)$/, '');
  if (stripped !== mapped && byName.has(stripped)) return { target: stripped, how: 'folded' };
  return { target: mapped, how: 'new' };
}

const counts = new Map();
const report = [];
const lines = (await fs.readFile(tsvPath, 'utf8')).split(/\r?\n/).slice(1);
for (const line of lines) {
  if (!line.trim()) continue;
  const cols = line.split('\t');
  const n = parseInt(cols[cols.length - 1], 10);
  if (!cols[0].trim() || !Number.isFinite(n)) throw new Error(`Bad row: ${line}`);
  const { target, how } = resolveName(cols[0]);
  counts.set(target, (counts.get(target) || 0) + n);
  if (how !== 'exact') report.push(`  ${how.padEnd(7)} ${cols[0].trim()} (${n}) -> ${target}`);
}

for (const name of counts.keys()) {
  if (!byName.has(name)) {
    const row = { Species: name };
    byName.set(name, row);
    species.push(row);
  }
}

const yearKey = String(year);
for (const r of species) r[yearKey] = counts.get(base(r.Species)) ?? 0;

const addYear = (arr) => [...new Set([...(arr || []), year])].sort((a, b) => a - b);
kv.set('years', addYear(kv.get('years')));
kv.set('yearsFull', addYear(kv.get('yearsFull')));
const meta = (kv.get('meta') || []).filter((m) => m.CountIndex !== countIndex);
meta.push({ CountIndex: countIndex, Year: year, CountDate: countDate || null, ...(source ? { Source: source } : {}) });
kv.set('meta', meta);
kv.set('maxCountIndex', Math.max(kv.get('maxCountIndex') || 0, countIndex));
const ranges = kv.get('ranges') || {};
const ys = kv.get('years');
ranges.speciesYears = `${ys[0]}–${ys[ys.length - 1]}`;
kv.set('ranges', ranges);
kv.set('species', species);
kv.set('savedAt', new Date().toISOString());

const put = db.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES(?, ?)');
for (const [k, v] of kv) put.run([k, JSON.stringify(v)]);
put.free();
await fs.writeFile(dbPath, Buffer.from(db.export()));
db.close();

const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`${code}: ${year} [${countIndex}] written: ${counts.size} rows, ${total} birds`);
if (report.length) console.log(report.join('\n'));

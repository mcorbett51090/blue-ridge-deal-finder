/** Entry point for the coordinate pass. See coords.ts for why it exists. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry } from '../fetch/registry.ts';
import { FetchClient } from '../fetch/client.ts';
import { fetchCountyPoints, applyPoints } from './coords.ts';

const ROOT = process.cwd();
const arg = process.argv.find((a) => a.startsWith('--counties='));
const wanted = arg ? arg.split('=')[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];

const seeds = readFileSync(join(ROOT, 'seeds/counties.csv'), 'utf8').trim().split('\n').slice(1);
const byName = new Map<string, string>();
for (const line of seeds) {
  const [fips, , county] = line.split(',');
  if (fips && county) byName.set(county, fips);
}

const pointer = JSON.parse(readFileSync(join(ROOT, 'data/warehouse/warehouse-pointer.json'), 'utf8'));
const dbPath = join(ROOT, 'data/warehouse', pointer.current);

const registry = loadRegistry(ROOT);
const client = new FetchClient(registry);

let total = 0;
for (const county of wanted) {
  const fips = byName.get(county);
  if (!fips) { console.error(`  ! ${county}: not in seeds/counties.csv`); continue; }
  try {
    process.stdout.write(`  ${county}: `);
    const pts = await fetchCountyPoints(client, county, (n) => process.stdout.write(`${n}… `));
    const n = applyPoints(dbPath, fips, pts);
    total += n;
    console.log(`${pts.length} points fetched -> ${n} parcels now mappable`);
  } catch (e) {
    console.error(`\n  ✗ ${county} FAILED: ${(e as Error).message}`);
  }
}
console.log(`\n✓ coordinate pass — ${total} parcels gained a coordinate`);

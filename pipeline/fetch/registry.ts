/**
 * Loads and validates sources.yaml / sources.denied.yaml.
 * No network. Failing to parse is a hard throw: an unreadable registry means
 * the guard cannot answer, and "cannot answer" is refuse, not permit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { DenylistFileSchema, SourcesFileSchema, type Denial, type Source } from './types.ts';

export type Registry = { sources: Source[]; denials: Denial[]; repoRoot: string };

function loadYaml(path: string): unknown {
  return yaml.load(readFileSync(path, 'utf8'));
}

export function loadRegistry(repoRoot: string): Registry {
  const sourcesPath = join(repoRoot, 'sources', 'sources.yaml');
  const deniedPath = join(repoRoot, 'sources', 'sources.denied.yaml');

  const sources = SourcesFileSchema.parse(loadYaml(sourcesPath) ?? []);
  const denials = DenylistFileSchema.parse(loadYaml(deniedPath) ?? []);

  if (denials.length === 0) {
    // An empty denylist is far more likely to be a failed read than a real
    // policy state, and it fails OPEN — the one direction this file must not.
    throw new Error(`registry: ${deniedPath} parsed to zero rules — refusing to run unguarded`);
  }

  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`registry: duplicate source id ${s.id}`);
    ids.add(s.id);
  }
  return { sources, denials, repoRoot };
}

export function getSource(registry: Registry, id: string): Source {
  const found = registry.sources.find((s) => s.id === id);
  if (!found) throw new Error(`registry: no source with id ${id}`);
  return found;
}

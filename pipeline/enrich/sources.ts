/**
 * Loads sources/sources.enrich.yaml and builds the enrichment Registry.
 *
 * ⛔ THE DENYLIST IS THE SHARED ONE. This file does not carry its own copy and
 * does not fall back to an empty list: sources.denied.yaml is loaded through
 * the same loadRegistry() the parcel lane uses, which already refuses to run if
 * that file parses to zero rules. A second denylist would be a second thing to
 * forget to update, and the whole point of §3.2 is that the denylist wins every
 * conflict — including conflicts in lanes written later by someone else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadRegistry, type Registry } from '../fetch/registry.ts';
import { EnrichRegistryFileSchema, type PointService, type RefusedSource } from '../fetch/types.ts';

export type EnrichRegistry = {
  registry: Registry;
  pointServices: PointService[];
  refused: RefusedSource[];
};

export function loadEnrichRegistry(repoRoot: string): EnrichRegistry {
  const base = loadRegistry(repoRoot);
  const path = join(repoRoot, 'sources', 'sources.enrich.yaml');
  const parsed = EnrichRegistryFileSchema.parse(yaml.load(readFileSync(path, 'utf8')) ?? {});

  const ids = new Set(base.sources.map((s) => s.id));
  for (const s of parsed.sources) {
    if (ids.has(s.id)) throw new Error(`sources.enrich.yaml: duplicate source id ${s.id} (already in sources.yaml)`);
    ids.add(s.id);
  }
  // A refused source must not ALSO be present as an enabled entry — that would
  // be a registry that both refuses and permits the same host, and the fetcher
  // would resolve it by whichever list it happened to read.
  const refusedHosts = new Set(parsed.refused.map((r) => new URL(r.url).hostname.toLowerCase()));
  for (const s of [...parsed.sources, ...parsed.point_services]) {
    const host = new URL(s.url).hostname.toLowerCase();
    if (refusedHosts.has(host)) {
      throw new Error(`sources.enrich.yaml: ${s.id} targets ${host}, which is also listed under refused[]`);
    }
  }

  return {
    registry: { sources: [...base.sources, ...parsed.sources], denials: base.denials, repoRoot },
    pointServices: parsed.point_services,
    refused: parsed.refused,
  };
}

export function getPointService(reg: EnrichRegistry, id: string): PointService {
  const found = reg.pointServices.find((s) => s.id === id);
  if (!found) throw new Error(`enrich registry: no point service with id ${id}`);
  return found;
}

/** The refusal record for a host, or null. Used to turn "we may not ask" into a
 *  named unknown_reason rather than a silent absence. */
export function refusalFor(reg: EnrichRegistry, id: string): RefusedSource | null {
  return reg.refused.find((r) => r.id === id) ?? null;
}

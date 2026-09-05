import path from "node:path";
import fs from "node:fs";
import { configDir } from "./store.js";
import { readJsonIfExists, writeFileAtomic } from "./fsutil.js";
import type { ModelSpec } from "./types.js";

const API_URL = "https://models.dev/api.json";
const CACHE_FILE = path.join(configDir, "models-dev.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** models.dev catalog shapes (subset we consume). */
export interface CatalogModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[] }>;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface CatalogProvider {
  id: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, CatalogModel>;
}

export type Catalog = Record<string, CatalogProvider>;

const catalogFetchedAt = new WeakMap<Catalog, string>();

/** Fetch time is kept outside the provider dictionary and never changes its public shape. */
export function getCatalogFetchedAt(catalog: Catalog): string | undefined {
  return catalogFetchedAt.get(catalog);
}

function readCachedCatalog(): Catalog | undefined {
  const catalog = readJsonIfExists<Catalog>(CACHE_FILE);
  if (catalog) {
    try {
      catalogFetchedAt.set(catalog, fs.statSync(CACHE_FILE).mtime.toISOString());
    } catch {
      // A concurrently removed cache still supplies useful metadata without a fetch time.
    }
  }
  return catalog;
}

export async function loadCatalog(opts: { refresh?: boolean; offline?: boolean } = {}): Promise<Catalog | undefined> {
  if (!opts.refresh) {
    try {
      const stat = fs.statSync(CACHE_FILE);
      const fresh = Date.now() - stat.mtimeMs < CACHE_TTL_MS;
      if (fresh || opts.offline) return readCachedCatalog();
    } catch {
      /* no cache */
    }
  }
  if (opts.offline) return readCachedCatalog();
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`models.dev responded ${res.status}`);
    const text = await res.text();
    const catalog = JSON.parse(text) as Catalog; // validate before caching
    writeFileAtomic(CACHE_FILE, text);
    catalogFetchedAt.set(catalog, new Date().toISOString());
    return catalog;
  } catch (err) {
    // network failure: fall back to stale cache if present
    const cached = readCachedCatalog();
    if (cached) return cached;
    process.stderr.write(`warning: could not fetch models.dev catalog: ${(err as Error).message}\n`);
    return undefined;
  }
}

export function toModelSpec(id: string, m: CatalogModel): ModelSpec {
  const efforts = m.reasoning_options?.find((o) => o.type === "effort")?.values;
  return {
    id,
    name: m.name,
    contextWindow: m.limit?.context,
    maxInput: m.limit?.input,
    maxOutput: m.limit?.output,
    reasoning: m.reasoning,
    reasoningEfforts: efforts,
    imageInput: m.attachment !== undefined || m.modalities?.input !== undefined
      ? m.attachment === true || m.modalities?.input?.includes("image") === true
      : undefined,
    cost: m.cost
      ? { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cache_read, cacheWrite: m.cost.cache_write }
      : undefined,
  };
}

/**
 * Find catalog metadata for a model id.
 * Match order: hinted provider exact → hinted provider basename → any provider exact → any basename.
 * Basename = id segment after the last "/" (gateways list ids like "anthropic/claude-opus-4.7").
 */
export function findModelMeta(
  catalog: Catalog,
  modelId: string,
  providerHint?: string,
): { spec: ModelSpec; provider: string } | undefined {
  const base = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  const scan = (p: CatalogProvider): CatalogModel | undefined => {
    if (p.models[modelId]) return p.models[modelId];
    for (const [id, m] of Object.entries(p.models)) {
      if (id.slice(id.lastIndexOf("/") + 1).toLowerCase() === base) return m;
    }
    return undefined;
  };
  const hinted = providerHint ? catalog[providerHint] : undefined;
  if (hinted) {
    const m = scan(hinted);
    if (m) return { spec: toModelSpec(modelId, m), provider: hinted.id };
  }
  const providers = Object.values(catalog).filter((p) => p !== hinted);
  for (const p of providers) {
    const m = p.models[modelId];
    if (m) return { spec: toModelSpec(modelId, m), provider: p.id };
  }
  for (const p of providers) {
    const m = scan(p);
    if (m) return { spec: toModelSpec(modelId, m), provider: p.id };
  }
  return undefined;
}

/** Enrich a list of model ids with models.dev metadata; unmatched ids pass through bare. */
export function enrichModels(catalog: Catalog | undefined, ids: string[], providerHint?: string): ModelSpec[] {
  return ids.map((id) => {
    const hit = catalog ? findModelMeta(catalog, id, providerHint) : undefined;
    return hit?.spec ?? { id };
  });
}

/** Search catalog models by substring across provider/model ids and names. */
export function searchCatalog(
  catalog: Catalog,
  query: string,
  limit = 50,
): Array<{ provider: string; spec: ModelSpec }> {
  const q = query.toLowerCase();
  const out: Array<{ provider: string; spec: ModelSpec }> = [];
  for (const p of Object.values(catalog)) {
    for (const [id, m] of Object.entries(p.models)) {
      if (
        id.toLowerCase().includes(q) ||
        (m.name?.toLowerCase().includes(q) ?? false) ||
        p.id.toLowerCase().includes(q)
      ) {
        out.push({ provider: p.id, spec: toModelSpec(id, m) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

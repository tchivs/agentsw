import { loadStore } from "./store.js";
import type { Protocol } from "./types.js";
import { targets } from "./targets/index.js";
import type { ProviderCandidate } from "./targets/types.js";

/** candidates merged across apps: same protocol + base URL = one smart-switch provider */
export interface MergedCandidate extends Omit<ProviderCandidate, "source"> {
  sources: string[];
  /** id of an already-configured provider covering the same protocol + base URL */
  configured?: string;
}

export function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

const matchKey = (protocol: Protocol, baseUrl: string) => `${protocol}|${normalizeUrl(baseUrl)}`;

/** pure merge: dedupe candidates by protocol+baseUrl, union models, keep first resolved key */
export function mergeCandidates(
  rows: ProviderCandidate[],
  existing: Array<{ id: string; protocol: Protocol; baseUrl: string }>,
): MergedCandidate[] {
  const merged = new Map<string, MergedCandidate>();
  for (const { source, ...c } of rows) {
    const key = matchKey(c.protocol, c.baseUrl);
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, { ...c, baseUrl: normalizeUrl(c.baseUrl), models: [...new Set(c.models)], sources: [source] });
      continue;
    }
    if (!cur.sources.includes(source)) cur.sources.push(source);
    if (!cur.apiKey && c.apiKey) {
      cur.apiKey = c.apiKey;
      cur.keyEnv = c.keyEnv;
    } else if (!cur.keyEnv && c.keyEnv) {
      cur.keyEnv = c.keyEnv;
    }
    for (const m of c.models) if (!cur.models.includes(m)) cur.models.push(m);
    if (!cur.defaultModel && c.defaultModel) cur.defaultModel = c.defaultModel;
  }
  const out = [...merged.values()];
  for (const m of out) {
    const hit = existing.find((e) => matchKey(e.protocol, e.baseUrl) === matchKey(m.protocol, m.baseUrl));
    if (hit) m.configured = hit.id;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** scan every detected app config for custom providers and dedupe them */
export function scanCandidates(): MergedCandidate[] {
  const rows: ProviderCandidate[] = [];
  for (const t of targets) {
    if (!t.candidates) continue;
    try {
      rows.push(...t.candidates());
    } catch {
      // adapter configs that fail to parse are reported by status/apply; skip during scan
    }
  }
  const store = loadStore();
  return mergeCandidates(
    rows,
    Object.values(store.providers).map((p) => ({ id: p.id, protocol: p.protocol, baseUrl: p.baseUrl })),
  );
}

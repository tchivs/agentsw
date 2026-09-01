import { loadStore } from "./store.js";
import { ccSwitchCandidates } from "./sources/ccswitch.js";
import type { Protocol } from "./types.js";
import { targets } from "./targets/index.js";
import type { ProviderCandidate } from "./targets/types.js";

/** candidates merged across apps: same protocol + base URL = one agentsw provider */
export interface MergedCandidate extends Omit<ProviderCandidate, "source"> {
  sources: string[];
  /** id of an already-configured provider covering the same protocol + base URL */
  configured?: string;
}

export function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

/** True when a base URL already names the API version, e.g. `.../v1`. */
const hasApiVersion = (baseUrl: string) => /\/v\d+(?:beta\d*)?$/i.test(baseUrl);

/**
 * Endpoint identity for dedupe. Apps disagree about who owns the `/v1` segment:
 * omp/pi/opencode store it in the base URL, while Codex (and cc-switch's Codex
 * rows) leave it off because the client appends it. `https://host` and
 * `https://host/v1` on one protocol are the same upstream, so they must merge
 * into one provider instead of importing twice.
 */
const matchKey = (protocol: Protocol, baseUrl: string) =>
  `${protocol}|${normalizeUrl(baseUrl).replace(/\/v\d+(?:beta\d*)?$/i, "")}`;

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
    // keep the variant that names the API version: model discovery and most adapters
    // need the full endpoint, and only Codex fills the segment in itself
    if (!hasApiVersion(cur.baseUrl) && hasApiVersion(normalizeUrl(c.baseUrl))) cur.baseUrl = normalizeUrl(c.baseUrl);
    // responses wins: an endpoint one app drives over /v1/responses serves it for all of them,
    // and codex speaks nothing else
    if (c.openaiApi === "responses" || !cur.openaiApi) cur.openaiApi = c.openaiApi ?? cur.openaiApi;
  }
  const out = [...merged.values()];
  for (const m of out) {
    const hit = existing.find((e) => matchKey(e.protocol, e.baseUrl) === matchKey(m.protocol, m.baseUrl));
    if (hit) m.configured = hit.id;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** scan every detected app config — and cc-switch's own store — for custom providers */
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
  try {
    rows.push(...ccSwitchCandidates());
  } catch {
    // a cc-switch store this build cannot read is not this scan's problem
  }
  const store = loadStore();
  return mergeCandidates(
    rows,
    Object.values(store.providers).map((p) => ({ id: p.id, protocol: p.protocol, baseUrl: p.baseUrl })),
  );
}

import { loadStore } from "./store.js";
import { ccSwitchCandidates } from "./sources/ccswitch.js";
import type { Protocol } from "./types.js";
import { targets } from "./targets/index.js";
import type { ProviderCandidate } from "./targets/types.js";

/** Candidates merged only when endpoint, protocol, and credential identity agree. */
export interface MergedCandidate extends Omit<ProviderCandidate, "source"> {
  sources: string[];
  /** ID of an already-configured provider with the same endpoint and resolved credentials. */
  configured?: string;
}

/** Normalize host casing and trailing path slashes without rewriting paths or explicit ports. */
export function normalizeUrl(u: string): string {
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)([?#].*)?$/i.exec(u);
  if (!parts) return u.replace(/\/+$/, "");
  const [, scheme, authority, pathname, suffix] = parts;
  const at = authority!.lastIndexOf("@") + 1;
  return `${scheme!.toLowerCase()}${authority!.slice(0, at)}${authority!.slice(at).toLowerCase()}${pathname!.replace(/\/+$/, "")}${suffix ?? ""}`;
}

/** True when the path already names the API version, e.g. `.../v1`. */
const hasApiVersion = (baseUrl: string) => /\/v\d+(?:beta\d*)?$/.test(baseUrl.split(/[?#]/, 1)[0]!);

/** Apps may append their own API version; all other URL components remain significant. */
export function endpointKey(baseUrl: string): string {
  const normalized = normalizeUrl(baseUrl);
  const suffixAt = normalized.search(/[?#]/);
  const path = suffixAt < 0 ? normalized : normalized.slice(0, suffixAt);
  return path.replace(/\/v\d+(?:beta\d*)?$/, "") + (suffixAt < 0 ? "" : normalized.slice(suffixAt));
}

interface ProviderConnection {
  protocol: Protocol;
  baseUrl: string;
  apiKey?: string;
}

/** An unresolved credential is not evidence that two configurations use the same account. */
export function findMatchingProvider<T extends ProviderConnection>(existing: T[], candidate: ProviderConnection): T | undefined {
  if (!candidate.apiKey) return undefined;
  const endpoint = endpointKey(candidate.baseUrl);
  return existing.find((p) => p.protocol === candidate.protocol && p.apiKey === candidate.apiKey && endpointKey(p.baseUrl) === endpoint);
}

/** Pure merge: union models only within the same credential-qualified endpoint. */
export function mergeCandidates(
  rows: ProviderCandidate[],
  existing: Array<ProviderConnection & { id: string }>,
): MergedCandidate[] {
  const merged = new Map<string, MergedCandidate>();
  for (const { source, ...c } of rows) {
    const credentials = c.apiKey ? ["literal", c.apiKey] : c.keyEnv ? ["env", c.keyEnv] : ["missing", source, c.id];
    const key = JSON.stringify([c.protocol, endpointKey(c.baseUrl), credentials]);
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, { ...c, baseUrl: normalizeUrl(c.baseUrl), models: [...new Set(c.models)], sources: [source] });
      continue;
    }
    // Explicit app identities outrank endpoint-derived suggestions, regardless of scan order.
    if (cur.generatedId && !c.generatedId) {
      cur.id = c.id;
      cur.name = c.name;
      delete cur.generatedId;
    }
    if (!cur.sources.includes(source)) cur.sources.push(source);
    if (!cur.keyEnv && c.keyEnv) cur.keyEnv = c.keyEnv;
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
    const hit = findMatchingProvider(existing, m);
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
    Object.values(store.providers),
  );
}

import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, writeFileAtomic } from "./fsutil.js";
import { configDir } from "./store.js";
import type { ModelSpec } from "./types.js";

const API_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_FILE = path.join(configDir, "ai-gateway.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const REASONING_EFFORTS: Record<string, true> = {
  none: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
};
const PRICE_FIELDS = [
  ["input", "input"],
  ["output", "output"],
  ["cachedInputTokens", "cacheRead"],
  ["cacheCreationInputTokens", "cacheWrite"],
] as const;

export interface GatewayModelMetadata {
  id: string;
  spec: ModelSpec;
  /** Gateway reference prices in USD per million tokens, not effective provider prices. */
  referenceCost?: ModelSpec["cost"];
  pricingIsVariable?: boolean;
}

export interface GatewayCatalog {
  fetchedAt: string;
  models: Record<string, GatewayModelMetadata>;
}

/** Untrusted boundary fields remain unknown until individually validated. */
interface RestModel {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  context_window?: unknown;
  max_tokens?: unknown;
  reasoning_options?: unknown;
  tags?: unknown;
  modalities?: unknown;
  pricing?: unknown;
}

interface RestPricing {
  input?: unknown;
  output?: unknown;
  cachedInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  varies_by_provider?: unknown;
  inputTiers?: unknown;
  outputTiers?: unknown;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.trim() === entry);
}

function reasoningEfforts(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) return undefined;
  let effort: { values?: unknown } | undefined;
  for (const option of options as unknown[]) {
    if (!option || typeof option !== "object" || Array.isArray(option) || !("type" in option) || option.type !== "effort") continue;
    if (effort) return undefined; // Conflicting declarations are not an authoritative effort list.
    effort = option as { values?: unknown };
  }
  const values = effort?.values;
  if (!isStringList(values) || !values.every((value) => Object.hasOwn(REASONING_EFFORTS, value))) return undefined;
  return [...new Set(values)];
}

function perMillion(value: unknown): number | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined;
    value = Number(text);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const converted = value * 1_000_000;
  return Number.isFinite(converted) ? converted : undefined;
}

/** Normalize public REST metadata without interpreting SDK versions as provider routing. */
export function parseGatewayCatalog(body: unknown, fetchedAt: string): GatewayCatalog {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("Invalid AI Gateway catalog");
  }
  const models: Record<string, GatewayModelMetadata> = Object.create(null);
  const seen = new Set<string>();
  for (const entry of body.data as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as RestModel;
    if (typeof row.id !== "string" || !/^[^/\s]+(?:\/[^/\s]+)+$/.test(row.id)) continue;
    if (seen.has(row.id)) throw new Error("Duplicate AI Gateway model identity");
    seen.add(row.id);
    if (row.type !== "language") continue;

    const spec: ModelSpec = { id: row.id };
    if (typeof row.name === "string" && row.name.trim()) spec.name = row.name;
    const context = typeof row.context_window === "number" && Number.isSafeInteger(row.context_window) && row.context_window > 0
      ? row.context_window : undefined;
    const output = typeof row.max_tokens === "number" && Number.isSafeInteger(row.max_tokens) && row.max_tokens > 0
      ? row.max_tokens : undefined;
    // Neither member of an inconsistent pair is safe to treat as authoritative.
    if (context === undefined || output === undefined || output <= context) {
      if (context !== undefined) spec.contextWindow = context;
      if (output !== undefined) spec.maxOutput = output;
    }
    const efforts = reasoningEfforts(row.reasoning_options);
    if (efforts) spec.reasoningEfforts = efforts;
    if ((isStringList(row.tags) && row.tags.includes("reasoning")) || efforts?.some((effort) => effort !== "none")) {
      spec.reasoning = true;
    }
    if (row.modalities && typeof row.modalities === "object" && !Array.isArray(row.modalities) &&
        "input" in row.modalities && isStringList(row.modalities.input)) {
      spec.imageInput = row.modalities.input.includes("image");
    }

    const model: GatewayModelMetadata = { id: row.id, spec };
    if (row.pricing && typeof row.pricing === "object" && !Array.isArray(row.pricing)) {
      const pricing = row.pricing as RestPricing;
      const referenceCost: NonNullable<ModelSpec["cost"]> = {};
      for (const [source, target] of PRICE_FIELDS) {
        const price = perMillion(pricing[source]);
        if (price !== undefined) referenceCost[target] = price;
      }
      if (Object.keys(referenceCost).length) model.referenceCost = referenceCost;
      if ((Array.isArray(pricing.inputTiers) && pricing.inputTiers.length > 0) ||
          (Array.isArray(pricing.outputTiers) && pricing.outputTiers.length > 0)) {
        model.pricingIsVariable = true;
      } else if (typeof pricing.varies_by_provider === "boolean") {
        model.pricingIsVariable = pricing.varies_by_provider;
      }
    }
    models[row.id] = model;
  }
  return { fetchedAt, models };
}

function readCache(): GatewayCatalog | undefined {
  try {
    // Bound local reads as well; the persisted envelope is only slightly larger than the response.
    if (fs.statSync(CACHE_FILE).size > MAX_BODY_BYTES + 1024) return undefined;
    const cache = readJsonIfExists<unknown>(CACHE_FILE);
    if (!cache || typeof cache !== "object" || Array.isArray(cache) ||
        !("version" in cache) || cache.version !== 1 ||
        !("fetchedAt" in cache) || typeof cache.fetchedAt !== "string" || !("body" in cache)) return undefined;
    const timestamp = Date.parse(cache.fetchedAt);
    if (!Number.isFinite(timestamp) || timestamp > Date.now() || new Date(timestamp).toISOString() !== cache.fetchedAt) {
      return undefined;
    }
    return parseGatewayCatalog(cache.body, cache.fetchedAt);
  } catch {
    return undefined;
  }
}

async function readResponseBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("AI Gateway catalog exceeds size limit");
  }
  if (!response.body) throw new Error("Missing AI Gateway catalog body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("AI Gateway catalog exceeds size limit");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Optional supplement: offline never fetches, and every failure leaves discovery usable. */
export async function loadGatewayCatalog(
  opts: { refresh?: boolean; offline?: boolean } = {},
): Promise<GatewayCatalog | undefined> {
  const cached = readCache();
  if (opts.offline) return cached;
  if (!opts.refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) return cached;

  try {
    const response = await fetch(API_URL, {
      signal: AbortSignal.timeout(15_000),
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("AI Gateway catalog request failed");
    }
    const body: unknown = JSON.parse(await readResponseBody(response));
    const catalog = parseGatewayCatalog(body, new Date().toISOString());
    try {
      writeFileAtomic(CACHE_FILE, JSON.stringify({ version: 1, fetchedAt: catalog.fetchedAt, body }) + "\n", 0o600);
    } catch {
      process.stderr.write("warning: could not cache AI Gateway metadata\n");
    }
    return catalog;
  } catch {
    process.stderr.write(cached
      ? "warning: could not refresh AI Gateway metadata; using cached metadata\n"
      : "warning: could not load AI Gateway metadata\n");
    return cached;
  }
}

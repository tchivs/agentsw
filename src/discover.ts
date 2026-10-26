import type { EndpointModelFacts, Protocol } from "./types.js";

/** Append operations to the path, never to a query string or fragment. */
function modelListUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("provider URL must use HTTP or HTTPS");
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname =
    /\/v\d+(?:beta\d*)?$/.test(pathname) ? `${pathname}/models`
    : /\/models$/.test(pathname) ? pathname
    : `${pathname}/v1/models`;
  url.hash = "";
  return url;
}

/** Hard cap on model-list pages; an endpoint emitting endless fresh cursors must not loop forever. */
export const MAX_MODEL_PAGES = 100;

interface ModelPage {
  ids: string[];
  /** Facts the endpoint declared for a listed id; ids it described with id-only rows have no entry. */
  facts: Map<string, EndpointModelFacts>;
  hasMore: boolean;
  lastId?: string;
}

/**
 * Spellings endpoints use for the same fact, in priority order: the first
 * declared key wins when a row carries several. Providers do not agree on
 * names — an OpenAI-compatible gateway publishes context_window_tokens /
 * maximum_output_tokens, OpenRouter publishes context_length /
 * max_output_tokens — and a row without the canonical name would otherwise
 * contribute nothing.
 */
const contextWindowKeys = ["context_window_tokens", "context_length", "max_context_length"] as const;
const maxOutputKeys = ["maximum_output_tokens", "max_output_tokens", "max_completion_tokens"] as const;
/**
 * Spellings of the prices a route charges for its own models, in priority order
 * with the divisor that turns each into USD per million tokens — the unit this
 * tool stores. Providers publish plain dollars, but a gateway that prices
 * precisely keeps nano-USD per million under `pricing`; per-image or per-second
 * rates are not a token price and stay out of it.
 */
type CostSpelling = readonly [path: string, divisor: number];
const costSpellings: Record<"input" | "output" | "cacheRead" | "cacheWrite", readonly CostSpelling[]> = {
  input: [["input_cost_per_million_tokens_usd", 1], ["pricing.input_nano_usd_per_million_tokens", 1e9]],
  output: [["output_cost_per_million_tokens_usd", 1], ["pricing.output_nano_usd_per_million_tokens", 1e9]],
  cacheRead: [["cached_input_cost_per_million_tokens_usd", 1], ["pricing.cached_input_nano_usd_per_million_tokens", 1e9]],
  cacheWrite: [
    ["cache_write_cost_per_million_tokens_usd", 1],
    ["pricing.cache_write_nano_usd_per_million_tokens", 1e9],
    ["pricing.cache_creation_input_nano_usd_per_million_tokens", 1e9],
  ],
};

/** Read a dotted path, stopping at the first value that is not an object. */
function readPath(row: Record<string, unknown>, path: string): unknown {
  let node: unknown = row;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** A price keeps its fraction — a route charging 0.15 per million says so — and 0 is a real price. */
function declaredCost(row: Record<string, unknown>, spellings: readonly CostSpelling[]): number | undefined {
  for (const [path, divisor] of spellings) {
    const value = readPath(row, path);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value / divisor;
  }
  return undefined;
}

function declaredLimit(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    // Floor before the test: a fraction in (0, 1) floors to 0, which every other
    // reader treats as "no window" while the merge would rank it a declaration.
    const limit = Math.floor(value);
    if (limit > 0) return limit;
  }
  return undefined;
}

/** What a model row declares about its own route, or undefined when it describes nothing but its id. */
export function parseEndpointFacts(row: Record<string, unknown>): EndpointModelFacts | undefined {
  const contextWindow = declaredLimit(row, contextWindowKeys);
  const maxOutput = declaredLimit(row, maxOutputKeys);
  const input = declaredCost(row, costSpellings.input);
  const output = declaredCost(row, costSpellings.output);
  const cacheRead = declaredCost(row, costSpellings.cacheRead);
  const cacheWrite = declaredCost(row, costSpellings.cacheWrite);
  const costs: NonNullable<EndpointModelFacts["cost"]> = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
  const hasCost = Object.keys(costs).length > 0;
  if (contextWindow === undefined && maxOutput === undefined && !hasCost) return undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...(hasCost ? { cost: costs } : {}),
  };
}

function parseModelPage(body: unknown): ModelPage {
  if (!body || typeof body !== "object") throw new Error("invalid model-list response");
  const page = body as Record<string, unknown>;
  const rows = page.data ?? page.models;
  if (!Array.isArray(rows)) throw new Error("model-list response has no model array");
  if (page.has_more !== undefined && typeof page.has_more !== "boolean") throw new Error("invalid model-list pagination flag");
  const ids: string[] = [];
  const facts = new Map<string, EndpointModelFacts>();
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const id = (row as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) continue;
    ids.push(id);
    const declared = parseEndpointFacts(row as Record<string, unknown>);
    if (declared) facts.set(id, declared);
  }
  return { ids, facts, hasMore: page.has_more === true, lastId: typeof page.last_id === "string" ? page.last_id : undefined };
}

export interface DiscoveredModels {
  ids: string[];
  /**
   * What the endpoint declared for its own models, keyed by id: limits, and
   * prices when it publishes them. Empty when it lists ids only, which is the
   * common reseller case: the catalog then supplies whatever it knows.
   */
  facts: Map<string, EndpointModelFacts>;
}

/**
 * List the provider's own /v1/models catalog: model ids plus the limits and
 * prices a row declares for itself. Plenty of resellers expose bare ids — those
 * ids carry no entry in `facts` and metadata is filled from models.dev
 * afterwards (enrichModels). An endpoint that declares its own numbers is
 * authoritative for its own route, so they outrank the catalogs instead of
 * being replaced by whatever a third party lists for the same model.
 */
export async function discoverProviderCatalog(
  opts: {
    baseUrl: string;
    apiKey: string;
    protocol: Protocol;
  },
  hooks: { onPage?: (info: { page: number; count: number }) => void } = {},
): Promise<DiscoveredModels> {
  const url = modelListUrl(opts.baseUrl);
  const headers: Record<string, string> =
    opts.protocol === "anthropic"
      ? { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${opts.apiKey}` };
  const ids = new Set<string>();
  const facts = new Map<string, EndpointModelFacts>();
  const cursors = new Set<string>();
  const initialCursor = url.searchParams.get("after_id");
  if (initialCursor) cursors.add(initialCursor);
  for (let page = 1; ; page++) {
    if (page > MAX_MODEL_PAGES) {
      throw new Error(`model-list pagination exceeded ${MAX_MODEL_PAGES} pages; the endpoint keeps reporting more models`);
    }
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`model discovery -> HTTP ${res.status}`);
    const parsed = parseModelPage(await res.json());
    for (const id of parsed.ids) ids.add(id);
    // A repeated id keeps what an earlier page declared: merge per key so a
    // later partial row cannot drop the other limit.
    for (const [id, declared] of parsed.facts) {
      if (!ids.has(id)) continue;
      const earlier = facts.get(id);
      facts.set(id, earlier ? { ...earlier, ...declared } : declared);
    }
    hooks.onPage?.({ page, count: ids.size });
    if (!parsed.hasMore) break;
    if (!parsed.lastId || !parsed.lastId.trim()) throw new Error("model-list pagination is missing last_id");
    if (cursors.has(parsed.lastId)) throw new Error("model-list pagination repeated a cursor");
    cursors.add(parsed.lastId);
    url.searchParams.set("after_id", parsed.lastId);
  }
  if (ids.size === 0) throw new Error("provider returned no models");
  return { ids: [...ids].sort(), facts };
}

/** The listed ids alone, for callers that only need the model list. */
export async function discoverProviderModels(
  opts: {
    baseUrl: string;
    apiKey: string;
    protocol: Protocol;
  },
  hooks: { onPage?: (info: { page: number; count: number }) => void } = {},
): Promise<string[]> {
  return (await discoverProviderCatalog(opts, hooks)).ids;
}

/**
 * Probe which wire protocols an endpoint supports by hitting /v1/models
 * with each protocol's auth headers. Returns the protocols that responded
 * with a valid model list (at least one model id).
 */
export async function probeProtocols(
  opts: {
    baseUrl: string;
    apiKey: string;
  },
  hooks: { onAttempt?: (protocol: Protocol) => void } = {},
): Promise<Protocol[]> {
  const url = modelListUrl(opts.baseUrl).toString();
  const attempts: Array<{ protocol: Protocol; headers: Record<string, string> }> = [
    { protocol: "openai", headers: { authorization: `Bearer ${opts.apiKey}` } },
    { protocol: "anthropic", headers: { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" } },
  ];
  const supported: Protocol[] = [];
  for (const a of attempts) {
    hooks.onAttempt?.(a.protocol);
    try {
      const res = await fetch(url, { headers: a.headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const page = parseModelPage(await res.json());
      if (page.ids.length > 0) supported.push(a.protocol);
    } catch {
      /* network error or timeout — protocol not supported */
    }
  }
  return supported;
}

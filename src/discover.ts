import type { Protocol } from "./types.js";

/** Append operations to the path, never to a query string or fragment. */
function modelListUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("provider URL must use HTTP or HTTPS");
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/v\d+(?:beta\d*)?$/.test(pathname) ? `${pathname}/models` : `${pathname}/v1/models`;
  url.hash = "";
  return url;
}

interface ModelPage {
  ids: string[];
  hasMore: boolean;
  lastId?: string;
}

function parseModelPage(body: unknown): ModelPage {
  if (!body || typeof body !== "object") throw new Error("invalid model-list response");
  const page = body as Record<string, unknown>;
  const rows = page.data ?? page.models;
  if (!Array.isArray(rows)) throw new Error("model-list response has no model array");
  if (page.has_more !== undefined && typeof page.has_more !== "boolean") throw new Error("invalid model-list pagination flag");
  const ids = rows.flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const id = (row as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
  return { ids, hasMore: page.has_more === true, lastId: typeof page.last_id === "string" ? page.last_id : undefined };
}

/**
 * List model ids from the provider's own /v1/models endpoint.
 * Resellers expose the id list here but no metadata (context, thinking, modalities) —
 * metadata is filled from models.dev afterwards (enrichModels).
 */
export async function discoverProviderModels(opts: {
  baseUrl: string;
  apiKey: string;
  protocol: Protocol;
}): Promise<string[]> {
  const url = modelListUrl(opts.baseUrl);
  const headers: Record<string, string> =
    opts.protocol === "anthropic"
      ? { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${opts.apiKey}` };
  const ids = new Set<string>();
  const cursors = new Set<string>();
  const initialCursor = url.searchParams.get("after_id");
  if (initialCursor) cursors.add(initialCursor);
  while (true) {
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`model discovery -> HTTP ${res.status}`);
    const page = parseModelPage(await res.json());
    for (const id of page.ids) ids.add(id);
    if (!page.hasMore) break;
    if (!page.lastId || !page.lastId.trim()) throw new Error("model-list pagination is missing last_id");
    if (cursors.has(page.lastId)) throw new Error("model-list pagination repeated a cursor");
    cursors.add(page.lastId);
    url.searchParams.set("after_id", page.lastId);
  }
  if (ids.size === 0) throw new Error("provider returned no models");
  return [...ids].sort();
}

/**
 * Probe which wire protocols an endpoint supports by hitting /v1/models
 * with each protocol's auth headers. Returns the protocols that responded
 * with a valid model list (at least one model id).
 */
export async function probeProtocols(opts: {
  baseUrl: string;
  apiKey: string;
}): Promise<Protocol[]> {
  const url = modelListUrl(opts.baseUrl).toString();
  const attempts: Array<{ protocol: Protocol; headers: Record<string, string> }> = [
    { protocol: "openai", headers: { authorization: `Bearer ${opts.apiKey}` } },
    { protocol: "anthropic", headers: { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" } },
  ];
  const supported: Protocol[] = [];
  for (const a of attempts) {
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

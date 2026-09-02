import type { Protocol } from "./types.js";

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
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> =
    opts.protocol === "anthropic"
      ? { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${opts.apiKey}` };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
  const rows = body.data ?? body.models ?? [];
  const ids = rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) throw new Error(`${url} returned no models`);
  return [...new Set(ids)].sort();
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
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  const attempts: Array<{ protocol: Protocol; headers: Record<string, string> }> = [
    { protocol: "openai", headers: { authorization: `Bearer ${opts.apiKey}` } },
    { protocol: "anthropic", headers: { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" } },
  ];
  const supported: Protocol[] = [];
  for (const a of attempts) {
    try {
      const res = await fetch(url, { headers: a.headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
      const rows = body.data ?? body.models ?? [];
      const ids = rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length > 0) supported.push(a.protocol);
    } catch {
      /* network error or timeout — protocol not supported */
    }
  }
  return supported;
}

import type { OpenAIApi, Protocol } from "../types.js";

/**
 * pi-family `api` values (pi, prime-agent, omp share the enum) that speak the
 * OpenAI Responses wire: `openai-responses` plus the Azure/Codex variants.
 */
const RESPONSES_APIS: Record<string, true> = {
  "openai-responses": true,
  "azure-openai-responses": true,
  "openai-codex-responses": true,
};

/**
 * Classify a pi-family `api` value. Returns undefined for wires agentsw
 * cannot drive (bedrock, google, ...) so importers skip those providers.
 */
export function classifyApi(api: unknown): { protocol: Protocol; openaiApi?: OpenAIApi } | undefined {
  if (typeof api !== "string") return undefined;
  if (api === "anthropic-messages") return { protocol: "anthropic" };
  if (api === "openai-completions") return { protocol: "openai", openaiApi: "completions" };
  if (RESPONSES_APIS[api]) return { protocol: "openai", openaiApi: "responses" };
  return undefined;
}

/**
 * `api` value to write for a provider. An existing openai-family value is kept
 * whenever it matches the flavor being written, so a sync never rewrites
 * `azure-openai-responses` into plain `openai-responses` — or, when the store
 * carries no flavor at all, downgrades a working `/v1/responses` endpoint to
 * chat completions.
 */
export function apiValue(protocol: Protocol, openaiApi: OpenAIApi | undefined, existing: unknown): string {
  if (protocol === "anthropic") return "anthropic-messages";
  const prev = classifyApi(existing);
  const flavor = openaiApi ?? prev?.openaiApi ?? "completions";
  if (prev?.protocol === "openai" && prev.openaiApi === flavor) return existing as string;
  return flavor === "responses" ? "openai-responses" : "openai-completions";
}

/**
 * The `api` a pi-family entry declares: provider-level, or its models' own when
 * they agree. A mixed-protocol entry has no single answer — one agentsw
 * provider cannot represent it — so importers skip it rather than guess.
 */
export function entryApi(entry: { api?: unknown; models?: unknown }): unknown {
  if (typeof entry.api === "string") return entry.api;
  if (!Array.isArray(entry.models)) return undefined;
  let single: string | undefined;
  for (const model of entry.models as Array<Record<string, unknown> | null>) {
    const api = model?.api;
    if (typeof api !== "string") continue;
    if (single === undefined) single = api;
    else if (single !== api) return undefined;
  }
  return single;
}

/**
 * Merge the model entries agentsw owns over the ones already in an app
 * config: per-model keys the adapter does not model (`compat`, per-model wire
 * overrides, ...) survive a re-sync, while an `owned` key the new entry no
 * longer carries is cleared instead of lingering as last sync's value — a
 * stale `thinkingLevelMap` beside `reasoning: false` is a state no fresh write
 * produces.
 */
export function mergeModels(
  previous: unknown,
  written: Array<Record<string, unknown>>,
  owned: readonly string[],
): Array<Record<string, unknown>> {
  const prev = new Map<string, Record<string, unknown>>();
  if (Array.isArray(previous)) {
    for (const m of previous as Array<Record<string, unknown> | null>) {
      if (m && typeof m.id === "string") prev.set(m.id, m);
    }
  }
  return written.map((m) => {
    const old = prev.get(m.id as string);
    if (!old) return m;
    const kept: Record<string, unknown> = { ...old };
    for (const key of owned) if (!(key in m)) delete kept[key];
    return { ...kept, ...m };
  });
}

/**
 * Drop per-model `api`/`baseUrl` overrides that contradict the route being
 * written. A model-level override wins over the provider entry in omp and pi,
 * so a preserved one would silently keep sending requests to the endpoint or
 * wire the switch just replaced. Returns the dropped `<model>.<key>` labels.
 */
export function stripConflictingOverrides(
  models: Array<Record<string, unknown>>,
  api: string,
  baseUrl: string,
): string[] {
  const dropped: string[] = [];
  for (const model of models) {
    if (typeof model.api === "string" && model.api !== api) {
      dropped.push(`${String(model.id)}.api`);
      delete model.api;
    }
    if (typeof model.baseUrl === "string" && model.baseUrl !== baseUrl) {
      dropped.push(`${String(model.id)}.baseUrl`);
      delete model.baseUrl;
    }
  }
  return dropped;
}

/**
 * Return the base URL expected by SDK-backed clients. Anthropic SDK methods
 * append `/v1/...`, while OpenAI-compatible clients append only the operation
 * path (`/responses` or `/chat/completions`) and therefore keep `/v1`.
 */
export function sdkBaseUrl(protocol: Protocol, baseUrl: string): string {
  return protocol === "anthropic" ? stripApiVersion(baseUrl) : baseUrl.replace(/\/+$/, "");
}

/** Strip a trailing API version segment (e.g. `/v1`, `/v2beta`). */
export function stripApiVersion(baseUrl: string): string {
  return baseUrl.replace(/\/v\d+(?:beta\d*)?\/?$/i, "");
}

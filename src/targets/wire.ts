import type { ModelSpec, OpenAIApi, Protocol } from "../types.js";

/**
 * pi-family `api` values (pi, prime-agent, omp share the enum) that speak the
 * OpenAI Responses wire: `openai-responses` plus the Azure/Codex variants.
 */
const RESPONSES_APIS: Record<string, true> = {
  "openai-responses": true,
  "azure-openai-responses": true,
  "openai-codex-responses": true,
};

export interface ApiWire {
  protocol: Protocol;
  openaiApi?: OpenAIApi;
}

/**
 * Classify a pi-family `api` value. Returns undefined for wires agentsw
 * cannot drive (bedrock, google, ...) so importers skip those providers.
 */
export function classifyApi(api: unknown): ApiWire | undefined {
  if (typeof api !== "string") return undefined;
  if (api === "anthropic-messages") return { protocol: "anthropic" };
  if (api === "openai-completions") return { protocol: "openai", openaiApi: "completions" };
  if (RESPONSES_APIS[api] === true) return { protocol: "openai", openaiApi: "responses" };
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
  if (!Array.isArray(entry.models) || entry.models.length === 0) return entry.api;
  let single: string | undefined;
  let singleWire: ApiWire | undefined;
  for (const model of entry.models as Array<Record<string, unknown> | null>) {
    // A provider default applies only to models without their own override.
    if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
    const api = model.api === undefined ? entry.api : model.api;
    const wire = classifyApi(api);
    if (!wire) return undefined;
    if (single === undefined) {
      single = api as string;
      singleWire = wire;
    } else if (singleWire?.protocol !== wire.protocol || singleWire?.openaiApi !== wire.openaiApi) {
      return undefined;
    }
  }
  return single;
}

/**
 * Merge the model entries agentsw owns over the ones already in an app
 * config: per-model keys the adapter does not model (`compat`, per-model wire
 * overrides, ...) survive a re-sync, and an `owned` key the entry omits is
 * cleared rather than lingering as last sync's value — a stale
 * `thinkingLevelMap` beside `reasoning: false` is a state no fresh write
 * produces.
 *
 * That clearing is only meaningful for an entry that carries metadata at all.
 * A model the store knows nothing about arrives as a bare `{ id }` — that is
 * exactly what enrichment does with an id no catalog row matched — and every
 * adapter still adds the derived capability in `derived`. Absence in such a
 * stub says nothing about the model, so the config's existing values are kept:
 * deleting them would throw away limits an earlier lookup filled in, or that a
 * person typed by hand, every time a catalog lookup misses. Once an entry
 * carries any owned metadata of its own, the same absence is a statement about
 * the model and is applied as before.
 */
export function mergeModels(
  previous: unknown,
  written: Array<Record<string, unknown>>,
  owned: readonly string[],
  /** Owned keys every adapter derives instead of reading them from the model. */
  derived: readonly string[] = ["input"],
): Array<Record<string, unknown>> {
  const prev = new Map<string, Record<string, unknown>>();
  if (Array.isArray(previous)) {
    for (const m of previous as Array<Record<string, unknown> | null>) {
      if (m && typeof m.id === "string") prev.set(m.id, m);
    }
  }
  const informative = owned.filter((key) => key !== "id" && !derived.includes(key));
  return written.map((m) => {
    const old = prev.get(m.id as string);
    if (!old) return m;
    // An entry that carries nothing but its id says nothing about the model: it
    // is no evidence that the config's metadata went stale, so clearing owned
    // keys on its behalf would delete what a richer sync or the user put there.
    if (Object.keys(m).length === 1) return { ...m, ...old };
    const kept: Record<string, unknown> = { ...old };
    const known = informative.some((key) => key in m);
    if (known) for (const key of owned) if (!(key in m)) delete kept[key];
    return { ...kept, ...m };
  });
}

/** Per-model keys every pi-family adapter owns; see `ownedModelMetadata`. */
export const OWNED_MODEL_METADATA_KEYS = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost"] as const;

const DEEPSEEK_MODEL_ID = /deepseek/i;

/**
 * omp/pi/prime key their DeepSeek wire rules by provider name ("deepseek",
 * "opencode-go", ...), so a gateway or reseller entry matches none of them: its
 * reasoning replay then breaks and DeepSeek answers 400. Match on the model id
 * instead and write the adapter's own flags per model; an explicit user value wins.
 */
export function applyDeepseekCompat(
  models: Array<Record<string, unknown>>,
  flags: Record<string, unknown>,
): void {
  for (const model of models) {
    if (!DEEPSEEK_MODEL_ID.test(String(model.id))) continue;
    const compat = (model.compat ?? {}) as Record<string, unknown>;
    model.compat = { ...flags, ...compat };
  }
}

/**
 * Whether a store entry describes the model at all. A bare id is ignorance,
 * not a catalog statement, so adapters must not clear what the app config
 * already holds on its behalf.
 */
export function hasModelMetadata(m: ModelSpec): boolean {
  return (
    m.name !== undefined ||
    m.reasoning !== undefined ||
    m.reasoningEfforts !== undefined ||
    m.imageInput !== undefined ||
    m.contextWindow !== undefined ||
    m.maxInput !== undefined ||
    m.maxOutput !== undefined ||
    m.cost !== undefined
  );
}

/**
 * The per-model metadata agentsw writes into a pi-family models config. omp and
 * the pi/prime adapters share the shape; only the extras around it differ, so
 * keeping one builder is what stops the two from drifting apart.
 */
export function ownedModelMetadata(m: ModelSpec): Record<string, unknown> {
  // `input` is a guess for a spec that says nothing; writing it would make the
  // entry look authoritative to mergeModels and clear the config's own values.
  const known = hasModelMetadata(m);
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(known ? { input: m.imageInput ? ["text", "image"] : ["text"] } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxOutput ? { maxTokens: m.maxOutput } : {}),
    ...(m.cost
      ? {
          cost: {
            input: m.cost.input ?? 0,
            output: m.cost.output ?? 0,
            cacheRead: m.cost.cacheRead ?? 0,
            cacheWrite: m.cost.cacheWrite ?? 0,
          },
        }
      : {}),
  };
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

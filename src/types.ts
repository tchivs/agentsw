import type { ModelFilter } from "./filter.js";

export type Protocol = "openai" | "anthropic";
/** OpenAI-protocol endpoint flavor: chat completions (`/v1/chat/completions`) or responses (`/v1/responses`). */
export type OpenAIApi = "completions" | "responses";
export type Locale = "en" | "zh-CN";

export type ModelMetadataField = "name" | "contextWindow" | "maxInput" | "maxOutput" | "reasoning" | "reasoningEfforts" | "imageInput"
  | "cost.input" | "cost.output" | "cost.cacheRead" | "cost.cacheWrite";
export type ModelMetadataValue = string | number | boolean | string[];

export interface ModelMetadataOrigin {
  source: "models.dev" | "ai-gateway";
  modelId: string;
  /** Snapshot used to detect and preserve subsequent manual overrides. */
  value: ModelMetadataValue;
  updatedAt: string;
  fetchedAt?: string;
}

export interface ModelMetadataConflict {
  field: ModelMetadataField;
  /** Another retained field may block this candidate (e.g. contextWindow limits maxOutput). */
  blockedBy?: ModelMetadataField;
  source: ModelMetadataOrigin["source"];
  modelId: string;
  value: ModelMetadataValue;
  keptValue: ModelMetadataValue;
}

/** Per-model metadata, enriched from models.dev when available. */
export interface ModelSpec {
  id: string;
  name?: string;
  /** total context window (tokens) */
  contextWindow?: number;
  /** max input tokens, when the catalog distinguishes it */
  maxInput?: number;
  /** max output tokens */
  maxOutput?: number;
  /** model supports reasoning/thinking */
  reasoning?: boolean;
  /** supported reasoning effort levels, e.g. ["low","medium","high"] */
  reasoningEfforts?: string[];
  /** supports image input */
  imageInput?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Local audit information; target adapters do not emit it as runtime provider options. */
  metadata?: {
    fields?: Partial<Record<ModelMetadataField, ModelMetadataOrigin>>;
    conflicts?: ModelMetadataConflict[];
    gateway?: {
      modelId: string;
      /** Explicit mapping used; distinguishes alias deletion from a temporary catalog miss. */
      alias?: string;
      fetchedAt: string;
      /** Gateway USD per million tokens, NOT the configured provider's effective cost. */
      referenceCost?: ModelSpec["cost"];
      pricingIsVariable?: boolean;
    };
  };
}

export interface Provider {
  /** slug used as provider id in target app configs */
  id: string;
  /** display name */
  name: string;
  /** wire protocol the endpoint speaks */
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  models: ModelSpec[];
  defaultModel: string;
  /** optional small/fast model (Claude Code haiku slot, etc.) */
  smallModel?: string;
  /** preferred reasoning effort for apps that support it (codex model_reasoning_effort) */
  reasoningEffort?: string;
  /**
   * OpenAI wire flavor for openai-protocol providers: `/v1/chat/completions` vs `/v1/responses`.
   * Undefined means unspecified — adapters keep whatever the app config already had.
   */
  openaiApi?: OpenAIApi;
  /** models.dev provider id used to enrich model metadata */
  modelsDevId?: string;
  /** Public AI Gateway supplement mode; omitted and "auto" fill meaningful metadata gaps. */
  gatewayMetadata?: boolean | "auto";
  /** Exact local model ID -> canonical creator/model ID mappings; no fuzzy aliases. */
  gatewayModelAliases?: Record<string, string>;
  /** persisted discovery filter (re-applied on every `discover`) */
  modelFilter?: ModelFilter;
}

export interface Store {
  version: 1;
  /** preferred CLI language; absent means auto-detect system locale */
  language?: Locale;
  /** id of the currently active provider */
  active?: string;
  providers: Record<string, Provider>;
}

export interface ApplyResult {
  app: string;
  /** files written */
  changed: string[];
  /** informational notes / warnings */
  notes: string[];
  /** app skipped (unsupported protocol, not installed, ...) */
  skipped?: string;
}

import type { ModelFilter } from "./filter.js";

export type Protocol = "openai" | "anthropic";
export type Locale = "en" | "zh-CN";

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
  /** models.dev provider id used to enrich model metadata */
  modelsDevId?: string;
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

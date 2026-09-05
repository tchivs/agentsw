import type { ApplyResult, OpenAIApi, Protocol, Provider } from "../types.js";

/**
 * A custom provider discovered inside an app's own config file, surfaced by
 * `agentsw import`. Adapters must resolve literal keys where the config
 * stores them inline or via a set env var; otherwise leave apiKey undefined
 * and report the referenced name in keyEnv.
 */
export interface ProviderCandidate {
  /** provider id/slug as used inside the app's config */
  id: string;
  /** Account-qualified selector for local management; import continues using id. */
  localId?: string;
  /** True only when the app carries no provider ID and this ID was generated from its endpoint. */
  generatedId?: boolean;
  name: string;
  protocol: Protocol;
  /** OpenAI wire flavor the app config declares (`openai-responses` family vs chat completions) */
  openaiApi?: OpenAIApi;
  baseUrl: string;
  apiKey?: string;
  /** env var name the config references when no literal key was resolvable */
  keyEnv?: string;
  models: string[];
  defaultModel?: string;
  /** source app id this candidate came from */
  source: string;
}

export interface TargetApp {
  /** app slug used in --apps filters */
  id: string;
  name: string;
  /** wire protocols this app can consume */
  protocols: Protocol[];
  /** primary config file(s) this adapter writes */
  configPaths: string[];
  /** true when the app appears installed (config dir exists) */
  detect(): boolean;
  /** write the provider into the app's config; must preserve unrelated settings */
  apply(provider: Provider): Promise<ApplyResult>;
  /** remove this provider's entries from the app's config; must not touch unrelated settings */
  prune(provider: Provider): Promise<ApplyResult>;
  current(): string | undefined;
  /** optional: read custom providers already present in this app's config (for `import`) */
  candidates?(): ProviderCandidate[];
}

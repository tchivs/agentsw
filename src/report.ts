import { getMetadataMode } from "./metadata.js";
import type { ModelSpec, Provider, Store } from "./types.js";

/**
 * Pure builders for `--json` payloads. The command layer measures the world and hands it over; nothing here
 * reads the process, writes output or exits, so the shapes can be asserted directly.
 *
 * Credentials are a hard exclusion: no builder may include apiKey, keyEnv or any other secret material.
 */

export interface StatusAppEntry {
  id: string;
  detected: boolean;
  protocols: string[];
  current: string | null;
  configPath: string;
}

export interface ListAppEntry {
  app?: string;
  id: string;
  name?: string;
}

export interface AppReportRow {
  id: string;
  name: string;
  installed?: string;
  latest?: string;
  upgradable: boolean;
  installable: boolean;
  status: string;
}

export interface SyncReport {
  op: "apply" | "prune";
  provider: string;
  dryRun: boolean;
  apps: string[];
  /** Absolute paths only — never the staged content, which may contain credentials. */
  files: string[];
  backupDir?: string;
}

function modelSpecReport(spec: ModelSpec): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name ?? null,
    contextWindow: spec.contextWindow ?? null,
    maxInput: spec.maxInput ?? null,
    maxOutput: spec.maxOutput ?? null,
    reasoning: spec.reasoning ?? null,
    reasoningEfforts: spec.reasoningEfforts ?? null,
    imageInput: spec.imageInput ?? null,
    cost: spec.cost ?? null,
  };
}

export function providerSummary(provider: Provider): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    modelCount: provider.models.length,
  };
}

export function statusReport(configFile: string, store: Store, apps: StatusAppEntry[]): Record<string, unknown> {
  return { configFile, active: store.active ?? null, apps };
}

export function listReport(store: Store): Record<string, unknown> {
  const providers = Object.keys(store.providers).map((id) => providerSummary(store.providers[id]!));
  return { active: store.active ?? null, providers };
}

export function listAppsReport(apps: string, entries: ListAppEntry[]): Record<string, unknown> {
  return {
    apps,
    entries: entries.map((entry) => ({ app: entry.app ?? null, id: entry.id, name: entry.name ?? null })),
  };
}

export function appsReport(rows: AppReportRow[]): Record<string, unknown> {
  return { apps: rows };
}

/** Mirrors the object `models --provider --metadata` printed before --json existed, for compatibility. */
export function providerMetadataReport(provider: Provider): Record<string, unknown> {
  return {
    provider: provider.id,
    gatewayMetadata: provider.gatewayMetadata ?? "auto",
    metadataMode: getMetadataMode(provider),
    gatewayModelAliases: provider.gatewayModelAliases ?? {},
    models: provider.models.map((spec) => ({ id: spec.id, metadata: spec.metadata })),
  };
}

export function providerModelsReport(provider: Provider, metadata: boolean): Record<string, unknown> {
  if (metadata) return providerMetadataReport(provider);
  return {
    provider: provider.id,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    models: provider.models.map(modelSpecReport),
  };
}

export function modelsQueryReport(query: string, hits: Array<{ provider: string; spec: ModelSpec }>): Record<string, unknown> {
  return {
    query,
    models: hits.map((hit) => ({ provider: hit.provider, ...modelSpecReport(hit.spec) })),
  };
}

import fs from "node:fs";
import YAML from "yaml";
import { backupFile, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import { ompAgentDir, ompModelsFiles } from "../app-paths.js";
import { looksLikeEnvName } from "../slug.js";
import { transactionalTarget } from "../target-transaction.js";
import { parseYamlMapping, serializeYamlMapping } from "../yaml.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";
import {
  apiValue,
  classifyApi,
  entryApi,
  mergeModels,
  OWNED_MODEL_METADATA_KEYS,
  ownedModelMetadata,
  sdkBaseUrl,
  stripConflictingOverrides,
} from "./wire.js";

/** omp has no directory override; the file set is shared with remove/rename. */
function modelFiles(): [string, string] {
  const [yml, yaml] = ompModelsFiles();
  return [yml!, yaml!];
}

/**
 * omp keys its DeepSeek wire rules by provider name ("deepseek",
 * "opencode-go", ...), so a gateway or reseller entry never picks them up: its
 * Responses replay then omits reasoning_text and DeepSeek answers 400. Match
 * on the model id instead and write the flag per model; a user value wins.
 */
const DEEPSEEK_MODEL_ID = /deepseek/i;

function parseModelsDocument(file: string, text: string | undefined): YAML.Document {
  const doc = parseYamlMapping(file, text);
  if (doc.hasIn(["providers"]) && !YAML.isMap(doc.getIn(["providers"]))) {
    throw new Error(`${file}: expected providers to be a mapping`);
  }
  return doc;
}

/**
 * Oh My Pi: providers live in ~/.omp/agent/models.yml (models.yaml fallback).
 * YAML Document round-trip preserves existing comments and unrelated providers.
 */
export const omp: TargetApp = transactionalTarget({
  id: "omp",
  name: "Oh My Pi",
  protocols: ["openai", "anthropic"],
  get configPaths() {
    return [modelFiles()[0]];
  },

  detect: () => fs.existsSync(ompAgentDir()),

  async apply(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    // Respect an existing models.yaml if models.yml is absent (omp precedence: yml then yaml).
    const [modelsYml, modelsYaml] = modelFiles();
    const file = !fs.existsSync(modelsYml) && fs.existsSync(modelsYaml) ? modelsYaml : modelsYml;
    const text = readTextIfExists(file);
    const doc = parseModelsDocument(file, text);

    const prev = (doc.getIn(["providers", provider.id]) as YAML.YAMLMap | undefined)?.toJS(doc) as
      | Record<string, unknown>
      | undefined;
    const anthropic = provider.protocol === "anthropic";
    const api = apiValue(provider.protocol, provider.openaiApi, prev?.api ?? entryApi(prev ?? {}));
    const baseUrl = sdkBaseUrl(provider.protocol, provider.baseUrl);
    const models = mergeModels(prev?.models, provider.models.map(ownedModelMetadata), OWNED_MODEL_METADATA_KEYS);
    const conflicts = stripConflictingOverrides(models, api, baseUrl);
    if (conflicts.length) notes.push(`dropped model overrides pointing elsewhere: ${conflicts.join(", ")}`);
    if (!anthropic) {
      for (const model of models) {
        if (!DEEPSEEK_MODEL_ID.test(String(model.id))) continue;
        const compat = (model.compat ?? {}) as Record<string, unknown>;
        model.compat = { requiresReasoningContentForToolCalls: true, ...compat };
      }
    }
    const entry: Record<string, unknown> = {
      baseUrl,
      apiKey: provider.apiKey, // omp treats value as env-var name first, then literal
      api,
      models,
    };
    if (anthropic) {
      // Most Anthropic-fronted proxies reject the strict tool field.
      entry.disableStrictTools = true;
    }
    // Key-by-key when the entry already exists: provider-level keys agentsw does not
    // model (authHeader, headers, compat, auth, discovery, modelOverrides, ...) and their
    // comments belong to the user; a sync must not drop them.
    const at = ["providers", provider.id];
    if (YAML.isMap(doc.getIn(at))) {
      for (const [key, value] of Object.entries(entry)) doc.setIn([...at, key], doc.createNode(value));
      // an anthropic-only key must not outlive a switch to an openai wire
      if (!anthropic) doc.deleteIn([...at, "disableStrictTools"]);
    } else {
      doc.setIn(at, doc.createNode(entry));
    }

    const output = serializeYamlMapping(file, doc);
    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, output);
    notes.push(`select in omp with: omp --model ${provider.id}/${provider.defaultModel}`);
    return { app: this.id, changed: [file], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const [modelsYml, modelsYaml] = modelFiles();
    const file = fs.existsSync(modelsYml) ? modelsYml : fs.existsSync(modelsYaml) ? modelsYaml : undefined;
    if (!file) return { app: this.id, changed: [], notes: [], skipped: "no models.yml" };
    const doc = parseModelsDocument(file, readTextIfExists(file));
    if (!doc.hasIn(["providers", provider.id])) {
      return { app: this.id, changed: [], notes: [], skipped: `no providers.${provider.id} entry` };
    }
    doc.deleteIn(["providers", provider.id]);
    const notes: string[] = [];
    const output = serializeYamlMapping(file, doc);
    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, output);
    return { app: this.id, changed: [file], notes };
  },

  current(): string | undefined {
    const [modelsYml, modelsYaml] = modelFiles();
    const file = fs.existsSync(modelsYml) ? modelsYml : fs.existsSync(modelsYaml) ? modelsYaml : undefined;
    if (!file) return undefined;
    try {
      const parsed = YAML.parse(readTextIfExists(file) ?? "") as { providers?: Record<string, unknown> } | null;
      const ids = Object.keys(parsed?.providers ?? {});
      return ids.length ? `providers: ${ids.join(", ")}` : undefined;
    } catch {
      return undefined;
    }
  },

  candidates(): ProviderCandidate[] {
    const [modelsYml, modelsYaml] = modelFiles();
    const file = fs.existsSync(modelsYml) ? modelsYml : fs.existsSync(modelsYaml) ? modelsYaml : undefined;
    if (!file) return [];
    type OmpConfig = { providers?: Record<string, Record<string, unknown>> };
    let parsed: OmpConfig | undefined;
    try {
      parsed = YAML.parse(readTextIfExists(file) ?? "") as OmpConfig | undefined;
    } catch {
      return [];
    }
    if (!parsed?.providers) return [];
    const self = this.id;
    return Object.entries(parsed.providers).flatMap(([id, entry]) => {
      if (!entry || typeof entry.baseUrl !== "string") return [];
      const modelEntries = Array.isArray(entry.models) ? (entry.models as Array<Record<string, unknown>>) : [];
      // omp takes `api` at provider level or on every model; a mixed-protocol entry is skipped.
      const wire = classifyApi(entryApi(entry));
      if (!wire) return [];
      let apiKey: string | undefined;
      let keyEnv: string | undefined;
      if (typeof entry.apiKey === "string" && entry.apiKey) {
        if (looksLikeEnvName(entry.apiKey) && process.env[entry.apiKey]) {
          keyEnv = entry.apiKey;
          apiKey = process.env[entry.apiKey];
        } else {
          // omp resolves env-var names first, then uses the value as a literal key
          apiKey = entry.apiKey;
        }
      }
      const models = modelEntries.map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean);
      return [
        {
          id,
          name: typeof entry.name === "string" ? entry.name : id,
          protocol: wire.protocol,
          openaiApi: wire.openaiApi,
          baseUrl: entry.baseUrl,
          apiKey,
          keyEnv,
          models,
          source: self,
        },
      ];
    });
  },
});

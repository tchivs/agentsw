import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { backupFile, home, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import { looksLikeEnvName } from "../slug.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";
import { apiValue, classifyApi, entryApi, mergeModels, sdkBaseUrl, stripConflictingOverrides } from "./wire.js";

/** Per-model keys this adapter writes; one that stops being emitted is cleared, not inherited. */
const OWNED_MODEL_KEYS = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost"] as const;

const agentDir = path.join(home, ".omp", "agent");
const modelsYml = path.join(agentDir, "models.yml");
const modelsYaml = path.join(agentDir, "models.yaml");

/** Resolve references before edits can remove their anchors or mutate shared providers. */
function parseModelsDocument(file: string, text: string | undefined): YAML.Document {
  try {
    const doc = text ? YAML.parseDocument(text) : new YAML.Document({});
    if (doc.errors.length) throw doc.errors[0];
    if (doc.contents == null) doc.contents = doc.createNode({});
    // Validate references with the full document context and the default alias limit.
    // Cycles are valid YAML, but not a usable model configuration; reject before expansion.
    JSON.stringify(doc.toJS());
    const expanded = new Map<YAML.Alias, YAML.Node>();
    YAML.visit(doc, {
      Alias(_key, alias) {
        const node = doc.createNode(alias.toJS(doc), { aliasDuplicateObjects: false });
        node.comment = alias.comment;
        node.commentBefore = alias.commentBefore;
        node.spaceBefore = alias.spaceBefore;
        expanded.set(alias, node);
      },
    });
    // Resolve all references before replacing any nodes (anchors may be reused).
    YAML.visit(doc, { Alias: (_key, alias) => expanded.get(alias) });
    if (!YAML.isMap(doc.contents)) throw new Error("expected a configuration mapping");
    if (doc.hasIn(["providers"]) && !YAML.isMap(doc.getIn(["providers"]))) {
      throw new Error("expected providers to be a mapping");
    }
    return doc;
  } catch (error) {
    throw new Error(`${file} has invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validate the emitted document before any backup or write. */
function serializeModelsDocument(file: string, doc: YAML.Document): string {
  try {
    const text = doc.toString();
    YAML.parse(text);
    return text;
  } catch (error) {
    throw new Error(`${file} has invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Oh My Pi: providers live in ~/.omp/agent/models.yml (models.yaml fallback).
 * YAML Document round-trip preserves existing comments and unrelated providers.
 */
export const omp: TargetApp = {
  id: "omp",
  name: "Oh My Pi",
  protocols: ["openai", "anthropic"],
  configPaths: [modelsYml],

  detect: () => fs.existsSync(path.join(home, ".omp")),

  async apply(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    // Respect an existing models.yaml if models.yml is absent (omp precedence: yml then yaml).
    const file = !fs.existsSync(modelsYml) && fs.existsSync(modelsYaml) ? modelsYaml : modelsYml;
    const text = readTextIfExists(file);
    const doc = parseModelsDocument(file, text);

    const prev = (doc.getIn(["providers", provider.id]) as YAML.YAMLMap | undefined)?.toJS(doc) as
      | Record<string, unknown>
      | undefined;
    const anthropic = provider.protocol === "anthropic";
    const api = apiValue(provider.protocol, provider.openaiApi, entryApi(prev ?? {}));
    const baseUrl = sdkBaseUrl(provider.protocol, provider.baseUrl);
    const models = mergeModels(
      prev?.models,
      provider.models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
        input: m.imageInput ? ["text", "image"] : ["text"],
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
      })),
      OWNED_MODEL_KEYS,
    );
    const conflicts = stripConflictingOverrides(models, api, baseUrl);
    if (conflicts.length) notes.push(`dropped model overrides pointing elsewhere: ${conflicts.join(", ")}`);
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

    const output = serializeModelsDocument(file, doc);
    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, output);
    notes.push(`select in omp with: omp --model ${provider.id}/${provider.defaultModel}`);
    return { app: this.id, changed: [file], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const file = fs.existsSync(modelsYml) ? modelsYml : fs.existsSync(modelsYaml) ? modelsYaml : undefined;
    if (!file) return { app: this.id, changed: [], notes: [], skipped: "no models.yml" };
    const doc = parseModelsDocument(file, readTextIfExists(file));
    if (!doc.hasIn(["providers", provider.id])) {
      return { app: this.id, changed: [], notes: [], skipped: `no providers.${provider.id} entry` };
    }
    doc.deleteIn(["providers", provider.id]);
    const notes: string[] = [];
    const output = serializeModelsDocument(file, doc);
    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, output);
    return { app: this.id, changed: [file], notes };
  },

  current(): string | undefined {
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
};

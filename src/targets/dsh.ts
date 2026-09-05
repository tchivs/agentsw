import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { backupFile, expandHome, home, localAppDataDir, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import { isManagedCredentialRef, legacyManagedCredentialRef, managedCredentialRef } from "../provider-identity.js";
import { transactionalTarget } from "../target-transaction.js";
import { parseYamlMapping, serializeYamlMapping } from "../yaml.js";
import type { ApplyResult, ModelSpec, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";
import { apiValue, classifyApi, mergeModels, sdkBaseUrl } from "./wire.js";

/** `$DSH_HOME`, or `~/.dsh` (packages/util/home-paths `resolveDshHome`). */
function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  return env ? expandHome(env) : process.platform === "win32" ? localAppDataDir("dsh") : path.join(home, ".dsh");
}

/**
 * Settings document: `<harness home>/settings.yaml` by default; the extension
 * picks the format, so an existing `.yml`/`.json` document is written in place.
 */
function settingsFile(): string {
  const dir = dshHome();
  for (const name of ["settings.yaml", "settings.yml", "settings.json"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return path.join(dir, "settings.yaml");
}

const credentialsFile = (): string => path.join(dshHome(), ".credentials.yaml");

/** Layout version of `.credentials.yaml` this build reads and writes. */
const CREDENTIALS_VERSION = 1;

/** Thinking levels a `reasoningEfforts` entry may offer (llm-pi-ai THINKING_LEVEL_GATE). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Per-model keys this adapter writes; one that stops being emitted is cleared, not inherited. */
const OWNED_MODEL_KEYS = ["id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] as const;

/** models.dev efforts -> `{ level: wire spelling }`; an unoffered level is omitted, not nulled. */
function reasoningEfforts(efforts: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  if (efforts.includes("none")) map.off = "none";
  for (const level of THINKING_LEVELS) {
    if (level !== "off" && efforts.includes(level)) map[level] = level;
  }
  return map;
}

function modelEntry(m: ModelSpec): Record<string, unknown> {
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxOutput ? { maxTokens: m.maxOutput } : {}),
    input: m.imageInput ? ["text", "image"] : ["text"],
    ...(m.reasoning === false
      ? { reasoningEfforts: false }
      : m.reasoning && m.reasoningEfforts?.length
        ? { reasoningEfforts: reasoningEfforts(m.reasoningEfforts) }
        : {}),
  };
}

function parseSettings(file: string): YAML.Document {
  const doc = parseYamlMapping(file, readTextIfExists(file));
  for (const at of [["llm-pi-ai"], ["llm-pi-ai", "providers"], ["agent-default-model"]]) {
    if (doc.hasIn(at) && !YAML.isMap(doc.getIn(at))) throw new Error(`${file}: expected ${at.join(".")} to be a mapping`);
  }
  const providers = doc.getIn(["llm-pi-ai", "providers"]);
  if (YAML.isMap(providers) && providers.items.some((pair) => !YAML.isMap(pair.value))) {
    throw new Error(`${file}: expected provider mappings`);
  }
  return doc;
}

/** JSON documents re-serialize without comments; YAML keeps them (dsh reads both). */
function renderSettings(file: string, doc: YAML.Document): string {
  const text = serializeYamlMapping(file, doc);
  return file.endsWith(".json") ? JSON.stringify(doc.toJS(), null, 2) + "\n" : text;
}

/**
 * DeepSeek Harness (dsh): provider routes live in the `llm-pi-ai` section of
 * `$DSH_HOME/settings.yaml`, the picked default in `agent-default-model`, and
 * the key in `$DSH_HOME/.credentials.yaml` — settings carry only a reference.
 */
export const dsh: TargetApp = transactionalTarget({
  id: "dsh",
  name: "DeepSeek Harness",
  protocols: ["openai", "anthropic"],
  configPaths: [settingsFile(), credentialsFile()],

  detect: () => fs.existsSync(dshHome()),

  async apply(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    const file = settingsFile();
    const doc = parseSettings(file);

    const at = ["llm-pi-ai", "providers", provider.id];
    const prev = (doc.getIn(at) as YAML.YAMLMap | undefined)?.toJSON?.() as Record<string, unknown> | undefined;
    const ref = managedCredentialRef(provider.id);
    const entry: Record<string, unknown> = {
      displayName: provider.name,
      apiKeyEnv: ref, // credential reference, never the secret
      api: apiValue(provider.protocol, provider.openaiApi, prev?.api),
      baseURL: sdkBaseUrl(provider.protocol, provider.baseUrl),
    };

    if (YAML.isMap(doc.getIn(at))) {
      // Key-by-key: compat, headers, defaultInput, retryPolicy and their comments are the user's.
      for (const [key, value] of Object.entries(entry)) doc.setIn([...at, key], value);
    } else {
      doc.setIn(at, doc.createNode(entry));
    }
    const modelsAt = [...at, "models"];
    const previousModels = doc.getIn(modelsAt);
    const models: YAML.YAMLSeq = YAML.isSeq(previousModels) ? previousModels : doc.createNode([]);
    const previousById = new Map<unknown, YAML.YAMLMap>();
    for (const node of models.items) {
      if (YAML.isMap(node)) previousById.set(node.get("id"), node);
    }
    models.items = mergeModels(prev?.models, provider.models.map(modelEntry), OWNED_MODEL_KEYS).map((model) => {
      const node = previousById.get(model.id);
      if (!node) return doc.createNode(model);
      for (const key of OWNED_MODEL_KEYS) {
        if (!(key in model)) node.delete(key);
        else node.set(key, typeof model[key] === "object" ? doc.createNode(model[key]) : model[key]);
      }
      return node;
    });
    doc.setIn(modelsAt, models);
    if (doc.hasIn([...at, "modelOverrides"])) {
      // llm-pi-ai refuses modelOverrides beside an explicit models list.
      doc.deleteIn([...at, "modelOverrides"]);
      notes.push("dropped modelOverrides (llm-pi-ai refuses it beside an explicit models list)");
    }
    // The picker writes this section whole; a partial write would keep a stale reasoningEffort.
    doc.set("agent-default-model", doc.createNode({ provider: provider.id, model: provider.defaultModel }));
    const referenced = credentialReferences(doc, provider.id);
    const oldRef = typeof prev?.apiKeyEnv === "string" && isManagedCredentialRef(prev.apiKeyEnv, provider.id) && !referenced.has(prev.apiKeyEnv)
      ? prev.apiKeyEnv : undefined;
    const credential = writeCredential(ref, provider.apiKey, notes, oldRef, referenced);

    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, renderSettings(file, doc));

    const changed = [file, credential];
    notes.push(`select in dsh with the model picker, or run: dsh web`);
    return { app: this.id, changed, notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    const file = settingsFile();
    // Settings must be understood before any credential can be removed.
    const doc = parseSettings(file);
    const at = ["llm-pi-ai", "providers", provider.id];
    const hasProvider = doc.hasIn(at);
    if (hasProvider) doc.deleteIn(at);
    const referenced = credentialReferences(doc);
    const removable = new Set([managedCredentialRef(provider.id), legacyManagedCredentialRef(provider.id)].filter((ref) => !referenced.has(ref)));
    const droppedCredential = deleteCredentials(removable, notes);
    if (!hasProvider) {
      const why = `no llm-pi-ai.providers.${provider.id} entry`;
      if (!droppedCredential) return { app: this.id, changed: [], notes, skipped: why };
      notes.push(why);
      return { app: this.id, changed: [droppedCredential], notes };
    }
    if (doc.getIn(["agent-default-model", "provider"]) === provider.id) {
      doc.delete("agent-default-model");
      notes.push("default model selection reset (was pointing at this provider)");
    }
    // leave no "providers: {}" / "llm-pi-ai: {}" behind
    for (const empty of [["llm-pi-ai", "providers"], ["llm-pi-ai"]]) {
      const node = doc.getIn(empty);
      if (YAML.isMap(node) && node.items.length === 0) doc.deleteIn(empty);
    }
    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, renderSettings(file, doc));
    return { app: this.id, changed: droppedCredential ? [file, droppedCredential] : [file], notes };
  },

  current(): string | undefined {
    const text = readTextIfExists(settingsFile());
    if (!text) return undefined;
    try {
      const parsed = YAML.parse(text) as { "agent-default-model"?: { provider?: string; model?: string } } | null;
      const selection = parsed?.["agent-default-model"];
      if (!selection?.provider) return undefined;
      return `${selection.provider} · ${selection.model ?? "?"}`;
    } catch {
      return undefined;
    }
  },

  candidates(): ProviderCandidate[] {
    const text = readTextIfExists(settingsFile());
    if (!text) return [];
    type DshSettings = {
      "llm-pi-ai"?: { providers?: Record<string, Record<string, unknown>> };
      "agent-default-model"?: { provider?: string; model?: string };
    };
    let parsed: DshSettings | undefined;
    try {
      parsed = YAML.parse(text) as DshSettings | undefined;
    } catch {
      return [];
    }
    const providers = parsed?.["llm-pi-ai"]?.providers;
    if (!providers) return [];
    const refs = readCredentialRefs();
    const selection = parsed?.["agent-default-model"];
    const self = this.id;
    return Object.entries(providers).flatMap(([id, entry]) => {
      if (!entry || typeof entry.baseURL !== "string") return [];
      const wire = classifyApi(entry.api);
      if (!wire) return [];
      const keyEnv = typeof entry.apiKeyEnv === "string" && entry.apiKeyEnv ? entry.apiKeyEnv : undefined;
      // dsh credential precedence: inherited process environment first, then the managed store.
      const apiKey = keyEnv ? (process.env[keyEnv] ?? refs[keyEnv]) : undefined;
      const models = Array.isArray(entry.models)
        ? (entry.models as Array<Record<string, unknown>>).map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean)
        : [];
      const defaultModel = selection?.provider === id ? selection.model : undefined;
      if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
      return [
        {
          id,
          name: typeof entry.displayName === "string" ? entry.displayName : id,
          protocol: wire.protocol,
          openaiApi: wire.openaiApi,
          baseUrl: entry.baseURL,
          apiKey,
          keyEnv,
          models,
          defaultModel,
          source: self,
        },
      ];
    });
  },
});

/** Read the managed store's `refs` section; an unreadable document yields no keys. */
function readCredentialRefs(): Record<string, string> {
  try {
    const doc = parseCredentials(credentialsFile());
    const parsed = doc.toJS() as Record<string, unknown>;
    return (doc.get("version") === undefined ? parsed : parsed.refs ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

function parseCredentials(file: string): YAML.Document {
  const doc = parseYamlMapping(file, readTextIfExists(file));
  const version = doc.get("version");
  if (version !== undefined && version !== CREDENTIALS_VERSION) {
    const label = typeof version === "number" ? String(version) : "an unsupported value";
    throw new Error(`${file} declares version ${label}; agentsw writes version ${CREDENTIALS_VERSION}`);
  }
  if (version === undefined) {
    const flat = Object.entries(doc.toJS() as Record<string, unknown>).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string" && value.length > 0);
    if (!flat) throw new Error(`${file} is neither the version ${CREDENTIALS_VERSION} layout nor a pre-release flat document; refusing to rewrite it`);
  } else if (doc.has("refs") && !YAML.isMap(doc.get("refs"))) {
    throw new Error(`${file}: expected refs to be a mapping`);
  }
  const refs = doc.get("refs");
  if (version !== undefined && YAML.isMap(refs) && refs.items.some((pair) =>
    !YAML.isScalar(pair.key) || typeof pair.key.value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair.key.value) ||
    !YAML.isScalar(pair.value) || typeof pair.value.value !== "string" || pair.value.value.length === 0)) {
    throw new Error(`${file}: expected non-empty credential values with valid reference names`);
  }
  return doc;
}

/**
 * Store the key under `refs`, migrating a pre-release flat document first.
 * The flat layout is recognized exactly the way dsh recognizes it — a mapping
 * of reference names to non-empty string scalars — so a document that only
 * looks unversioned (a hand-written `refs:` block, a future layout) is refused
 * instead of being re-rooted one level deeper. Returns the file.
 */
function writeCredential(ref: string, apiKey: string, notes: string[], oldRef: string | undefined, referenced: ReadonlySet<string>): string {
  const file = credentialsFile();
  const doc = parseCredentials(file);
  if (doc.get("version") === undefined) {
    const refs = doc.contents;
    const migrating = YAML.isMap(refs) && refs.items.length > 0;
    doc.contents = doc.createNode({ version: CREDENTIALS_VERSION });
    doc.set("refs", refs);
    if (migrating) notes.push(`migrated ${file} to the version ${CREDENTIALS_VERSION} layout`);
  }
  if (referenced.has(ref) && doc.getIn(["refs", ref]) !== apiKey) {
    throw new Error(`${file}: credential reference is shared by another provider; refusing to replace it`);
  }
  doc.setIn(["refs", ref], apiKey);
  if (oldRef && oldRef !== ref) doc.deleteIn(["refs", oldRef]);
  const text = serializeYamlMapping(file, doc);
  const backup = backupFile(file);
  if (backup) notes.push(`backup: ${backup}`);
  // dsh refuses a credentials document readable beyond its owner.
  writeFileAtomic(file, text, 0o600);
  return file;
}

/** Drop only managed references that no surviving route uses. */
function deleteCredentials(refs: ReadonlySet<string>, notes: string[]): string | undefined {
  const file = credentialsFile();
  if (readTextIfExists(file) === undefined) return undefined;
  const doc = parseCredentials(file);
  let changed = false;
  for (const ref of refs) {
    const at = doc.get("version") === undefined ? [ref] : ["refs", ref];
    if (doc.hasIn(at)) { doc.deleteIn(at); changed = true; }
  }
  if (!changed) return undefined;
  const text = serializeYamlMapping(file, doc);
  const backup = backupFile(file);
  if (backup) notes.push(`backup: ${backup}`);
  writeFileAtomic(file, text, 0o600);
  return file;
}

function credentialReferences(doc: YAML.Document, exceptId?: string): Set<string> {
  const providers = doc.getIn(["llm-pi-ai", "providers"]);
  const refs = new Set<string>();
  if (YAML.isMap(providers)) {
    for (const pair of providers.items) {
      if ((YAML.isScalar(pair.key) ? pair.key.value : pair.key) === exceptId) continue;
      const ref = YAML.isMap(pair.value) ? pair.value.get("apiKeyEnv") : undefined;
      if (typeof ref === "string") refs.add(ref);
    }
  }
  return refs;
}

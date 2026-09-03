import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { backupFile, expandHome, home, localAppDataDir, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, ModelSpec, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";
import { apiValue, classifyApi, mergeModels, stripApiVersion } from "./wire.js";

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

/** Credential reference: a POSIX identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`). */
const credentialRef = (id: string): string => `AGENTSW_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

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
  const text = readTextIfExists(file);
  const doc: YAML.Document = text ? YAML.parseDocument(text) : new YAML.Document({});
  if (doc.errors.length) {
    throw new Error(`${file} has settings errors; refusing to rewrite: ${doc.errors[0]?.message}`);
  }
  if (doc.contents == null) doc.contents = doc.createNode({});
  return doc;
}

/** JSON documents re-serialize without comments; YAML keeps them (dsh reads both). */
function renderSettings(file: string, doc: YAML.Document): string {
  return file.endsWith(".json") ? JSON.stringify(doc.toJSON(), null, 2) + "\n" : doc.toString();
}

/**
 * DeepSeek Harness (dsh): provider routes live in the `llm-pi-ai` section of
 * `$DSH_HOME/settings.yaml`, the picked default in `agent-default-model`, and
 * the key in `$DSH_HOME/.credentials.yaml` — settings carry only a reference.
 */
export const dsh: TargetApp = {
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
    const ref = credentialRef(provider.id);
    const entry: Record<string, unknown> = {
      displayName: provider.name,
      apiKeyEnv: ref, // credential reference, never the secret
      api: apiValue(provider.protocol, provider.openaiApi, prev?.api),
      baseURL: stripApiVersion(provider.baseUrl),
      models: mergeModels(prev?.models, provider.models.map(modelEntry), OWNED_MODEL_KEYS),
    };

    if (YAML.isMap(doc.getIn(at))) {
      // Key-by-key: compat, headers, defaultInput, retryPolicy and their comments are the user's.
      for (const [key, value] of Object.entries(entry)) doc.setIn([...at, key], doc.createNode(value));
    } else {
      doc.setIn(at, doc.createNode(entry));
    }
    if (doc.hasIn([...at, "modelOverrides"])) {
      // llm-pi-ai refuses modelOverrides beside an explicit models list.
      doc.deleteIn([...at, "modelOverrides"]);
      notes.push("dropped modelOverrides (llm-pi-ai refuses it beside an explicit models list)");
    }
    // The picker writes this section whole; a partial write would keep a stale reasoningEffort.
    doc.set("agent-default-model", doc.createNode({ provider: provider.id, model: provider.defaultModel }));

    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, renderSettings(file, doc));

    const changed = [file, writeCredential(ref, provider.apiKey, notes)];
    notes.push(`select in dsh with the model picker, or run: dsh web`);
    return { app: this.id, changed, notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    // The stored key is removed even when the route is already gone, so a hand-deleted
    // route never leaves its secret behind.
    const droppedCredential = deleteCredential(credentialRef(provider.id), notes);
    const file = settingsFile();
    const doc = fs.existsSync(file) ? parseSettings(file) : undefined;
    const at = ["llm-pi-ai", "providers", provider.id];
    if (!doc?.hasIn(at)) {
      const why = doc ? `no llm-pi-ai.providers.${provider.id} entry` : "no settings document";
      if (!droppedCredential) return { app: this.id, changed: [], notes, skipped: why };
      notes.push(why);
      return { app: this.id, changed: [droppedCredential], notes };
    }
    doc.deleteIn(at);

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

    const changed = [file];
    if (droppedCredential) changed.push(droppedCredential);
    return { app: this.id, changed, notes };
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
};

/** Read the managed store's `refs` section; an unreadable document yields no keys. */
function readCredentialRefs(): Record<string, string> {
  const text = readTextIfExists(credentialsFile());
  if (!text) return {};
  try {
    const parsed = YAML.parse(text) as Record<string, unknown> | null;
    const refs = parsed?.refs;
    if (refs && typeof refs === "object") return refs as Record<string, string>;
    // pre-release flat layout: top-level reference-to-secret mapping
    if (parsed && !("version" in parsed)) return parsed as Record<string, string>;
    return {};
  } catch {
    return {};
  }
}

function parseCredentials(file: string): YAML.Document {
  const text = readTextIfExists(file);
  const doc: YAML.Document = text ? YAML.parseDocument(text) : new YAML.Document({});
  if (doc.errors.length) {
    throw new Error(`${file} has YAML errors; refusing to rewrite: ${doc.errors[0]?.message}`);
  }
  if (doc.contents == null) doc.contents = doc.createNode({});
  return doc;
}

/**
 * Store the key under `refs`, migrating a pre-release flat document first.
 * The flat layout is recognized exactly the way dsh recognizes it — a mapping
 * of reference names to non-empty string scalars — so a document that only
 * looks unversioned (a hand-written `refs:` block, a future layout) is refused
 * instead of being re-rooted one level deeper. Returns the file.
 */
function writeCredential(ref: string, apiKey: string, notes: string[]): string {
  const file = credentialsFile();
  const doc = parseCredentials(file);
  const root = (doc.toJSON() ?? {}) as Record<string, unknown>;
  const version = root.version;
  if (version !== undefined && version !== CREDENTIALS_VERSION) {
    throw new Error(`${file} declares version ${JSON.stringify(version)}; agentsw writes version ${CREDENTIALS_VERSION}`);
  }
  if (version === undefined && Object.keys(root).length > 0) {
    const flat = Object.entries(root).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string" && value.length > 0);
    if (!flat) {
      throw new Error(`${file} is neither the version ${CREDENTIALS_VERSION} layout nor a pre-release flat document; refusing to rewrite it`);
    }
    doc.contents = doc.createNode({ version: CREDENTIALS_VERSION, refs: root });
    notes.push(`migrated ${file} to the version ${CREDENTIALS_VERSION} layout`);
  }
  doc.set("version", CREDENTIALS_VERSION);
  doc.setIn(["refs", ref], apiKey);
  const backup = backupFile(file);
  if (backup) notes.push(`backup: ${backup}`);
  // dsh refuses a credentials document readable beyond its owner.
  writeFileAtomic(file, doc.toString(), 0o600);
  return file;
}

/** Drop this provider's reference. Returns the file when it was rewritten. */
function deleteCredential(ref: string, notes: string[]): string | undefined {
  const file = credentialsFile();
  const text = readTextIfExists(file);
  if (!text) return undefined;
  const doc = parseCredentials(file);
  const at = doc.hasIn(["refs", ref]) ? ["refs", ref] : doc.has(ref) ? [ref] : undefined;
  if (!at) return undefined;
  doc.deleteIn(at);
  const backup = backupFile(file);
  if (backup) notes.push(`backup: ${backup}`);
  writeFileAtomic(file, doc.toString(), 0o600);
  return file;
}

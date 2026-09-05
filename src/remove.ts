import fs from "node:fs";
import path from "node:path";
import { applyEdits, parse as parseJsonc } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import YAML from "yaml";
import { commitFileChanges } from "./config-transaction.js";
import type { FileChange } from "./config-transaction.js";
import { appDataDir, drainPendingWrites, expandHome, home, localAppDataDir, setDryRun } from "./fsutil.js";
import { editJsoncObject, isJsonObject, readJsoncObject } from "./jsonc.js";
import { configFile } from "./store.js";
import { endpointKey } from "./import.js";
import { envAssignments } from "./envfile.js";
import { resolveTargets, targets } from "./targets/index.js";
import type { ProviderCandidate, TargetApp } from "./targets/types.js";
import { classifyApi, entryApi } from "./targets/wire.js";
import type { Provider } from "./types.js";
import { isManagedCredentialRef, legacyManagedCredentialRef, managedCredentialRef } from "./provider-identity.js";
import { workbuddyBaseUrl } from "./targets/workbuddy.js";

type RecordValue = Record<string, unknown>;
type Location = string[];
interface ConfigDocument {
  file: string;
  before: string;
  text: string;
  original: RecordValue;
  value: RecordValue;
  yaml?: YAML.Document;
  changed: boolean;
}
interface TargetFiles {
  documents: Map<string, ConfigDocument>;
  maps: Array<{ document: ConfigDocument; at: Location }>;
  refs: ConfigDocument[];
  extras: Map<string, string | undefined>;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${file}: unable to read configuration`);
  }
}

/** Validate before planning, and resolve aliases before deleting their anchors. */
function parseDocument(file: string, text: string, before = text): ConfigDocument {
  let yaml: YAML.Document | undefined;
  let original: unknown;
  try {
    if (/\.ya?ml$/i.test(file)) {
      yaml = YAML.parseDocument(text);
      if (yaml.errors.length) throw new Error("invalid YAML");
      if (yaml.contents == null) yaml.contents = yaml.createNode({});
      original = yaml.toJS();
      JSON.stringify(original);
      const expanded = new Map<YAML.Alias, YAML.Node>();
      YAML.visit(yaml, {
        Alias(_key, alias) {
          const node = yaml!.createNode(alias.toJS(yaml!), { aliasDuplicateObjects: false });
          node.comment = alias.comment;
          node.commentBefore = alias.commentBefore;
          node.spaceBefore = alias.spaceBefore;
          expanded.set(alias, node);
        },
      });
      YAML.visit(yaml, { Alias: (_key, alias) => expanded.get(alias) });
      original = yaml.toJS();
    } else if (file.endsWith(".toml")) {
      original = parseToml(text);
    } else {
      // Reuse strict parsing (including duplicate-key checks) for originals.
      if (text === before) {
        const parsed = readJsoncObject(file);
        if (parsed.text !== text) throw new Error("configuration changed during planning");
        original = parsed.value;
      } else {
        const errors: ParseError[] = [];
        original = parseJsonc(text, errors, { allowTrailingComma: true });
        if (errors.length) throw new Error("invalid JSONC");
      }
    }
    if (!isJsonObject(original)) throw new Error("expected a configuration mapping");
  } catch {
    // Parser messages can contain credential-bearing source lines.
    throw new Error(`${file}: invalid configuration; refusing to modify it`);
  }
  return { file, before, text, original, value: structuredClone(original), yaml, changed: text !== before };
}

function valueAt(document: ConfigDocument, at: Location): unknown {
  let value: unknown = document.value;
  for (const key of at) {
    if (!isJsonObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function removeAt(document: ConfigDocument, at: Location): boolean {
  const parent = valueAt(document, at.slice(0, -1));
  const key = at[at.length - 1]!;
  if (!isJsonObject(parent) || !Object.hasOwn(parent, key)) return false;
  delete parent[key];
  document.yaml?.deleteIn(at);
  document.changed = true;
  return true;
}

function replaceAt(document: ConfigDocument, at: Location, value: unknown): void {
  const parent = valueAt(document, at.slice(0, -1));
  if (!isJsonObject(parent)) return;
  parent[at[at.length - 1]!] = value;
  document.yaml?.setIn(at, document.yaml.createNode(value));
  document.changed = true;
}

function removeEmpty(document: ConfigDocument, at: Location): void {
  const value = valueAt(document, at);
  if (isJsonObject(value) && Object.keys(value).length === 0) removeAt(document, at);
}

function providerMap(document: ConfigDocument, at: Location): RecordValue {
  for (let size = 1; size <= at.length; size++) {
    const value = valueAt(document, at.slice(0, size));
    if (value !== undefined && !isJsonObject(value)) {
      throw new Error(`${document.file}: expected ${at.slice(0, size).join(".")} to be a mapping`);
    }
  }
  const map = valueAt(document, at) as RecordValue | undefined;
  if (map && Object.values(map).some((entry) => !isJsonObject(entry))) {
    throw new Error(`${document.file}: expected provider entries to be mappings`);
  }
  return map ?? {};
}

function render(document: ConfigDocument): string {
  if (document.yaml) {
    const text = document.yaml.toString();
    try { YAML.parse(text); } catch { throw new Error(`${document.file}: cannot serialize configuration safely`); }
    return text;
  }
  if (document.file.endsWith(".toml")) return stringifyToml(document.value) + "\n";
  return editJsoncObject({ file: document.file, text: document.text, value: document.original }, document.value);
}

function targetFiles(target: TargetApp, listing = false): TargetFiles {
  const result: TargetFiles = { documents: new Map(), maps: [], refs: [], extras: new Map() };
  const add = (file: string, at?: Location): ConfigDocument | undefined => {
    file = path.resolve(file);
    let document = result.documents.get(file);
    if (!document) {
      const text = readText(file);
      if (text === undefined) return undefined;
      document = parseDocument(file, text);
      result.documents.set(file, document);
    }
    if (at) {
      providerMap(document, at);
      if (!result.maps.some((map) => map.document === document)) result.maps.push({ document, at });
    }
    return document;
  };
  const refs = (file: string): void => {
    if (listing && target.id !== "claude") return;
    const document = add(file);
    if (document) result.refs.push(document);
  };
  switch (target.id) {
    case "omp": {
      const dir = path.join(home, ".omp", "agent");
      for (const name of ["models.yml", "models.yaml"]) add(path.join(dir, name), ["providers"]);
      for (const name of ["config.yml", "config.yaml"]) refs(path.join(dir, name));
      break;
    }
    case "pi":
    case "prime": {
      const env = process.env[target.id === "pi" ? "PI_CODING_AGENT_DIR" : "PRIME_AGENT_CODING_AGENT_DIR"];
      const dir = env ? expandHome(env) : path.join(home, target.id === "pi" ? ".pi/agent" : ".prime/agent");
      add(path.join(dir, "models.json"), ["providers"]);
      refs(path.join(dir, "settings.json"));
      break;
    }
    case "opencode": {
      const dirs = new Set([appDataDir("opencode")]);
      if (process.env.OPENCODE_CONFIG_DIR?.trim()) dirs.add(expandHome(process.env.OPENCODE_CONFIG_DIR.trim()));
      const files = new Set<string>();
      for (const dir of dirs) {
        for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) files.add(path.join(dir, name));
      }
      if (process.env.OPENCODE_CONFIG?.trim()) files.add(expandHome(process.env.OPENCODE_CONFIG.trim()));
      for (const file of files) add(file, ["provider"]);
      break;
    }
    case "codex":
      add(target.configPaths[0]!, ["model_providers"]);
      break;
    case "hermes": {
      const dir = process.env.HERMES_HOME?.trim() || localAppDataDir("hermes");
      add(path.join(dir, "config.yaml"), ["providers"]);
      const file = path.resolve(dir, ".env");
      if (!listing) result.extras.set(file, readText(file));
      break;
    }
    case "dsh": {
      const dir = process.env.DSH_HOME?.trim() ? expandHome(process.env.DSH_HOME.trim()) : localAppDataDir("dsh");
      const file = ["settings.yaml", "settings.yml", "settings.json"].map((name) => path.join(dir, name)).find((file) => fs.existsSync(file));
      if (file) add(file, ["llm-pi-ai", "providers"]);
      if (!listing) {
        const credentials = add(path.join(dir, ".credentials.yaml"));
        if (credentials) {
          const { version, refs } = credentials.value;
          const flat = version === undefined && refs === undefined && Object.values(credentials.value).every((value) => typeof value === "string");
          if (!flat && (version !== 1 || (refs !== undefined && !isJsonObject(refs)))) {
            throw new Error(`${credentials.file}: unsupported credential layout; refusing to modify it`);
          }
        }
      }
      break;
    }
    case "claude":
      refs(target.configPaths[0]!);
      break;
    // WorkBuddy has a model array, not a named provider map; its adapter supplies candidates.
    case "workbuddy":
      break;
    default:
      throw new Error(`unsupported app "${target.id}"`);
  }
  return result;
}

function hasModelPrefix(value: unknown, id: string): value is string {
  return typeof value === "string" && value.startsWith(`${id}/`);
}

function clearModelRefs(document: ConfigDocument, at: Location, id: string): void {
  const value = valueAt(document, at);
  if (hasModelPrefix(value, id)) {
    removeAt(document, at);
  } else if (isJsonObject(value)) {
    for (const key of Object.keys(value)) {
      if (hasModelPrefix(value[key], id)) removeAt(document, [...at, key]);
    }
  } else if (Array.isArray(value)) {
    const kept = value.filter((model) => !hasModelPrefix(model, id) && !(isJsonObject(model) && model.provider === id));
    if (kept.length !== value.length) replaceAt(document, at, kept);
  }
}

function clearSelection(document: ConfigDocument, providerAt: Location, modelKeys: string[], id: string): boolean {
  if (valueAt(document, providerAt) !== id) return false;
  removeAt(document, providerAt);
  for (const key of modelKeys) removeAt(document, [...providerAt.slice(0, -1), key]);
  return true;
}

/** Adapter planning is isolated from mutation, including failures after a queued write. */
async function previewPrune(target: TargetApp, provider: Provider, files: TargetFiles): Promise<void> {
  let writes: Array<{ file: string; content: string }>;
  try {
    setDryRun(true);
    await target.prune(provider);
    writes = drainPendingWrites();
  } catch {
    throw new Error(`${target.name}: unable to prepare provider removal; no files changed`);
  } finally {
    setDryRun(false);
  }
  for (const write of writes) {
    const file = path.resolve(write.file);
    const old = files.documents.get(file);
    if (!old) throw new Error(`${file}: adapter attempted an unplanned configuration write`);
    const document = parseDocument(file, write.content, old.before);
    files.documents.set(file, document);
    for (const map of files.maps) if (map.document === old) map.document = document;
    files.refs = files.refs.map((ref) => ref === old ? document : ref);
  }
}

function namedProvider(id: string): Provider {
  // Named-map prune methods only consume id, not endpoint/model/credential metadata.
  return { id, name: id, protocol: "openai", baseUrl: "", apiKey: "", models: [], defaultModel: "" };
}

function candidateProvider(candidate: ProviderCandidate): Provider {
  return {
    ...candidate,
    apiKey: candidate.apiKey ?? "",
    models: candidate.models.map((id) => ({ id })),
    defaultModel: candidate.defaultModel ?? candidate.models[0] ?? "",
  };
}


function addPlan(plans: Map<string, FileChange>, change: FileChange): void {
  const file = path.resolve(change.file);
  const previous = plans.get(file);
  if (previous && (previous.before !== change.before || previous.after !== change.after)) {
    throw new Error(`${file}: conflicting removal plans; no files changed`);
  }
  plans.set(file, { ...change, file });
}

function sameEndpoint(a: string, b: string): boolean {
  return endpointKey(a) === endpointKey(b);
}

function assertIdentity(app: string, stored: Provider, local: { baseUrl?: unknown; protocol?: unknown; apiKey?: unknown }): void {
  const conflict = typeof local.baseUrl === "string" && local.baseUrl && !sameEndpoint(local.baseUrl, stored.baseUrl) ? "endpoint" :
    typeof local.protocol === "string" && local.protocol !== stored.protocol ? "protocol" :
      typeof local.apiKey === "string" && local.apiKey !== stored.apiKey ? "credential" : undefined;
  if (conflict) throw new Error(`${app}: provider "${stored.id}" has a different ${conflict}; use --apps to remove that app-local entry explicitly`);
}

function assertNamedIdentities(target: TargetApp, files: TargetFiles, stored: Provider): void {
  const resolveKey = (raw: unknown): string | undefined => {
    if (typeof raw !== "string") return undefined;
    if (raw.startsWith("!")) return undefined;
    if (raw.startsWith("$")) return process.env[raw.slice(1)];
    const envRef = raw.match(/^\{env:([^}]+)\}$/);
    if (envRef) return process.env[envRef[1]!];
    if (raw.startsWith("{")) return undefined;
    return target.id === "omp" || target.id === "prime" ? process.env[raw] ?? raw : raw;
  };
  for (const { document, at } of files.maps) {
    const entry = providerMap(document, at)[stored.id];
    if (!isJsonObject(entry)) continue;
    let baseUrl: unknown;
    let protocol: unknown;
    let apiKey: unknown;
    if (["omp", "pi", "prime", "dsh"].includes(target.id)) {
      baseUrl = target.id === "dsh" ? entry.baseURL : entry.baseUrl;
      protocol = classifyApi(entryApi(entry))?.protocol;
      apiKey = resolveKey(entry.apiKey);
      if (Array.isArray(entry.models)) {
        for (const model of entry.models) {
          if (!isJsonObject(model)) continue;
          assertIdentity(target.id, stored, { baseUrl: model.baseUrl ?? model.baseURL, protocol: classifyApi(model.api)?.protocol, apiKey: resolveKey(model.apiKey) });
        }
      }
      if (target.id === "dsh" && typeof entry.apiKeyEnv === "string") {
        apiKey = process.env[entry.apiKeyEnv];
        for (const doc of files.documents.values()) {
          if (path.basename(doc.file) === ".credentials.yaml") apiKey ??= valueAt(doc, ["refs", entry.apiKeyEnv]) ?? valueAt(doc, [entry.apiKeyEnv]);
        }
      }
    } else if (target.id === "opencode") {
      const options = isJsonObject(entry.options) ? entry.options : {};
      baseUrl = typeof options.baseURL === "string" && !options.baseURL.startsWith("{") ? options.baseURL : undefined;
      protocol = typeof entry.npm === "string" ? entry.npm.includes("anthropic") ? "anthropic" : entry.npm.includes("openai") ? "openai" : undefined : undefined;
      apiKey = resolveKey(options.apiKey);
    } else if (target.id === "hermes") {
      baseUrl = entry.api;
      protocol = entry.transport === "anthropic_messages" ? "anthropic" : ["chat_completions", "codex_responses"].includes(String(entry.transport)) ? "openai" : undefined;
      if (typeof entry.key_env === "string") {
        apiKey = process.env[entry.key_env];
        for (const [file, text] of files.extras) {
          if (apiKey !== undefined || text === undefined) continue;
          apiKey = envAssignments(file, text).filter((assignment) => assignment.name === entry.key_env).at(-1)?.value;
        }
      }
    } else if (target.id === "codex") {
      baseUrl = entry.base_url;
      protocol = "openai";
      if (typeof entry.env_key === "string") apiKey = process.env[entry.env_key];
      else if (entry.requires_openai_auth === true && valueAt(document, ["model_provider"]) === stored.id) {
        const authFile = path.join(path.dirname(document.file), "auth.json");
        const authText = readText(authFile);
        files.extras.set(authFile, authText);
        if (authText !== undefined) apiKey = valueAt(parseDocument(authFile, authText), ["OPENAI_API_KEY"]);
      }
    }
    assertIdentity(target.id, stored, { baseUrl, protocol, apiKey });
  }
}

function candidatesFor(target: TargetApp): ProviderCandidate[] {
  try { return target.candidates?.() ?? []; }
  catch { throw new Error(`${target.name}: invalid configuration; refusing to modify it`); }
}

function matchingCandidate(target: TargetApp, id: string, stored?: Provider): ProviderCandidate | undefined {
  const candidates = candidatesFor(target);
  if (!candidates.length) return undefined;
  const local = candidates.filter((candidate) => (candidate.localId ?? candidate.id) === id);
  const legacy = local.length ? local : candidates.filter((candidate) => candidate.id === id);
  if (!stored && legacy.length) {
    if (legacy.length !== 1) throw new Error(`${target.name}: ambiguous provider ID; use an account-qualified ID from list --apps`);
    return legacy[0];
  }
  // Single-endpoint apps have no persisted provider ID. A custom store ID can
  // still select them, but only when both endpoint and credential match.
  if (!stored) {
    const before = readText(configFile);
    if (before !== undefined) {
      const store = parseDocument(configFile, before);
      const providers = providerMap(store, ["providers"]);
      if (Object.hasOwn(providers, id)) stored = providers[id] as Provider;
    }
  }
  if (!stored || typeof stored.baseUrl !== "string") return undefined;
  const matching = (legacy.length ? legacy : candidates).filter((candidate) => candidate.protocol === stored.protocol &&
    sameEndpoint(candidate.baseUrl, stored.baseUrl) && candidate.apiKey === stored.apiKey);
  if (matching.length > 1) throw new Error(`${target.name}: ambiguous provider identity; use an account-qualified ID from list --apps`);
  if (matching.length === 1) return matching[0];
  if (legacy.length) throw new Error(`${target.name}: provider "${id}" has a different account; use --apps with an account-qualified ID`);
  return undefined;
}

/** One row per store ID and per app-local ID, never endpoint or credential values. */
export function listRemovableProviders(apps?: string): Array<{ id: string; app?: string; name?: string }> {
  const rows: Array<{ id: string; app?: string; name?: string }> = [];
  const storeText = apps === undefined ? readText(configFile) : undefined;
  if (storeText !== undefined) {
    const store = parseDocument(configFile, storeText);
    for (const [id, entry] of Object.entries(providerMap(store, ["providers"]))) {
      rows.push({ id, ...(isJsonObject(entry) && typeof entry.name === "string" ? { name: entry.name } : {}) });
    }
  }
  for (const target of apps === undefined ? targets : resolveTargets(apps)) {
    const files = targetFiles(target, true);
    const entries = new Map<string, string | undefined>();
    if (target.id === "claude" || target.id === "workbuddy") {
      for (const candidate of candidatesFor(target)) entries.set(candidate.localId ?? candidate.id, candidate.name);
    } else {
      for (const { document, at } of files.maps) {
        for (const [id, entry] of Object.entries(providerMap(document, at))) {
          const value = entry as RecordValue;
          const name = typeof value.name === "string" ? value.name : typeof value.displayName === "string" ? value.displayName : undefined;
          entries.set(id, name ?? entries.get(id));
        }
      }
    }
    for (const [id, name] of entries) rows.push({ id, app: target.id, ...(name ? { name } : {}) });
  }
  return rows;
}

async function planTargetRemoval(target: TargetApp, id: string, plans: Map<string, FileChange>, stored?: Provider): Promise<boolean> {
  const files = targetFiles(target);
  if (stored) assertNamedIdentities(target, files, stored);
  let found = files.maps.some(({ document, at }) => Object.hasOwn(providerMap(document, at), id));
  if (target.id === "workbuddy") return planWorkbuddyRemoval(target, id, plans, stored);
  if (target.id === "claude") {
    const provider = matchingCandidate(target, id, stored);
    if (!provider) return false;
    found = true;
    await previewPrune(target, candidateProvider(provider), files);
    for (const document of files.refs) removeAt(document, ["env", "ANTHROPIC_API_KEY"]);
  } else if (["omp", "pi", "prime", "codex"].includes(target.id)) {
    await previewPrune(target, namedProvider(id), files);
  }

  const managedKeys = [managedCredentialRef(id), legacyManagedCredentialRef(id)];
  const ownedRefs = new Set<string>();
  for (const { document, at } of files.maps) {
    const entry = providerMap(document, at)[id];
    if (!isJsonObject(entry)) continue;
    const ref = target.id === "hermes" ? entry.key_env : entry.apiKeyEnv;
    if (typeof ref === "string" && isManagedCredentialRef(ref, id)) ownedRefs.add(ref);
    // No explicit reference: older releases may have left an unused managed key.
    else if (ref === undefined) for (const key of managedKeys) ownedRefs.add(key);
  }
  for (const { document, at } of files.maps) {
    const removed = removeAt(document, [...at, id]);
    if (removed && ["opencode", "codex", "hermes", "dsh"].includes(target.id)) removeEmpty(document, at);
    switch (target.id) {
      case "codex":
        clearSelection(document, ["model_provider"], ["model", "model_reasoning_effort"], id);
        if (isJsonObject(document.value.profiles)) {
          for (const name of Object.keys(document.value.profiles)) {
            clearSelection(document, ["profiles", name, "model_provider"], ["model", "model_reasoning_effort"], id);
          }
        }
        break;
      case "opencode":
        for (const key of ["model", "small_model"]) clearModelRefs(document, [key], id);
        for (const key of ["enabled_providers", "disabled_providers"]) {
          const values = document.value[key];
          if (Array.isArray(values) && values.includes(id)) replaceAt(document, [key], values.filter((value) => value !== id));
        }
        for (const key of ["agent", "mode", "command"]) {
          const entries = document.value[key];
          if (!isJsonObject(entries)) continue;
          for (const name of Object.keys(entries)) clearModelRefs(document, [key, name, "model"], id);
        }
        break;
      case "hermes":
        if (clearSelection(document, ["model", "provider"], ["default", "model"], id)) removeEmpty(document, ["model"]);
        break;
      case "dsh":
        if (valueAt(document, ["agent-default-model", "provider"]) === id) removeAt(document, ["agent-default-model"]);
        if (removed) removeEmpty(document, ["llm-pi-ai"]);
        break;
    }
  }
  for (const document of files.refs) {
    if (target.id === "pi" || target.id === "prime" || target.id === "omp") {
      clearSelection(document, ["defaultProvider"], ["defaultModel"], id);
      for (const key of ["model", "defaultModel", "models", "modelRoles", "enabledModels", "recentModels"]) clearModelRefs(document, [key], id);
    }
  }
  for (const managedKey of ownedRefs) {
    if (target.id === "hermes" && found) {
      const stillUsed = files.maps.some(({ document, at }) => Object.entries(providerMap(document, at)).some(([otherId, entry]) =>
        isJsonObject(entry) && (entry.key_env === managedKey || isManagedCredentialRef(managedKey, otherId))));
      if (!stillUsed) {
        for (const [file, before] of files.extras) {
          if (before === undefined) continue;
          const prior = plans.get(path.resolve(file));
          const source = prior?.after ?? before;
          const edits = envAssignments(file, source).filter((assignment) => assignment.name === managedKey)
            .map((assignment) => ({ offset: assignment.start, length: assignment.length, content: "" }));
          const after = applyEdits(source, edits);
          if (after !== source) plans.set(path.resolve(file), { file, before, after, mode: 0o600 });
        }
      }
    }
    if (target.id === "dsh" && found) {
      const stillUsed = files.maps.some(({ document, at }) => Object.entries(providerMap(document, at)).some(([otherId, entry]) =>
        isJsonObject(entry) && (entry.apiKeyEnv === managedKey || isManagedCredentialRef(managedKey, otherId))));
      if (!stillUsed) {
        for (const document of files.documents.values()) {
          if (path.basename(document.file) !== ".credentials.yaml") continue;
          removeAt(document, ["refs", managedKey]);
          removeAt(document, [managedKey]);
        }
      }
    }
  }
  for (const document of files.documents.values()) {
    if (!document.changed) continue;
    addPlan(plans, { file: document.file, before: document.before, after: render(document),
      ...(path.basename(document.file) === ".credentials.yaml" ? { mode: 0o600 } : {}) });
  }
  for (const [file, before] of files.extras) {
    if (!plans.has(path.resolve(file))) addPlan(plans, { file, before, after: before });
  }
  return found;
}

function planWorkbuddyRemoval(target: TargetApp, id: string, plans: Map<string, FileChange>, stored?: Provider): boolean {
  const override = process.env.WORKBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim();
  const dir = override ? expandHome(override) : (process.platform === "win32" ? appDataDir("workbuddy") : path.join(home, ".workbuddy"));
  const file = path.join(dir, "models.json");
  const before = readText(file);
  if (before === undefined) return false;
  let raw: unknown;
  try { raw = JSON.parse(before); } catch { throw new Error(`${file}: invalid configuration; refusing to modify it`); }
  const models = Array.isArray(raw) ? raw : isJsonObject(raw) && Array.isArray(raw.models) ? raw.models : undefined;
  if (!models) throw new Error(`${file}: expected a model array`);
  if (stored) for (const entry of models) {
    if (!isJsonObject(entry) || entry.agentswProviderId !== stored.id) continue;
    assertIdentity(target.id, stored, {
      protocol: "openai",
      baseUrl: typeof entry.url === "string" ? workbuddyBaseUrl(entry.url) : undefined,
      apiKey: entry.apiKey,
    });
  }
  const provider = matchingCandidate(target, id, stored);
  if (!provider) return false;
  const removed = new Set<string>();
  const kept = models.filter((entry: unknown) => {
    if (!isJsonObject(entry) || typeof entry.id !== "string" || typeof entry.url !== "string") return true;
    if (stored && typeof entry.agentswProviderId === "string" && entry.agentswProviderId !== stored.id) return true;
    const endpoint = workbuddyBaseUrl(entry.url);
    if (endpoint === undefined || !sameEndpoint(endpoint, provider.baseUrl) || entry.apiKey !== provider.apiKey ||
        !provider.models.includes(entry.id)) return true;
    removed.add(entry.id);
    return false;
  });
  if (!removed.size) return false;
  for (const entry of kept) if (isJsonObject(entry) && typeof entry.id === "string") removed.delete(entry.id);
  if (Array.isArray(raw)) {
    addPlan(plans, { file, before, after: JSON.stringify(kept, null, 2) + "\n" });
  } else {
    const document = parseDocument(file, before);
    replaceAt(document, ["models"], kept);
    if (Array.isArray(document.value.availableModels)) {
      replaceAt(document, ["availableModels"], document.value.availableModels.filter((model) => typeof model !== "string" || !removed.has(model)));
    }
    addPlan(plans, { file, before, after: render(document) });
  }
  const settingsFile = path.join(dir, "settings.json");
  const settingsText = readText(settingsFile);
  if (settingsText !== undefined) {
    const settings = parseDocument(settingsFile, settingsText);
    if (typeof settings.value.model === "string" && removed.has(settings.value.model)) {
      removeAt(settings, ["model"]);
      addPlan(plans, { file: settingsFile, before: settingsText, after: render(settings) });
    }
  }
  return true;
}

/** Plan every scoped change first; commit performs the single backed-up mutation phase. */
export async function removeProvider(id: string, opts: { apps?: string; prune?: boolean; dryRun?: boolean } = {}): Promise<{ files: string[]; backupDir?: string }> {
  if (opts.apps !== undefined && opts.prune) throw new Error("--apps and --prune cannot be combined");
  if (opts.apps !== undefined && !opts.apps.trim()) throw new Error("--apps must select at least one app");
  const appOnly = opts.apps !== undefined;
  const selected = appOnly || opts.prune ? [...new Set(resolveTargets(opts.apps))] : [];
  if (appOnly && !selected.length) throw new Error("--apps must select at least one app");
  const plans = new Map<string, FileChange>();
  let stored: Provider | undefined;
  let store: ConfigDocument | undefined;
  if (!appOnly) {
    const before = readText(configFile);
    if (before !== undefined) {
      store = parseDocument(configFile, before);
      const providers = providerMap(store, ["providers"]);
      if (Object.hasOwn(providers, id)) stored = providers[id] as Provider;
    }
    if (!stored) throw new Error(`provider "${id}" not found in agentsw store; use --apps for agent-local removal`);
  }
  let found = stored !== undefined;
  for (const target of selected) found = await planTargetRemoval(target, id, plans, stored) || found;
  if (!found) throw new Error(`provider "${id}" not found${appOnly ? " in selected apps" : " in agentsw store or app configurations"}`);
  if (store && stored) {
    removeAt(store, ["providers", id]);
    if (store.value.active === id) removeAt(store, ["active"]);
    addPlan(plans, { file: configFile, before: store.before, after: render(store), mode: 0o600 });
  }
  return commitFileChanges([...plans.values()], { dryRun: opts.dryRun });
}

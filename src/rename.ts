import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { applyEdits, findNodeAtLocation, getNodeValue, parseTree } from "jsonc-parser";
import type { Edit, Node as JsonNode, ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { appDataDir, expandHome, home, localAppDataDir } from "./fsutil.js";
import { isJsonObject, readJsoncObject } from "./jsonc.js";
import { configFile } from "./store.js";
import { commitFileChanges } from "./config-transaction.js";
import type { FileChange } from "./config-transaction.js";
import { endpointKey } from "./import.js";
import { classifyApi, entryApi } from "./targets/wire.js";
import { envAssignments } from "./envfile.js";

type Location = Array<string | number>;
type ObjectValue = Record<string, unknown>;
interface Editor {
  file: string;
  value: unknown;
  changed: boolean;
  set(at: Location, value: string): void;
  move(at: Location, oldKey: string, newKey: string): void;
  render(): string;
}

function readExisting(file: string): string | undefined {
  try { return fs.readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${file}: cannot read configuration`);
  }
}

function get(value: unknown, at: Location): unknown {
  for (const key of at) {
    if (!isJsonObject(value) && !Array.isArray(value)) return undefined;
    value = (value as ObjectValue)[key];
  }
  return value;
}

function object(value: unknown, file: string): ObjectValue {
  if (!isJsonObject(value)) throw new Error(`${file}: expected a configuration mapping`);
  return value;
}

function jsonEditor(file: string, before: string, allowArray = false): Editor {
  const bom = before.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = bom ? before.slice(1) : before;
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { allowTrailingComma: true });
  if (!root || errors.length || (root.type !== "object" && !(allowArray && root.type === "array"))) {
    throw new Error(`${file}: invalid JSONC configuration`);
  }
  if (root.type === "object") {
    if (readJsoncObject(file).text !== before) throw new Error(`${file}: configuration changed since it was read`);
  } else {
    const check = (node: JsonNode): void => {
      const names = new Set<string>();
      for (const child of node.children ?? []) {
        if (node.type === "object") {
          const name = String(child.children?.[0]?.value);
          if (names.has(name)) throw new Error(`${file}: duplicate JSONC property`);
          names.add(name);
        }
        check(child);
      }
    };
    check(root);
  }
  const edits: Edit[] = [];
  return {
    file, value: getNodeValue(root) as unknown, changed: false,
    set(at, next) {
      const node = findNodeAtLocation(root, at);
      if (!node) throw new Error(`${file}: missing configuration reference`);
      edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(next) });
      this.changed = true;
    },
    move(at, oldKey, newKey) {
      const map = findNodeAtLocation(root, at);
      const property = map?.children?.find((node) => node.children?.[0]?.value === oldKey);
      const key = property?.children?.[0];
      if (!key) throw new Error(`${file}: missing provider key`);
      edits.push({ offset: key.offset, length: key.length, content: JSON.stringify(newKey) });
      this.changed = true;
    },
    render() {
      const result = applyEdits(source, edits);
      const errors: ParseError[] = [];
      parseTree(result, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error(`${file}: invalid edited JSONC configuration`);
      return bom + result;
    },
  };
}

function yamlEditor(file: string, before: string): Editor {
  let doc: YAML.Document;
  let value: unknown;
  try {
    doc = YAML.parseDocument(before);
    if (doc.contents === null) doc.contents = doc.createNode({});
    if (doc.errors.length || !YAML.isMap(doc.contents)) throw new Error("invalid YAML mapping");
    value = doc.toJS();
    JSON.stringify(value);
  } catch {
    throw new Error(`${file}: invalid YAML configuration or references`);
  }
  const writableParent = (at: Location): YAML.YAMLMap | YAML.YAMLSeq => {
    let node: unknown = doc.contents;
    for (const key of at) {
      if (!YAML.isMap(node) && !YAML.isSeq(node)) throw new Error(`${file}: invalid configuration mapping`);
      let child: unknown = node.get(key, true);
      // Editing through an alias must not mutate an unrelated template/provider.
      if (YAML.isAlias(child)) {
        const expanded = doc.createNode(child.toJS(doc), { aliasDuplicateObjects: false });
        expanded.comment = child.comment;
        expanded.commentBefore = child.commentBefore;
        expanded.spaceBefore = child.spaceBefore;
        node.set(key, expanded);
        child = expanded;
      }
      node = child;
    }
    if (!YAML.isMap(node) && !YAML.isSeq(node)) throw new Error(`${file}: invalid configuration mapping`);
    return node;
  };
  return {
    file, value, changed: false,
    set(at, next) {
      const parent = writableParent(at.slice(0, -1));
      const key = at.at(-1)!;
      const node: unknown = parent.get(key, true);
      if (YAML.isScalar(node)) node.value = next;
      else {
        const replacement = doc.createNode(next);
        if (YAML.isNode(node)) {
          replacement.comment = node.comment;
          replacement.commentBefore = node.commentBefore;
        }
        parent.set(key, replacement);
      }
      this.changed = true;
    },
    move(at, oldKey, newKey) {
      // Rename the Pair's key in place: preserve value, comments, anchors and position.
      const parent = writableParent(at);
      if (!YAML.isMap(parent)) throw new Error(`${file}: expected provider mapping`);
      const pair = parent.items.find((entry) => {
        const key = YAML.isAlias(entry.key) ? entry.key.resolve(doc) : entry.key;
        return YAML.isScalar(key) ? key.value === oldKey : key === oldKey;
      });
      if (!pair) throw new Error(`${file}: missing provider key`);
      if (YAML.isScalar(pair.key)) pair.key.value = newKey;
      else pair.key = doc.createNode(newKey);
      this.changed = true;
    },
    render() {
      try {
        const text = doc.toString();
        const parsed = YAML.parseDocument(text);
        if (parsed.errors.length) throw new Error("invalid YAML");
        JSON.stringify(parsed.toJS());
        return text;
      } catch {
        throw new Error(`${file}: invalid edited YAML configuration or references`);
      }
    },
  };
}

function tomlEditor(file: string, before: string): Editor {
  let value: ObjectValue;
  try { value = parseToml(before) as ObjectValue; } catch { throw new Error(`${file}: invalid TOML configuration`); }
  return {
    file, value, changed: false,
    set(at, next) {
      const parent = object(get(value, at.slice(0, -1)), file);
      parent[String(at.at(-1))] = next;
      this.changed = true;
    },
    move(at, oldKey, newKey) {
      const parent = object(get(value, at), file);
      Object.defineProperty(parent, newKey, { value: parent[oldKey], enumerable: true, writable: true, configurable: true });
      delete parent[oldKey];
      this.changed = true;
    },
    render() {
      try { return stringifyToml(value) + "\n"; } catch { throw new Error(`${file}: cannot serialize TOML configuration`); }
    },
  };
}


const managedKey = (id: string): string => `AGENTSW_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

/** Explicit provider ID migration; never recreates providers or edits session history. */
export async function renameProvider(
  oldId: string,
  newId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ files: string[]; backupDir?: string }> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(newId)) throw new Error("new provider ID must be a lowercase slug (letters, digits, hyphens or underscores)");
  const beforeStore = readExisting(configFile);
  if (beforeStore === undefined) throw new Error(`${configFile}: provider store does not exist`);
  const store = jsonEditor(configFile, beforeStore);
  const providers = object(get(store.value, ["providers"]), configFile);
  if (!Object.hasOwn(providers, oldId)) throw new Error(`${configFile}: source provider does not exist`);
  if (oldId === newId) return { files: [] };
  if (Object.hasOwn(providers, newId)) throw new Error(`${configFile}: destination provider ID already exists`);
  const provider = object(providers[oldId], configFile);
  const changes: FileChange[] = [];
  const visited = new Set<string>();
  const oldKey = managedKey(oldId);
  const newKey = managedKey(newId);

  const assertConnection = (editor: Editor, entry: ObjectValue): void => {
    const options = isJsonObject(entry.options) ? entry.options : {};
    const endpoint = entry.baseUrl ?? entry.baseURL ?? entry.base_url ?? options.baseURL ?? (entry.transport ? entry.api : undefined);
    if (typeof endpoint === "string" && /^https?:\/\//i.test(endpoint) && typeof provider.baseUrl === "string" && endpointKey(endpoint) !== endpointKey(provider.baseUrl)) {
      throw new Error(`${editor.file}: source provider endpoint conflicts with the store`);
    }
    const protocol = classifyApi(entryApi(entry))?.protocol ??
      (entry.wire_api ? "openai" : entry.transport === "anthropic_messages" ? "anthropic" :
        ["chat_completions", "codex_responses"].includes(String(entry.transport)) ? "openai" :
          typeof entry.npm === "string" && entry.npm.includes("anthropic") ? "anthropic" :
            typeof entry.npm === "string" && entry.npm.includes("openai") ? "openai" : undefined);
    if (protocol && provider.protocol && protocol !== provider.protocol) throw new Error(`${editor.file}: source provider protocol conflicts with the store`);
    const rawKey = entry.apiKey ?? options.apiKey;
    if (typeof rawKey === "string" && rawKey) {
      const ref = rawKey.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? rawKey.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
      // Command/file references remain unresolved; no shell execution or secret-file reads.
      const key = ref ? process.env[ref] : /^(?:!|\{file:)/.test(rawKey) ? undefined : /^[A-Z][A-Z0-9_]*$/.test(rawKey) ? process.env[rawKey] : rawKey;
      if (key !== undefined && typeof provider.apiKey === "string" && key !== provider.apiKey) throw new Error(`${editor.file}: source provider credentials conflict with the store`);
    }
  };

  const exact = (editor: Editor, at: Location, oldValue = oldId, newValue = newId): void => {
    if (get(editor.value, at) === oldValue) editor.set(at, newValue);
  };
  const compound = (editor: Editor, at: Location): void => {
    const value = get(editor.value, at);
    if (typeof value === "string" && value.startsWith(`${oldId}/`)) editor.set(at, newId + value.slice(oldId.length));
  };
  const entries = (editor: Editor, at: Location): Array<[string, unknown]> => {
    const value = get(editor.value, at);
    return value === undefined ? [] : Object.entries(object(value, editor.file));
  };
  const renameMap = (editor: Editor, at: Location, names = ["id", "name"]): void => {
    const map = get(editor.value, at);
    if (map === undefined) return;
    const entries = object(map, editor.file);
    if (Object.hasOwn(entries, newId)) throw new Error(`${editor.file}: destination provider ID already exists`);
    if (!Object.hasOwn(entries, oldId)) return;
    assertConnection(editor, object(entries[oldId], editor.file));
    for (const key of names) exact(editor, [...at, oldId, key]);
    editor.move(at, oldId, newId);
  };
  const finish = (editor: Editor, before: string, mode?: number): void => {
    changes.push({ file: editor.file, before, after: editor.changed ? editor.render() : before, mode });
  };
  const visit = (file: string, format: "json" | "yaml" | "toml", edit: (editor: Editor) => void, mode?: number, allowArray = false): void => {
    file = path.resolve(file);
    if (visited.has(file)) return;
    visited.add(file);
    const before = readExisting(file);
    if (before === undefined) {
      changes.push({ file, before, after: undefined });
      return;
    }
    const editor = format === "yaml" ? yamlEditor(file, before) : format === "toml" ? tomlEditor(file, before) : jsonEditor(file, before, allowArray);
    edit(editor);
    finish(editor, before, mode);
  };

  exact(store, ["providers", oldId, "id"]);
  exact(store, ["providers", oldId, "name"]);
  store.move(["providers"], oldId, newId);
  exact(store, ["active"]);
  finish(store, beforeStore, 0o600);

  visit(path.join(home, ".codex", "config.toml"), "toml", (editor) => {
    const entry = get(editor.value, ["model_providers", oldId]);
    if (isJsonObject(entry)) {
      let key = typeof entry.env_key === "string" ? process.env[entry.env_key] : undefined;
      if (!entry.env_key && entry.requires_openai_auth && get(editor.value, ["model_provider"]) === oldId) {
        const authFile = path.join(home, ".codex", "auth.json");
        const authText = readExisting(authFile);
        changes.push({ file: authFile, before: authText, after: authText });
        if (authText !== undefined) {
          const auth = jsonEditor(authFile, authText);
          const value = get(auth.value, ["OPENAI_API_KEY"]);
          if (typeof value === "string") key = value;
        }
      }
      if (key !== undefined && provider.apiKey !== undefined && key !== provider.apiKey) throw new Error(`${editor.file}: source provider credentials conflict with the store`);
    }
    exact(editor, ["model_provider"]);
    for (const [profile] of entries(editor, ["profiles"])) exact(editor, ["profiles", profile, "model_provider"]);
    renameMap(editor, ["model_providers"]);
  });

  const ompDir = path.join(home, ".omp", "agent");
  for (const name of ["models.yml", "models.yaml"]) visit(path.join(ompDir, name), "yaml", (editor) => renameMap(editor, ["providers"]));
  for (const name of ["config.yml", "config.yaml"]) visit(path.join(ompDir, name), "yaml", (editor) => {
    compound(editor, ["model"]);
    for (const [role] of entries(editor, ["modelRoles"])) compound(editor, ["modelRoles", role]);
  });

  for (const [env, fallback] of [["PI_CODING_AGENT_DIR", ".pi/agent"], ["PRIME_AGENT_CODING_AGENT_DIR", ".prime/agent"]] as const) {
    const dir = process.env[env] ? expandHome(process.env[env]!) : path.join(home, fallback);
    visit(path.join(dir, "models.json"), "json", (editor) => renameMap(editor, ["providers"]));
    visit(path.join(dir, "settings.json"), "json", (editor) => {
      exact(editor, ["defaultProvider"]);
      const recent = get(editor.value, ["recentModels"]);
      if (Array.isArray(recent)) recent.forEach((item, index) => {
        if (typeof item === "string") compound(editor, ["recentModels", index]);
        else exact(editor, ["recentModels", index, "provider"]);
      });
    });
  }

  const opencodeFiles = new Set(["config.json", "opencode.json", "opencode.jsonc"].map((name) => path.join(appDataDir("opencode"), name)));
  const customOpenCode = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (customOpenCode) for (const name of ["opencode.json", "opencode.jsonc"]) opencodeFiles.add(path.join(expandHome(customOpenCode), name));
  const sharedOpenCode = process.env.OPENCODE_CONFIG?.trim();
  if (sharedOpenCode) opencodeFiles.add(expandHome(sharedOpenCode));
  for (const file of opencodeFiles) visit(file, "json", (editor) => {
    renameMap(editor, ["provider"]);
    for (const key of ["model", "small_model"]) compound(editor, [key]);
    for (const key of ["agent", "mode", "command"]) {
      for (const [name] of entries(editor, [key])) compound(editor, [key, name, "model"]);
    }
    for (const key of ["enabled_providers", "disabled_providers"]) {
      const list = get(editor.value, [key]);
      if (list !== undefined && !Array.isArray(list)) throw new Error(`${file}: expected provider list`);
      if (Array.isArray(list)) list.forEach((_value, index) => exact(editor, [key, index]));
    }
  });

  const hermesDir = process.env.HERMES_HOME?.trim() ? expandHome(process.env.HERMES_HOME.trim()) : localAppDataDir("hermes");
  const envFile = path.join(hermesDir, ".env");
  const envBefore = readExisting(envFile);
  const assignments = envBefore === undefined ? [] : envAssignments(envFile, envBefore);
  const envValues = new Map(assignments.map((assignment) => [assignment.name, assignment.value]));
  const migrateEnv = oldKey !== newKey && assignments.some((assignment) => assignment.name === oldKey);
  if (migrateEnv) {
    if (assignments.some((assignment) => assignment.name === newKey) || process.env[newKey] !== undefined) throw new Error(`${envFile}: destination credential reference already exists`);
    if (process.env[oldKey] !== undefined && process.env[oldKey] !== envValues.get(oldKey)) throw new Error(`${envFile}: inherited credential overrides the local definition`);
    const after = applyEdits(envBefore!, assignments.filter((assignment) => assignment.name === oldKey).map((assignment) => ({ offset: assignment.offset, length: oldKey.length, content: newKey })));
    changes.push({ file: envFile, before: envBefore, after, mode: 0o600 });
  }
  if (!migrateEnv) changes.push({ file: envFile, before: envBefore, after: envBefore });
  visit(path.join(hermesDir, "config.yaml"), "yaml", (editor) => {
    const keyRef = get(editor.value, ["providers", oldId, "key_env"]);
    const key = typeof keyRef === "string" ? process.env[keyRef] ?? envValues.get(keyRef) : undefined;
    if (key !== undefined && provider.apiKey !== undefined && key !== provider.apiKey) throw new Error(`${editor.file}: source provider credentials conflict with the store`);
    if (migrateEnv) for (const [id, entry] of entries(editor, ["providers"])) {
      if (get(entry, ["key_env"]) === newKey) throw new Error(`${editor.file}: destination credential reference already exists`);
      exact(editor, ["providers", id, "key_env"], oldKey, newKey);
    }
    renameMap(editor, ["providers"]);
    exact(editor, ["model", "provider"]);
  });

  const dshDir = process.env.DSH_HOME?.trim() ? expandHome(process.env.DSH_HOME.trim()) : localAppDataDir("dsh");
  const credentialFile = path.join(dshDir, ".credentials.yaml");
  let migrateCredential = false;
  let credentialRefs: ObjectValue = {};
  visit(credentialFile, "yaml", (editor) => {
    const version = get(editor.value, ["version"]);
    if (version !== undefined && version !== 1) throw new Error(`${credentialFile}: unsupported credential layout version`);
    const at: Location = version === undefined && get(editor.value, ["refs"]) === undefined ? [] : ["refs"];
    const refs = object(get(editor.value, at), credentialFile);
    credentialRefs = refs;
    if (oldKey === newKey || !Object.hasOwn(refs, oldKey)) return;
    if (Object.hasOwn(refs, newKey) || process.env[newKey] !== undefined) throw new Error(`${credentialFile}: destination credential reference already exists`);
    if (process.env[oldKey] !== undefined && process.env[oldKey] !== refs[oldKey]) throw new Error(`${credentialFile}: inherited credential overrides the local definition`);
    editor.move(at, oldKey, newKey);
    migrateCredential = true;
  }, 0o600);
  for (const name of ["settings.yaml", "settings.yml", "settings.json"]) visit(path.join(dshDir, name), name.endsWith("json") ? "json" : "yaml", (editor) => {
    const keyRef = get(editor.value, ["llm-pi-ai", "providers", oldId, "apiKeyEnv"]);
    const key = typeof keyRef === "string" ? process.env[keyRef] ?? credentialRefs[keyRef] : undefined;
    if (key !== undefined && provider.apiKey !== undefined && key !== provider.apiKey) throw new Error(`${editor.file}: source provider credentials conflict with the store`);
    if (migrateCredential) for (const [id, entry] of entries(editor, ["llm-pi-ai", "providers"])) {
      if (get(entry, ["apiKeyEnv"]) === newKey) throw new Error(`${editor.file}: destination credential reference already exists`);
      exact(editor, ["llm-pi-ai", "providers", id, "apiKeyEnv"], oldKey, newKey);
    }
    renameMap(editor, ["llm-pi-ai", "providers"], ["id", "displayName"]);
    exact(editor, ["agent-default-model", "provider"]);
  });

  const workbuddyEnv = process.env.WORKBUDDY_CONFIG_DIR?.trim() ?? process.env.CODEBUDDY_CONFIG_DIR?.trim();
  const workbuddyDir = workbuddyEnv ? expandHome(workbuddyEnv) : process.platform === "win32" ? appDataDir("workbuddy") : path.join(home, ".workbuddy");
  visit(path.join(workbuddyDir, "models.json"), "json", (editor) => {
    const at: Location = Array.isArray(editor.value) ? [] : ["models"];
    const rows = get(editor.value, at);
    if (rows === undefined) return;
    if (!Array.isArray(rows)) throw new Error(`${editor.file}: expected WorkBuddy models array`);
    const base = typeof provider.baseUrl === "string" ? provider.baseUrl.replace(/\/+$/, "") : "";
    const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    if (provider.name !== oldId) return;
    rows.forEach((row, index) => {
      if (isJsonObject(row) && row.url === url && row.apiKey === provider.apiKey) exact(editor, [...at, index, "vendor"]);
    });
  }, undefined, true);
  // Claude and WorkBuddy settings contain model IDs, not provider IDs; leave them intact.
  return commitFileChanges(changes, opts);
}

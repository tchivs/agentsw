import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import prompts from "prompts";
import { availableProviderId, providerIdFromBaseUrl, providerNameFromBaseUrl } from "../src/slug.js";
import type { Protocol, Provider } from "../src/types.js";

// Static command imports would capture the real home before this isolation boundary.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-naming-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
for (const name of ["HERMES_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) delete process.env[name];
const { cmdAdd, cmdQuickAdd, cmdImport } = await import("../src/commands.js");
const { configDir, loadStore, saveStore } = await import("../src/store.js");
const { targets } = await import("../src/targets/index.js");

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
beforeEach((t) => {
  saveStore({ version: 1, providers: {} });
  fs.writeFileSync(path.join(configDir, "models-dev.json"), "{}");
  fs.writeFileSync(path.join(configDir, "ai-gateway.json"), JSON.stringify({
    version: 1, fetchedAt: new Date().toISOString(), body: { data: [] },
  }));
  t.mock.method(console, "log", () => {});
  t.mock.method(process.stderr, "write", () => true);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
});

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "legacy-custom",
    name: "My stable display name",
    protocol: "openai",
    baseUrl: "https://api.eu.example.com/Tenant/v1",
    apiKey: "fixture-account-a",
    models: [{ id: "model-a" }],
    defaultModel: "model-a",
    ...overrides,
  };
}

function seed(...providers: Provider[]): void {
  saveStore({ version: 1, active: providers[0]?.id, providers: Object.fromEntries(providers.map((p) => [p.id, p])) });
}

function mockDiscovery(t: TestContext, protocols: Protocol[]): void {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(input).endsWith("/models"), "discovery must remain fully mocked and catalog must use its fixture");
    const wire = new Headers(init?.headers).has("x-api-key") ? "anthropic" : "openai";
    return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: protocols.includes(wire) ? 200 : 401 });
  });
}

const addDefaults = {
  protocol: "openai",
  baseUrl: "https://API.EU.Example.COM/Tenant/v1/",
  apiKey: "fixture-account-a",
  models: "model-a",
  yes: true,
};

test("generated IDs retain every hostname label and append the protocol", () => {
  for (const protocol of ["openai", "anthropic"] as const) {
    assert.equal(providerIdFromBaseUrl("https://WWW.API.EU.Example.COM:8443/Tenant/v1", protocol), `www-api-eu-example-com-${protocol}`);
    assert.equal(providerIdFromBaseUrl("http://127.0.0.1:8000", protocol), `127-0-0-1-${protocol}`);
    assert.equal(providerIdFromBaseUrl("http://[2001:db8::1]:8000", protocol), `2001-db8-1-${protocol}`);
    assert.equal(providerIdFromBaseUrl("http://custom_host.local", protocol), `custom-host-local-${protocol}`);
    assert.equal(providerIdFromBaseUrl("not a URL", protocol), `imported-${protocol}`);
    assert.equal(providerNameFromBaseUrl("https://API.EU.Example.COM:8443/v1", protocol), `api.eu.example.com (${protocol})`);
  }
});

test("automatic ID allocation skips occupied numeric suffixes without overwriting", () => {
  assert.equal(availableProviderId("api-example-com-openai", {}), "api-example-com-openai");
  assert.equal(availableProviderId("api-example-com-openai", { "api-example-com-openai": {}, "api-example-com-openai-2": {}, "api-example-com-openai-4": {} }), "api-example-com-openai-3");
  assert.equal(availableProviderId("constructor", {}), "constructor", "inherited properties are not configured providers");
});

test("add without --id generates hostname/protocol IDs and display names", async () => {
  for (const protocol of ["openai", "anthropic"] as const) await cmdAdd({ ...addDefaults, protocol });
  const store = loadStore();
  assert.deepEqual(Object.keys(store.providers), ["api-eu-example-com-openai", "api-eu-example-com-anthropic"]);
  assert.equal(store.providers["api-eu-example-com-openai"]!.name, "api.eu.example.com (openai)");
  assert.equal(store.providers["api-eu-example-com-anthropic"]!.name, "api.eu.example.com (anthropic)");
  assert.equal(store.providers["api-eu-example-com-openai"]!.baseUrl, "https://api.eu.example.com/Tenant/v1");
});

test("blank interactive add ID selects automatic naming", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });
  prompts.inject(["", "", "openai", "completions", addDefaults.baseUrl, addDefaults.apiKey, "model-a"]);
  await cmdAdd({});
  assert.equal(loadStore().providers["api-eu-example-com-openai"]!.name, "api.eu.example.com (openai)");
});

test("repeated automatic add and quick reuse legacy IDs and names for the same account", async (t) => {
  const original = provider();
  seed(original);
  await cmdAdd({ ...addDefaults, baseUrl: "https://API.EU.EXAMPLE.COM/Tenant/" });
  mockDiscovery(t, ["openai"]);
  await cmdQuickAdd({ baseUrl: addDefaults.baseUrl, apiKey: addDefaults.apiKey, yes: true });
  const store = loadStore();
  assert.deepEqual(Object.keys(store.providers), [original.id]);
  assert.equal(store.providers[original.id]!.name, original.name);
  assert.equal(store.active, original.id);
});

test("automatic add separates keys and never overwrites endpoint or numeric collisions", async () => {
  const occupied = provider({ id: "api-eu-example-com-openai", baseUrl: "https://unrelated.example/v1" });
  const second = provider({ id: "api-eu-example-com-openai-2", apiKey: "another-account" });
  seed(occupied, second);
  await cmdAdd(addDefaults);
  await cmdAdd({ ...addDefaults, baseUrl: "https://api.eu.example.com/Tenant" });
  await cmdAdd({ ...addDefaults, apiKey: "fixture-account-b" });
  const store = loadStore();
  assert.equal(Object.keys(store.providers).length, 4);
  assert.deepEqual(store.providers[occupied.id], occupied);
  assert.deepEqual(store.providers[second.id], second);
  assert.equal(store.providers["api-eu-example-com-openai-3"]!.apiKey, addDefaults.apiKey);
  assert.equal(store.providers["api-eu-example-com-openai-4"]!.apiKey, "fixture-account-b");
});

test("automatic add does not collapse case-sensitive paths, ports, or unresolved stored keys", async () => {
  seed(provider({ id: "api-eu-example-com-openai", apiKey: "" }));
  await cmdAdd(addDefaults);
  await cmdAdd({ ...addDefaults, baseUrl: "https://api.eu.example.com/tenant/v1" });
  await cmdAdd({ ...addDefaults, baseUrl: "https://api.eu.example.com:8443/Tenant/v1" });
  assert.equal(Object.keys(loadStore().providers).length, 4);
});

test("explicit add ID and name retain in-place update semantics without a protocol suffix", async () => {
  seed(provider({ id: "chosen-id" }));
  await cmdAdd({ ...addDefaults, id: "chosen-id", name: "Explicit label", protocol: "anthropic", baseUrl: "https://other.example/v1" });
  const store = loadStore();
  assert.deepEqual(Object.keys(store.providers), ["chosen-id"]);
  assert.equal(store.providers["chosen-id"]!.name, "Explicit label");
  assert.equal(store.providers["chosen-id"]!.protocol, "anthropic");
});

test("quick autogenerated IDs include a protocol for both single- and dual-protocol endpoints", async (t) => {
  mockDiscovery(t, ["openai"]);
  await cmdQuickAdd({ baseUrl: addDefaults.baseUrl, apiKey: addDefaults.apiKey, yes: true });
  assert.deepEqual(Object.keys(loadStore().providers), ["api-eu-example-com-openai"]);
  mockDiscovery(t, ["openai", "anthropic"]);
  await cmdQuickAdd({ baseUrl: addDefaults.baseUrl, apiKey: addDefaults.apiKey, yes: true });
  const store = loadStore();
  assert.deepEqual(Object.keys(store.providers), ["api-eu-example-com-openai", "api-eu-example-com-anthropic"]);
  assert.equal(store.providers["api-eu-example-com-openai"]!.name, "api.eu.example.com (openai)");
  assert.equal(store.providers["api-eu-example-com-anthropic"]!.name, "api.eu.example.com (anthropic)");
});

test("quick explicit IDs only gain protocol suffixes when both protocols are detected", async (t) => {
  mockDiscovery(t, ["openai"]);
  await cmdQuickAdd({ id: "chosen", baseUrl: addDefaults.baseUrl, apiKey: addDefaults.apiKey, yes: true });
  assert.equal(loadStore().providers.chosen!.name, "chosen");
  mockDiscovery(t, ["openai", "anthropic"]);
  await cmdQuickAdd({ id: "chosen", baseUrl: addDefaults.baseUrl, apiKey: addDefaults.apiKey, yes: true });
  const store = loadStore();
  assert.deepEqual(Object.keys(store.providers), ["chosen", "chosen-openai", "chosen-anthropic"]);
  assert.equal(store.providers["chosen-openai"]!.name, "chosen (openai)");
  assert.equal(store.providers["chosen-anthropic"]!.name, "chosen (anthropic)");
});

test("quick automatic collisions allocate safely and repeat calls reuse the account", async (t) => {
  mockDiscovery(t, ["openai"]);
  const occupied = provider({ id: "api-eu-example-com-openai", apiKey: "other-account" });
  seed(occupied);
  await cmdQuickAdd({ baseUrl: addDefaults.baseUrl, apiKey: addDefaults.apiKey, yes: true });
  await cmdQuickAdd({ baseUrl: addDefaults.baseUrl, apiKey: addDefaults.apiKey, yes: true });
  const store = loadStore();
  assert.deepEqual(Object.keys(store.providers), [occupied.id, "api-eu-example-com-openai-2"]);
  assert.deepEqual(store.providers[occupied.id], occupied);
});

test("import preserves explicit candidate IDs and separates colliding accounts on the same endpoint", async (t) => {
  for (const target of targets) t.mock.method(target, "candidates", () => []);
  t.mock.method(targets[0]!, "candidates", () => [
    { id: "custom-import", name: "Explicit import name", protocol: "openai", baseUrl: addDefaults.baseUrl, apiKey: addDefaults.apiKey, models: ["model-a"], source: "fixture" },
    { id: "custom-import", name: "Second account", protocol: "openai", baseUrl: addDefaults.baseUrl, apiKey: "fixture-account-b", models: ["model-b"], source: "fixture" },
  ]);
  await cmdImport({ all: true });
  await cmdImport({ all: true });
  const store = loadStore();
  assert.deepEqual(Object.keys(store.providers), ["custom-import", "custom-import-2"]);
  assert.equal(store.providers["custom-import"]!.name, "Explicit import name");
  assert.equal(store.providers["custom-import-2"]!.name, "Second account");
});

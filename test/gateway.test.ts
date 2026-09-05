import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-gateway-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
for (const name of ["HERMES_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) delete process.env[name];
const { loadGatewayCatalog, parseGatewayCatalog } = await import("../src/gateway.js");
const { setDryRun, drainPendingWrites } = await import("../src/fsutil.js");
const { configDir } = await import("../src/store.js");
const cacheFile = path.join(configDir, "ai-gateway.json");
const now = Date.parse("2026-08-10T12:00:00.000Z");
const fetchedAt = new Date(now).toISOString();
const day = 24 * 60 * 60 * 1000;
const model = { id: "vendor/model", type: "language", name: "Example", context_window: 100_000, max_tokens: 8_000 };
const body = { object: "list", data: [model] };
let warnings: string[] = [];

function writeCache(cachedBody: unknown = body, timestamp = fetchedAt): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, fetchedAt: timestamp, body: cachedBody }));
}

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
afterEach(() => setDryRun(false));
beforeEach((t) => {
  setDryRun(false);
  fs.rmSync(path.join(sandbox, ".config"), { recursive: true, force: true });
  warnings = [];
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  t.mock.method(process.stderr, "write", (message: string | Uint8Array) => {
    warnings.push(String(message));
    return true;
  });
});

test("maps explicit capabilities and USD/token prices without changing routing or effective prices", () => {
  const catalog = parseGatewayCatalog({ data: [{
    ...model, modalities: { input: ["text", "image"], output: ["text"] }, tags: ["reasoning", "tool-use"],
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high"] }],
    pricing: { input: "0.000002", output: 0.000008, cachedInputTokens: "0", cacheCreationInputTokens: "0.000001", varies_by_provider: true },
    supported_specifications: ["v2", "v3", "v4"], provider: "not-the-provider", protocol: "anthropic", api: "responses", cost: { input: 999 },
  }] }, fetchedAt);
  assert.equal(catalog.fetchedAt, fetchedAt);
  assert.deepEqual(catalog.models[model.id], {
    id: model.id,
    spec: { id: model.id, name: "Example", contextWindow: 100_000, maxOutput: 8_000, reasoning: true, reasoningEfforts: ["none", "low", "medium", "high"], imageInput: true },
    referenceCost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 1 }, pricingIsVariable: true,
  });
});

test("preserves case-sensitive qualified identities and skips invalid and nonlanguage rows", () => {
  const data = [
    { id: "Vendor/Model", type: "language" }, { id: "vendor/model", type: "language" },
    { id: "vendor/image", type: "image" }, { id: "vendor/embed", type: "embedding" },
    { id: "vendor/unknown" }, { id: "vendor/other", type: "Language" },
    { id: "model", type: "language" }, { id: " vendor/model", type: "language" },
    { id: "vendor/", type: "language" }, { id: "/model", type: "language" },
    { id: "vendor//model", type: "language" }, { id: 5, type: "language" }, null, [], "bad",
  ];
  const catalog = parseGatewayCatalog({ data }, fetchedAt);
  assert.deepEqual(Object.keys(catalog.models), ["Vendor/Model", "vendor/model"]);
  assert.deepEqual(catalog.models["Vendor/Model"], { id: "Vendor/Model", spec: { id: "Vendor/Model" } });
});

test("rejects malformed roots and duplicate identities including conflicting types", () => {
  for (const invalid of [null, undefined, [], "bad", {}, { data: null }, { data: {} }]) {
    assert.throws(() => parseGatewayCatalog(invalid, fetchedAt), /Invalid AI Gateway catalog/);
  }
  for (const duplicate of [{ ...model }, { ...model, type: "embedding" }, { ...model, context_window: 10 }]) {
    assert.throws(() => parseGatewayCatalog({ data: [model, duplicate] }, fetchedAt), /Duplicate AI Gateway model identity/);
  }
  assert.equal(Object.keys(parseGatewayCatalog({ data: [] }, fetchedAt).models).length, 0);
});

test("drops invalid optional values without inventing missing capabilities", () => {
  const parsed = parseGatewayCatalog({ data: [{
    id: model.id, type: "language", name: " ", context_window: "100000", max_tokens: -1,
    reasoning: true, tags: ["vision", "tool-use", "not-reasoning"], modalities: { input: ["image", null], output: ["image"] },
    reasoning_options: [{ type: "effort", values: ["low", "invented"] }],
    pricing: { input: "", output: -1, cachedInputTokens: "Infinity", cacheCreationInputTokens: true, varies_by_provider: "true" },
  }] }, fetchedAt);
  assert.deepEqual(parsed.models[model.id], { id: model.id, spec: { id: model.id } });
  const missing = parseGatewayCatalog({ data: [{ id: model.id, type: "language" }] }, fetchedAt).models[model.id]!;
  assert.deepEqual(missing, { id: model.id, spec: { id: model.id } });
});

test("requires positive safe-integer limits and drops both inconsistent bounds", () => {
  for (const invalid of [0, -1, 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1024", null]) {
    const spec = parseGatewayCatalog({ data: [{ ...model, context_window: invalid, max_tokens: invalid }] }, fetchedAt).models[model.id]!.spec;
    assert.equal(Object.hasOwn(spec, "contextWindow"), false);
    assert.equal(Object.hasOwn(spec, "maxOutput"), false);
  }
  const inconsistent = parseGatewayCatalog({ data: [{ ...model, context_window: 100, max_tokens: 101 }] }, fetchedAt).models[model.id]!.spec;
  assert.deepEqual(inconsistent, { id: model.id, name: model.name });
  const equal = parseGatewayCatalog({ data: [{ ...model, context_window: 100, max_tokens: 100 }] }, fetchedAt).models[model.id]!.spec;
  assert.equal(equal.contextWindow, 100);
  assert.equal(equal.maxOutput, 100);
  const independent = parseGatewayCatalog({ data: [{ ...model, context_window: undefined }] }, fetchedAt).models[model.id]!.spec;
  assert.equal(independent.maxOutput, 8_000);
  assert.equal(Object.hasOwn(independent, "maxInput"), false);
});

test("only explicit valid input modalities establish image input", () => {
  for (const input of [undefined, [], "image", ["image", 1], [""]]) {
    const spec = parseGatewayCatalog({ data: [{ ...model, tags: ["vision"], modalities: { input, output: ["image"] } }] }, fetchedAt).models[model.id]!.spec;
    assert.equal(Object.hasOwn(spec, "imageInput"), false);
  }
  assert.equal(parseGatewayCatalog({ data: [{ ...model, modalities: { input: ["text"] } }] }, fetchedAt).models[model.id]!.spec.imageInput, false);
  assert.equal(parseGatewayCatalog({ data: [{ ...model, modalities: { input: ["image"] } }] }, fetchedAt).models[model.id]!.spec.imageInput, true);
});

test("validates reasoning efforts and trusts only the explicit reasoning tag", () => {
  const values = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const efforts = parseGatewayCatalog({ data: [{ ...model, reasoning_options: [{ type: "effort", values: [...values, "high"] }] }] }, fetchedAt).models[model.id]!.spec;
  assert.deepEqual(efforts.reasoningEfforts, values);
  assert.equal(efforts.reasoning, true);
  for (const options of [
    undefined, {}, [{ type: "budget", values: ["low"] }], [{ type: "effort", values: [] }],
    [{ type: "effort", values: ["HIGH"] }], [{ type: "effort", values: ["toString"] }],
    [{ type: "effort", values: ["low", 2] }], [{ type: "effort", values: "high" }],
    [{ type: "effort", values: ["low"] }, { type: "effort", values: ["high"] }],
  ]) {
    const spec = parseGatewayCatalog({ data: [{ ...model, reasoning_options: options, tags: ["thinking", "Reasoning"] }] }, fetchedAt).models[model.id]!.spec;
    assert.equal(Object.hasOwn(spec, "reasoningEfforts"), false);
    assert.equal(Object.hasOwn(spec, "reasoning"), false);
  }
  assert.equal(parseGatewayCatalog({ data: [{ ...model, tags: ["reasoning"] }] }, fetchedAt).models[model.id]!.spec.reasoning, true);
  const noneOnly = parseGatewayCatalog({ data: [{ ...model, reasoning_options: [{ type: "effort", values: ["none"] }] }] }, fetchedAt).models[model.id]!.spec;
  assert.deepEqual(noneOnly.reasoningEfforts, ["none"]);
  assert.equal(Object.hasOwn(noneOnly, "reasoning"), false);
});

test("validates individual reference prices including zero, scientific notation and overflow", () => {
  const valid = parseGatewayCatalog({ data: [{ ...model, pricing: { input: 0, output: "2e-6", cachedInputTokens: "0.000003" } }] }, fetchedAt).models[model.id]!;
  assert.deepEqual(valid.referenceCost, { input: 0, output: 2, cacheRead: 3 });
  for (const invalid of [null, true, [], {}, " ", "0x10", "NaN", "Infinity", "-0.1", -1, NaN, Infinity, 1e308]) {
    const parsed = parseGatewayCatalog({ data: [{ ...model, pricing: { input: invalid, output: "0.000001" } }] }, fetchedAt).models[model.id]!;
    assert.deepEqual(parsed.referenceCost, { output: 1 });
    assert.equal(Object.hasOwn(parsed.spec, "cost"), false);
  }
});

test("flags tiered and variable prices without making them effective provider prices", () => {
  for (const pricing of [
    { input: "0.000001", varies_by_provider: true },
    { input: "0.000001", varies_by_provider: false, inputTiers: [{ min: 200_000, cost: "0.000002" }] },
    { input: "0.000001", outputTiers: [{ min: 200_000, cost: "0.000003" }] },
  ]) {
    const parsed = parseGatewayCatalog({ data: [{ ...model, pricing }] }, fetchedAt).models[model.id]!;
    assert.equal(parsed.pricingIsVariable, true);
    assert.deepEqual(parsed.referenceCost, { input: 1 });
    assert.equal(Object.hasOwn(parsed.spec, "cost"), false);
  }
  assert.equal(parseGatewayCatalog({ data: [{ ...model, pricing: { varies_by_provider: false } }] }, fetchedAt).models[model.id]!.pricingIsVariable, false);
});

test("fetches the fixed public endpoint without auth and writes a private independent cache", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://ai-gateway.vercel.sh/v1/models");
    assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined);
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json(body);
  });
  const loaded = await loadGatewayCatalog();
  assert.equal(loaded?.models[model.id]?.spec.contextWindow, 100_000);
  assert.equal(loaded?.fetchedAt, fetchedAt);
  assert.equal(fetchMock.mock.callCount(), 1);
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(cache.fetchedAt, fetchedAt);
  assert.deepEqual(cache.body, body);
  assert.deepEqual(fs.readdirSync(configDir), ["ai-gateway.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
});

test("fresh cache uses fetchedAt not mtime and preserves its provenance time", async (t) => {
  const timestamp = new Date(now - day + 1).toISOString();
  writeCache(body, timestamp);
  fs.utimesSync(cacheFile, new Date(0), new Date(0));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must use fresh cache"); });
  assert.equal((await loadGatewayCatalog())?.fetchedAt, timestamp);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(warnings, []);
});

test("refresh bypasses a fresh cache and enforces private replacement permissions", async (t) => {
  writeCache({ data: [{ ...model, name: "Old" }] }, new Date(now - 1000).toISOString());
  fs.chmodSync(cacheFile, 0o644);
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const loaded = await loadGatewayCatalog({ refresh: true });
  assert.equal(loaded?.models[model.id]?.spec.name, "Example");
  assert.equal(loaded?.fetchedAt, fetchedAt);
  if (process.platform !== "win32") assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
});

test("expires cache exactly at 24 hours even with a new mtime", async (t) => {
  writeCache({ data: [{ ...model, name: "Old" }] }, new Date(now - day).toISOString());
  fs.utimesSync(cacheFile, new Date(now), new Date(now));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(body));
  assert.equal((await loadGatewayCatalog())?.models[model.id]?.spec.name, "Example");
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("offline never fetches even with refresh, and stale cache remains unchanged", async (t) => {
  const timestamp = new Date(now - 7 * day).toISOString();
  writeCache(body, timestamp);
  const original = fs.readFileSync(cacheFile, "utf8");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Offline must never fetch"); });
  assert.equal((await loadGatewayCatalog({ offline: true, refresh: true }))?.fetchedAt, timestamp);
  assert.equal(fs.readFileSync(cacheFile, "utf8"), original);
  fs.rmSync(cacheFile);
  assert.equal(await loadGatewayCatalog({ offline: true }), undefined);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("rejects corrupt, wrong-schema, invalid-time and future caches offline", async () => {
  fs.mkdirSync(configDir, { recursive: true });
  for (const invalid of [
    "{", "null", JSON.stringify(body), JSON.stringify({ version: 2, fetchedAt, body }),
    JSON.stringify({ version: 1, fetchedAt: "invalid", body }),
    JSON.stringify({ version: 1, fetchedAt: new Date(now + 1).toISOString(), body }),
    JSON.stringify({ version: 1, fetchedAt: "2026-08-10", body }),
    JSON.stringify({ version: 1, fetchedAt, body: { data: {} } }),
    JSON.stringify({ version: 1, fetchedAt, body: { data: [model, model] } }),
    JSON.stringify({ version: 1, fetchedAt, models: { [model.id]: { spec: { ...model, cost: { input: 99 } } } } }),
  ]) {
    fs.writeFileSync(cacheFile, invalid);
    assert.equal(await loadGatewayCatalog({ offline: true, refresh: true }), undefined);
    assert.equal(fs.readFileSync(cacheFile, "utf8"), invalid);
  }
  fs.rmSync(cacheFile);
  fs.mkdirSync(cacheFile);
  assert.equal(await loadGatewayCatalog({ offline: true }), undefined);
});

test("recovers from bad cache online and degrades safely without any cache", async (t) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(cacheFile, "broken JSON");
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  assert.equal((await loadGatewayCatalog())?.models[model.id]?.spec.name, "Example");
  fs.rmSync(cacheFile);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("PRIVATE upstream failure"); });
  assert.equal(await loadGatewayCatalog(), undefined);
  assert.equal(fs.existsSync(cacheFile), false);
  assert.match(warnings.join(""), /could not load AI Gateway metadata/);
  assert.doesNotMatch(warnings.join(""), /PRIVATE/);
});

test("network, HTTP, JSON, root and duplicate failures preserve stale data without leaking errors", async (t) => {
  const timestamp = new Date(now - 2 * day).toISOString();
  writeCache(body, timestamp);
  const original = fs.readFileSync(cacheFile, "utf8");
  for (const fail of [
    async () => { throw new Error("PRIVATE upstream error"); },
    async () => new Response("PRIVATE provider body", { status: 500 }),
    async () => new Response("PRIVATE invalid JSON"),
    async () => Response.json({ data: "PRIVATE malformed root" }),
    async () => Response.json({ data: [model, model] }),
    async () => new Response(null, { status: 204 }),
  ]) {
    t.mock.method(globalThis, "fetch", fail);
    const loaded = await loadGatewayCatalog();
    assert.equal(loaded?.fetchedAt, timestamp);
    assert.equal(loaded?.models[model.id]?.spec.name, "Example");
    assert.equal(fs.readFileSync(cacheFile, "utf8"), original);
  }
  assert.match(warnings.join(""), /using cached metadata/);
  assert.doesNotMatch(warnings.join(""), /PRIVATE/);
});

test("successful fresh metadata stays usable when cache writing fails", async (t) => {
  fs.mkdirSync(cacheFile, { recursive: true });
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const loaded = await loadGatewayCatalog();
  assert.equal(loaded?.models[model.id]?.spec.name, "Example");
  assert.equal(loaded?.fetchedAt, fetchedAt);
  assert.match(warnings.join(""), /could not cache AI Gateway metadata/);
  assert.equal(fs.statSync(cacheFile).isDirectory(), true);
});

test("bounds response Content-Length and actual streamed bytes", async (t) => {
  const timestamp = new Date(now - 2 * day).toISOString();
  writeCache(body, timestamp);
  let canceled = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { canceled++; },
  }), { headers: { "content-length": String(5 * 1024 * 1024 + 1) } }));
  assert.equal((await loadGatewayCatalog())?.fetchedAt, timestamp);
  assert.equal(canceled, 1);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3 * 1024 * 1024));
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
    cancel() { canceled++; },
  }), { headers: { "content-length": "1" } }));
  assert.equal((await loadGatewayCatalog())?.fetchedAt, timestamp);
  assert.equal(canceled, 2);
  assert.match(warnings.join(""), /using cached metadata/);
});

test("uses a bounded timeout signal and degrades on abort", async (t) => {
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 15_000);
    return AbortSignal.abort(new DOMException("PRIVATE timeout detail", "TimeoutError"));
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    throw new Error("Expected an aborted timeout signal");
  });
  assert.equal(await loadGatewayCatalog(), undefined);
  assert.doesNotMatch(warnings.join(""), /PRIVATE/);
});

test("dry-run returns fetched metadata without creating cache, backups or directories", async (t) => {
  setDryRun(true);
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  assert.equal((await loadGatewayCatalog({ refresh: true }))?.models[model.id]?.spec.name, "Example");
  assert.deepEqual(fs.readdirSync(sandbox), []);
  const writes = drainPendingWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.file, cacheFile);
});

test("dry-run leaves existing stale cache contents and permissions unchanged", async (t) => {
  writeCache({ data: [{ ...model, name: "Old" }] }, new Date(now - 2 * day).toISOString());
  fs.chmodSync(cacheFile, 0o644);
  const original = fs.readFileSync(cacheFile, "utf8");
  const mode = fs.statSync(cacheFile).mode;
  setDryRun(true);
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  assert.equal((await loadGatewayCatalog())?.models[model.id]?.spec.name, "Example");
  assert.equal(fs.readFileSync(cacheFile, "utf8"), original);
  assert.equal(fs.statSync(cacheFile).mode, mode);
  assert.deepEqual(fs.readdirSync(configDir), ["ai-gateway.json"]);
});

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Catalog, CatalogModel } from "../src/modelsdev.js";
import type { GatewayCatalog, GatewayModelMetadata } from "../src/gateway.js";
import type { ModelSpec } from "../src/types.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-metadata-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
// Store paths initialize on module load; import only after the isolated home is set.
const { enrichProviderModels, getMetadataMode, resolveMetadataOptions } = await import("../src/metadata.js");
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
beforeEach((t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
});

const fetchedAt = "2026-08-01T00:00:00.000Z";
const laterFetch = "2026-08-02T00:00:00.000Z";
const enabled = { gatewayMetadata: true };
const disabled = { gatewayMetadata: false };
function catalog(model: Partial<CatalogModel>, creator = "creator", id = "model"): Catalog {
  return { [creator]: { id: creator, models: { [id]: { id, ...model } } } };
}
function gateway(spec: Partial<ModelSpec>, extras: Partial<GatewayModelMetadata> = {}, id = "creator/model"): GatewayCatalog {
  return { fetchedAt, models: { [id]: { id, spec: { id, ...spec }, ...extras } } };
}

// Tests use synthetic Gateway catalogs/loaders (or explicit off mode), never live metadata.
test("models.dev is primary, Gateway fills gaps and records conflicts and reference-only prices", async () => {
  const primary = catalog({ name: "Primary", limit: { context: 1000 }, reasoning: false,
    attachment: false, cost: { input: 0, output: 2 } });
  const supplement = gateway({ name: "Supplement", contextWindow: 2000, maxOutput: 100,
    reasoning: true, imageInput: true, cost: { input: 999, output: 999 } }, {
    referenceCost: { input: 0.25, output: 1.5, cacheRead: 0 }, pricingIsVariable: true,
  });
  const [result] = await enrichProviderModels(primary, ["creator/model"], enabled, { gateway: supplement });
  assert.equal(result?.name, "Primary");
  assert.equal(result?.contextWindow, 1000);
  assert.equal(result?.maxOutput, 100);
  assert.equal(result?.reasoning, false);
  assert.equal(result?.imageInput, false);
  assert.deepEqual(result?.cost, { input: 0, output: 2 });
  assert.equal(result?.metadata?.fields?.name?.source, "models.dev");
  assert.equal(result?.metadata?.fields?.name?.modelId, "creator/model");
  assert.equal(result?.metadata?.fields?.maxOutput?.source, "ai-gateway");
  assert.equal(result?.metadata?.fields?.maxOutput?.fetchedAt, fetchedAt);
  assert.deepEqual(result?.metadata?.gateway, { modelId: "creator/model", fetchedAt,
    referenceCost: { input: 0.25, output: 1.5, cacheRead: 0 }, pricingIsVariable: true });
  assert.deepEqual(result?.metadata?.conflicts?.map(({ field, source, value, keptValue }) => ({ field, source, value, keptValue })), [
    { field: "name", source: "ai-gateway", value: "Supplement", keptValue: "Primary" },
    { field: "contextWindow", source: "ai-gateway", value: 2000, keptValue: 1000 },
    { field: "reasoning", source: "ai-gateway", value: true, keptValue: false },
    { field: "imageInput", source: "ai-gateway", value: true, keptValue: false },
  ]);
});

test("untracked values, false, zero, empty arrays and per-cost-leaf overrides remain explicit", async () => {
  const original = { id: "creator/model", name: "User", contextWindow: 0, maxInput: 0, maxOutput: 0,
    reasoning: false, reasoningEfforts: [], imageInput: false,
    cost: { input: 0, output: 7, cacheRead: 0, tier: "custom" }, custom: { route: ["unchanged"] } };
  const [result] = await enrichProviderModels(catalog({ name: "Primary", limit: { context: 1000, input: 500, output: 100 },
    reasoning: true, attachment: true, reasoning_options: [{ type: "effort", values: ["high"] }],
    cost: { input: 8, output: 9, cache_read: 10, cache_write: 2 } }), [original.id], {
    ...enabled, models: [original],
  }, { gateway: gateway({ contextWindow: 3000, reasoning: true, imageInput: true }) });
  assert.equal(result?.name, "User");
  assert.equal(result?.contextWindow, 0);
  assert.equal(result?.maxInput, 0);
  assert.equal(result?.maxOutput, 0);
  assert.equal(result?.reasoning, false);
  assert.equal(result?.imageInput, false);
  assert.deepEqual(result?.reasoningEfforts, []);
  assert.deepEqual(result?.cost, { input: 0, output: 7, cacheRead: 0, cacheWrite: 2, tier: "custom" });
  assert.deepEqual((result as typeof original).custom, original.custom);
  assert.deepEqual(Object.keys(result?.metadata?.fields ?? {}), ["cost.cacheWrite"]);
});

test("unattributed legacy values are never adopted as catalog-owned even when they agree", async () => {
  const legacy: ModelSpec = { id: "model", contextWindow: 100, imageInput: false };
  const [first] = await enrichProviderModels(catalog({ limit: { context: 100 }, attachment: false }), ["model"], { ...disabled, models: [legacy] });
  assert.deepEqual(first, legacy);
  const [second] = await enrichProviderModels(catalog({ limit: { context: 200 }, attachment: true }), ["model"], { ...disabled, models: [first!] });
  assert.equal(second?.contextWindow, 100);
  assert.equal(second?.imageInput, false);
  assert.equal(second?.metadata?.fields, undefined);
  assert.equal(second?.metadata?.conflicts?.length, 2);
});

test("new primary enrichments are attributed with Gateway disabled and can subsequently refresh", async () => {
  const [first] = await enrichProviderModels(catalog({ name: "First", limit: { context: 100 }, attachment: false }), ["model"], disabled);
  assert.equal(first?.metadata?.fields?.contextWindow?.source, "models.dev");
  assert.equal(first?.metadata?.fields?.contextWindow?.modelId, "creator/model");
  assert.equal(first?.imageInput, false);
  const [second] = await enrichProviderModels(catalog({ name: "Second", limit: { context: 200 }, attachment: true }), ["model"], { ...disabled, models: [first!] });
  assert.equal(second?.name, "Second");
  assert.equal(second?.contextWindow, 200);
  assert.equal(second?.imageInput, true);
  assert.equal(second?.metadata?.fields?.contextWindow?.value, 200);
});

test("manual edits detach origins and protect nested cost leaves while other owned fields refresh", async () => {
  const first = await enrichProviderModels(catalog({ name: "First", limit: { context: 100, output: 20 },
    cost: { input: 1, output: 2 }, reasoning_options: [{ type: "effort", values: ["low"] }] }), ["model"], disabled);
  first[0]!.name = "Manual";
  first[0]!.cost!.input = 0;
  first[0]!.reasoningEfforts!.push("custom");
  const [result] = await enrichProviderModels(catalog({ name: "Second", limit: { context: 200, output: 40 },
    cost: { input: 3, output: 4 }, reasoning_options: [{ type: "effort", values: ["high"] }] }), ["model"], { ...disabled, models: first });
  assert.equal(result?.name, "Manual");
  assert.equal(result?.contextWindow, 200);
  assert.equal(result?.maxOutput, 40);
  assert.deepEqual(result?.cost, { input: 0, output: 4 });
  assert.deepEqual(result?.reasoningEfforts, ["low", "custom"]);
  assert.equal(result?.metadata?.fields?.name, undefined);
  assert.equal(result?.metadata?.fields?.["cost.input"], undefined);
  assert.equal(result?.metadata?.fields?.reasoningEfforts, undefined);
  assert.equal(result?.metadata?.fields?.["cost.output"]?.value, 4);
  assert.ok(result?.metadata?.conflicts?.some((entry) => entry.field === "name" && entry.keptValue === "Manual"));
});

test("Gateway refreshes only its unchanged fields and primary data can take ownership", async () => {
  const first = await enrichProviderModels(undefined, ["creator/model"], enabled, {
    gateway: gateway({ name: "Gateway", contextWindow: 100, maxOutput: 20, imageInput: true }),
  });
  first[0]!.maxOutput = 5;
  const [result] = await enrichProviderModels(catalog({ name: "Primary", limit: { context: 300 }, attachment: false }), ["creator/model"], {
    ...enabled, models: first,
  }, { gateway: gateway({ name: "New Gateway", contextWindow: 200, maxOutput: 40, imageInput: true, reasoning: true }) });
  assert.equal(result?.name, "Primary");
  assert.equal(result?.contextWindow, 300);
  assert.equal(result?.maxOutput, 5);
  assert.equal(result?.imageInput, false);
  assert.equal(result?.reasoning, true);
  assert.equal(result?.metadata?.fields?.contextWindow?.source, "models.dev");
  assert.equal(result?.metadata?.fields?.maxOutput, undefined);
  assert.equal(result?.metadata?.fields?.reasoning?.source, "ai-gateway");
});

test("no metadata and missing source fields never erase existing specs or source snapshots", async () => {
  const first = await enrichProviderModels(catalog({ name: "Primary", limit: { context: 100 } }), ["creator/model"], enabled, {
    gateway: gateway({ maxOutput: 20, reasoning: true }),
  });
  assert.deepEqual(await enrichProviderModels(undefined, ["creator/model"], { ...enabled, models: first }, { gateway: null }), first);
  assert.deepEqual(await enrichProviderModels(catalog({}), ["creator/model"], { ...enabled, models: first }, { gateway: gateway({}) }), first);
});

test("new unnamed models accept real catalog names; source ID placeholders do not claim names", async () => {
  const [primary] = await enrichProviderModels(catalog({ name: "Real name" }), ["model"], disabled);
  assert.equal(primary?.name, "Real name");
  const [supplement] = await enrichProviderModels(catalog({ name: "creator/model" }), ["creator/model"], enabled, { gateway: gateway({ name: "Gateway name" }) });
  assert.equal(supplement?.name, "Gateway name");
  const [explicit] = await enrichProviderModels(catalog({ name: "Real name" }), ["model"], { ...disabled, models: [{ id: "model", name: "model" }] });
  assert.equal(explicit?.name, "model");
});

test("refreshes are stable on identical data and a real new fetch changes only fetchedAt", async () => {
  const source = gateway({ name: "Gateway", contextWindow: 100, reasoningEfforts: ["low", "high"] });
  const first = await enrichProviderModels(catalog({ name: "Primary" }), ["creator/model"], enabled, { gateway: source });
  first[0]!.metadata!.fields!.contextWindow!.updatedAt = "2026-01-01T00:00:00.000Z";
  const second = await enrichProviderModels(catalog({ name: "Primary" }), ["creator/model"], { ...enabled, models: first }, { gateway: source });
  assert.deepEqual(second, first);
  const newer = { ...source, fetchedAt: laterFetch };
  const third = await enrichProviderModels(catalog({ name: "Primary" }), ["creator/model"], { ...enabled, models: second }, { gateway: newer });
  assert.equal(third[0]?.metadata?.fields?.contextWindow?.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(third[0]?.metadata?.fields?.contextWindow?.fetchedAt, laterFetch);
  assert.equal(third[0]?.metadata?.gateway?.fetchedAt, laterFetch);
  assert.deepEqual(third[0]?.metadata?.conflicts, second[0]?.metadata?.conflicts);
});

test("enrichments deeply clone originals, source arrays, snapshots, conflicts and reference prices", async () => {
  const primary = catalog({ reasoning_options: [{ type: "effort", values: ["low", "high"] }] });
  const supplement = gateway({ reasoningEfforts: ["medium"] }, { referenceCost: { input: 0.25 } });
  const original = { id: "creator/model", custom: { route: ["fixed"] }, cost: { output: 2 } };
  const backups = structuredClone({ primary, supplement, original });
  const [result, duplicate] = await enrichProviderModels(primary, [original.id, original.id], { ...enabled, models: [original] }, { gateway: supplement });
  assert.deepEqual({ primary, supplement, original }, backups);
  assert.notEqual(result, duplicate);
  result!.reasoningEfforts!.push("manual");
  (result as typeof original).custom.route.push("changed");
  result!.metadata!.fields!.reasoningEfforts!.value = ["changed"];
  result!.metadata!.gateway!.referenceCost!.input = 999;
  const conflict = result!.metadata!.conflicts!.find((entry) => entry.field === "reasoningEfforts")!;
  (conflict.value as string[]).push("custom");
  assert.deepEqual({ primary, supplement, original }, backups);
  assert.deepEqual(duplicate?.reasoningEfforts, ["low", "high"]);
  assert.equal(duplicate?.metadata?.gateway?.referenceCost?.input, 0.25);
});

test("canonical matches override loose primary basenames without changing IDs or order", async () => {
  const primary = catalog({ name: "Wrong basename", limit: { context: 999 } }, "other", "other/model");
  const ids = ["creator/model", "unknown", "creator/model"];
  const enabledResult = await enrichProviderModels(primary, ids, enabled, { gateway: gateway({ contextWindow: 100 }) });
  assert.deepEqual(enabledResult.map((model) => model.id), ids);
  assert.equal(enabledResult[0]?.contextWindow, 100);
  assert.equal(enabledResult[0]?.name, undefined);
  assert.deepEqual(enabledResult[1], { id: "unknown" });
  const [legacy] = await enrichProviderModels(primary, ["creator/model"], disabled);
  assert.equal(legacy?.contextWindow, 999);
});

test("explicit creator hints and unambiguous EXACT primary evidence can match bare IDs", async () => {
  const source = gateway({ imageInput: true });
  const [hinted] = await enrichProviderModels(undefined, ["model"], { ...enabled, modelsDevId: "creator" }, { gateway: source });
  assert.equal(hinted?.imageInput, true);
  assert.equal(hinted?.id, "model");
  const [evidence] = await enrichProviderModels(catalog({ name: "Primary" }), ["model"], enabled, { gateway: source });
  assert.equal(evidence?.name, "Primary");
  assert.equal(evidence?.imageInput, true);
  assert.equal(evidence?.metadata?.gateway?.modelId, "creator/model");
});

test("ambiguous creator evidence does not match even if Gateway lists only one candidate", async () => {
  const primary = { ...catalog({ name: "First" }), ...catalog({ name: "Second" }, "other") };
  const source = gateway({ imageInput: true });
  for (const supplement of [source, { ...source, models: { ...source.models, ...gateway({ imageInput: true }, {}, "other/model").models } }]) {
    const [result] = await enrichProviderModels(primary, ["model"], enabled, { gateway: supplement });
    assert.equal(result?.metadata?.gateway, undefined);
    assert.equal(result?.imageInput, undefined);
    assert.deepEqual(result, { id: "model" });
  }
});

test("Gateway never case-folds, strips prefixes, matches substrings or infers creator from protocol", async () => {
  const ids = ["CREATOR/model", "creator/MODEL", "prefix/creator/model", "MODEL", "model:latest", "mode"];
  const settings = { ...enabled, protocol: "openai" as const };
  const result = await enrichProviderModels(undefined, ids, settings, { gateway: gateway({ contextWindow: 100 }) });
  assert.deepEqual(result, ids.map((id) => ({ id })));
});

test("aliases are exact, authoritative, ignored when off and can bind primary metadata to canonical identity", async () => {
  const aliases = { local: "creator/model", "creator/model": "missing/target" };
  const result = await enrichProviderModels(catalog({ name: "Primary" }), ["local", "Local", "creator/model"], {
    ...enabled, gatewayModelAliases: aliases,
  }, { gateway: gateway({ imageInput: true }) });
  assert.equal(result[0]?.name, "Primary");
  assert.equal(result[0]?.imageInput, true);
  assert.equal(result[0]?.metadata?.gateway?.alias, "creator/model");
  assert.deepEqual(result[1], { id: "Local" });
  assert.deepEqual(result[2], { id: "creator/model" });
  assert.deepEqual(await enrichProviderModels(undefined, ["local"], { ...disabled, gatewayModelAliases: { local: "creator/model" } }, {
    gateway: gateway({ imageInput: true }),
  }), [{ id: "local" }]);
});

test("explicit alias remaps remove stale owned fields from both catalogs but preserve manual values", async () => {
  const initialSettings = { ...enabled, gatewayModelAliases: { local: "creator/model" } };
  const first = await enrichProviderModels(catalog({ name: "Primary", limit: { context: 500 } }), ["local"], initialSettings, {
    gateway: gateway({ maxOutput: 50, maxInput: 100, imageInput: true, reasoning: true }),
  });
  first[0]!.maxOutput = 7;
  first[0]!.name = "Manual";
  const [remapped] = await enrichProviderModels(undefined, ["local"], {
    ...enabled, gatewayModelAliases: { local: "other/model" }, models: first,
  }, { gateway: gateway({ maxInput: 200 }, {}, "other/model") });
  assert.equal(remapped?.name, "Manual");
  assert.equal(remapped?.contextWindow, undefined);
  assert.equal(remapped?.maxOutput, 7);
  assert.equal(remapped?.maxInput, 200);
  assert.equal(remapped?.imageInput, undefined);
  assert.equal(remapped?.reasoning, undefined);
  assert.equal(remapped?.metadata?.fields?.maxOutput, undefined);
  assert.equal(remapped?.metadata?.gateway?.modelId, "other/model");
  assert.equal(remapped?.metadata?.fields?.maxInput?.modelId, "other/model");
  assert.ok(!remapped?.metadata?.conflicts?.some((entry) => entry.source === "ai-gateway" && entry.modelId === "creator/model"));
});

test("alias deletion and missing remap targets clear stale owned fields without a fetch retry", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const first = await enrichProviderModels(undefined, ["local"], { ...enabled, gatewayModelAliases: { local: "creator/model" } }, {
    gateway: gateway({ contextWindow: 100, imageInput: true }),
  });
  const deleted = await enrichProviderModels(undefined, ["local"], { ...enabled, gatewayModelAliases: {}, models: first }, { gateway: null });
  assert.deepEqual(deleted, [{ id: "local" }]);
  const remapped = await enrichProviderModels(undefined, ["local"], { ...enabled,
    gatewayModelAliases: { local: "missing/model" }, models: first,
  }, { gateway: null });
  assert.deepEqual(remapped, [{ id: "local" }]);
  const unchanged = await enrichProviderModels(undefined, ["local"], { ...enabled,
    gatewayModelAliases: { local: "creator/model" }, models: first,
  }, { gateway: { fetchedAt: laterFetch, models: {} } });
  assert.deepEqual(unchanged, first);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("opt-out and failed-load null never fetch and preserve previous Gateway fields and audit", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const first = await enrichProviderModels(undefined, ["creator/model"], enabled, { gateway: gateway({ contextWindow: 100 }) });
  assert.deepEqual(await enrichProviderModels(undefined, ["creator/model"], { gatewayMetadata: false, models: first }), first);
  assert.deepEqual(await enrichProviderModels(undefined, ["creator/model"], { ...disabled, models: first }, { gateway: gateway({ contextWindow: 200 }) }), first);
  assert.deepEqual(await enrichProviderModels(undefined, ["creator/model"], { ...enabled, models: first }, { gateway: null }), first);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("mapping options preserve omission, explicitly clear maps, clone input and never change mode", () => {
  const previous = { gatewayMetadata: true, gatewayModelAliases: { local: "creator/model" } };
  const result = resolveMetadataOptions({}, previous);
  assert.deepEqual(result, previous);
  assert.notEqual(result.gatewayModelAliases, previous.gatewayModelAliases);
  assert.deepEqual(resolveMetadataOptions({ gatewayMetadata: false }, previous), { ...previous, gatewayMetadata: false });
  assert.deepEqual(resolveMetadataOptions({ gatewayModels: "{}" }, previous), { gatewayMetadata: true, gatewayModelAliases: {} });
  assert.deepEqual(resolveMetadataOptions({ gatewayModels: '{"local":"creator/model"}' }), { gatewayModelAliases: { local: "creator/model" } });
  assert.deepEqual(resolveMetadataOptions({}), {});
  const nullPrototype = Object.assign(Object.create(null), { local: "creator/model" });
  assert.deepEqual(resolveMetadataOptions({}, { gatewayModelAliases: nullPrototype }), { gatewayModelAliases: { local: "creator/model" } });
  assert.deepEqual(previous, { gatewayMetadata: true, gatewayModelAliases: { local: "creator/model" } });
});

test("invalid option and stored mapping shapes fail generically before mutation or network", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  for (const gatewayModels of ["secret-token", "null", "[]", '"text"', '{"a":false}', '{"a":1}',
    '{"a":"bare"}', '{"":"creator/model"}', '{"a":"creator/ model"}', '{"a":"creator//model"}',
    '{"__proto__":"creator/model"}', '{"constructor":"creator/model"}', '{"prototype":"creator/model"}']) {
    assert.throws(() => resolveMetadataOptions({ gatewayModels }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Gateway model mappings/);
      assert.ok(!error.message.includes(gatewayModels));
      return true;
    });
  }
  assert.throws(() => resolveMetadataOptions({ gatewayMetadata: "false" as unknown as boolean }), /must be a boolean/);
  assert.throws(() => resolveMetadataOptions({ gatewayModels: {} as string }), /JSON object/);
  for (const aliases of [Object.create({ inherited: "creator/model" }), { local: "bad" }, ["creator/model"]]) {
    assert.throws(() => resolveMetadataOptions({ gatewayModels: "{}" }, { gatewayModelAliases: aliases }), /Gateway model mappings/);
  }
  const models = [{ id: "model", contextWindow: 100 }];
  await assert.rejects(enrichProviderModels(undefined, ["model"], { ...enabled, models, gatewayModelAliases: { local: "invalid" } }), /Gateway model mappings/);
  assert.deepEqual(models, [{ id: "model", contextWindow: 100 }]);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("incoming token limits cannot exceed retained context or silently replace smaller explicit limits", async () => {
  const [result] = await enrichProviderModels(catalog({ limit: { context: 1000, input: 300, output: 100 } }), ["creator/model"], {
    ...enabled, models: [{ id: "creator/model", contextWindow: 100, maxOutput: 5 }],
  }, { gateway: gateway({ maxInput: 200, maxOutput: 50 }) });
  assert.equal(result?.contextWindow, 100);
  assert.equal(result?.maxInput, undefined);
  assert.equal(result?.maxOutput, 5);
  assert.ok(result?.metadata?.conflicts?.some((entry) => entry.field === "maxInput" && entry.blockedBy === "contextWindow" && entry.keptValue === 100));
  assert.ok(result?.metadata?.conflicts?.some((entry) => entry.field === "maxOutput" && entry.keptValue === 5));
});

test("context shrink is rejected when retained limits block it but coordinated valid shrink can refresh", async () => {
  const first = await enrichProviderModels(catalog({ limit: { context: 200, input: 150, output: 100 } }), ["model"], disabled);
  const [blocked] = await enrichProviderModels(catalog({ limit: { context: 50, output: 100 } }), ["model"], { ...disabled, models: first });
  assert.equal(blocked?.contextWindow, 200);
  assert.equal(blocked?.maxInput, 150);
  assert.equal(blocked?.maxOutput, 100);
  assert.ok(blocked?.metadata?.conflicts?.some((entry) => entry.field === "contextWindow" && entry.blockedBy === "maxInput"));
  const [shrunk] = await enrichProviderModels(catalog({ limit: { context: 50, input: 40, output: 20 } }), ["model"], { ...disabled, models: first });
  assert.equal(shrunk?.contextWindow, 50);
  assert.equal(shrunk?.maxInput, 40);
  assert.equal(shrunk?.maxOutput, 20);
});

test("a new context cannot contradict an existing explicit limit", async () => {
  const [result] = await enrichProviderModels(catalog({ limit: { context: 100, output: 50 } }), ["model"], {
    ...disabled, models: [{ id: "model", maxOutput: 200 }],
  });
  assert.equal(result?.contextWindow, undefined);
  assert.equal(result?.maxOutput, 200);
  assert.ok(result?.metadata?.conflicts?.some((entry) => entry.field === "contextWindow" && entry.blockedBy === "maxOutput"));
});

test("reasoning false blocks effort enrichment while missing capability can be filled", async () => {
  const [explicit] = await enrichProviderModels(catalog({ reasoning_options: [{ type: "effort", values: ["high"] }] }), ["creator/model"], {
    ...enabled, models: [{ id: "creator/model", reasoning: false }],
  }, { gateway: gateway({ reasoning: true, reasoningEfforts: ["low"] }) });
  assert.equal(explicit?.reasoning, false);
  assert.equal(explicit?.reasoningEfforts, undefined);
  assert.equal(explicit?.metadata?.conflicts?.filter((entry) => entry.blockedBy === "reasoning").length, 2);
  const [missing] = await enrichProviderModels(undefined, ["creator/model"], enabled, {
    gateway: gateway({ reasoning: false, reasoningEfforts: ["low"], imageInput: false }),
  });
  assert.equal(missing?.reasoning, false);
  assert.equal(missing?.imageInput, false);
  assert.equal(missing?.reasoningEfforts, undefined);
  assert.equal(missing?.metadata?.fields?.reasoning?.value, false);
});

test("models.dev text-only capabilities and empty efforts remain explicit source values", async () => {
  const [result] = await enrichProviderModels(catalog({ modalities: { input: ["text"] },
    reasoning_options: [{ type: "effort", values: [] }] }), ["creator/model"], enabled, {
    gateway: gateway({ imageInput: true, reasoningEfforts: ["high"] }),
  });
  assert.equal(result?.imageInput, false);
  assert.deepEqual(result?.reasoningEfforts, []);
  assert.deepEqual(result?.metadata?.fields?.reasoningEfforts?.value, []);
  const [unknown] = await enrichProviderModels(catalog({}), ["model"], disabled);
  assert.equal(unknown?.imageInput, undefined);
});

test("reference prices are already per-million and never become effective prices or wire settings", async () => {
  const original = { id: "creator/model", protocol: "openai", baseUrl: "https://local.invalid/v1", cost: { input: 0 } };
  const supplement = gateway({ cost: { input: 999, output: 999 } }, {
    referenceCost: { input: 0.25, output: 1.5, cacheRead: 0 }, pricingIsVariable: false,
  });
  Object.assign(supplement.models["creator/model"]!.spec, { protocol: "anthropic", supported_specifications: ["anthropic"] });
  const [result] = await enrichProviderModels(undefined, [original.id], { ...enabled, models: [original] }, { gateway: supplement });
  assert.deepEqual(result?.cost, { input: 0 });
  assert.equal((result as typeof original).protocol, "openai");
  assert.equal((result as typeof original).baseUrl, original.baseUrl);
  assert.equal((result as unknown as Record<string, unknown>).supported_specifications, undefined);
  assert.deepEqual(result?.metadata?.gateway?.referenceCost, { input: 0.25, output: 1.5, cacheRead: 0 });
  assert.equal(result?.metadata?.gateway?.pricingIsVariable, false);
  const [noEffectivePrice] = await enrichProviderModels(undefined, [original.id], enabled, { gateway: supplement });
  assert.equal(noEffectivePrice?.cost, undefined);
});

test("primary context and Gateway-owned limits converge together in one refresh", async () => {
  const first = await enrichProviderModels(undefined, ["creator/model"], enabled, {
    gateway: gateway({ contextWindow: 300, maxOutput: 200 }),
  });
  const primary = catalog({ limit: { context: 100 } });
  const supplement = gateway({ maxOutput: 50 });
  const second = await enrichProviderModels(primary, ["creator/model"], { ...enabled, models: first }, { gateway: supplement });
  assert.equal(second[0]?.contextWindow, 100);
  assert.equal(second[0]?.maxOutput, 50);
  assert.equal(second[0]?.metadata?.fields?.contextWindow?.source, "models.dev");
  assert.deepEqual(await enrichProviderModels(primary, ["creator/model"], { ...enabled, models: second }, { gateway: supplement }), second);
});

test("ambiguous primary exact IDs are refused unless an explicit provider hint resolves them", async () => {
  const primary = { ...catalog({ name: "First" }), ...catalog({ name: "Second" }, "other") };
  assert.deepEqual(await enrichProviderModels(primary, ["model"], enabled, { gateway: null }), [{ id: "model" }]);
  const [hinted] = await enrichProviderModels(primary, ["model"], { ...enabled, modelsDevId: "other" }, { gateway: null });
  assert.equal(hinted?.name, "Second");
  assert.equal(hinted?.metadata?.fields?.name?.modelId, "other/model");
  assert.deepEqual(await enrichProviderModels(primary, ["model"], { ...enabled, modelsDevId: "missing" }, { gateway: null }), [{ id: "model" }]);
});

test("opting into exact identities discards wrong legacy basename origins but preserves edits and unattributed values", async () => {
  const primary = catalog({ name: "Wrong basename", attachment: false, limit: { context: 999 }, cost: { input: 1, output: 2 } }, "other", "other/model");
  const first = await enrichProviderModels(primary, ["creator/model"], {
    ...disabled, models: [{ id: "creator/model", reasoning: false, maxOutput: 5 }],
  });
  assert.equal(first[0]?.metadata?.fields?.contextWindow?.modelId, "other/model");
  assert.deepEqual(await enrichProviderModels(undefined, ["creator/model"], { ...enabled, models: first }, { gateway: null }), first);
  first[0]!.name = "Manual";
  first[0]!.cost!.input = 0;
  const [result] = await enrichProviderModels(primary, ["creator/model"], { ...enabled, models: first }, {
    gateway: gateway({ name: "Gateway", contextWindow: 100, imageInput: true, reasoning: true }),
  });
  assert.equal(result?.name, "Manual");
  assert.equal(result?.contextWindow, 100);
  assert.equal(result?.imageInput, true);
  assert.equal(result?.reasoning, false);
  assert.equal(result?.maxOutput, 5);
  assert.deepEqual(result?.cost, { input: 0 });
  assert.equal(result?.metadata?.fields?.name, undefined);
  assert.equal(result?.metadata?.fields?.["cost.input"], undefined);
  assert.ok(Object.values(result?.metadata?.fields ?? {}).every((origin) => origin.modelId === "creator/model"));
});

test("uncertain exact identity never removes previously tracked primary values", async () => {
  const ambiguous = { ...catalog({ name: "First" }), ...catalog({ name: "Second" }, "other") };
  const first = await enrichProviderModels(ambiguous, ["model"], disabled);
  assert.deepEqual(await enrichProviderModels(ambiguous, ["model"], { ...enabled, models: first }, {
    gateway: gateway({ imageInput: true }),
  }), first);
});

test("an explicit remap with an available catalog drops stale primary fields even if the new target has no metadata", async () => {
  const first = await enrichProviderModels(catalog({ name: "Old", attachment: true }), ["local"], {
    ...enabled, gatewayModelAliases: { local: "creator/model" },
  }, { gateway: gateway({ contextWindow: 100 }) });
  const result = await enrichProviderModels(undefined, ["local"], {
    ...enabled, gatewayModelAliases: { local: "missing/model" }, models: first,
  }, { gateway: { fetchedAt, models: {} } });
  assert.deepEqual(result, [{ id: "local" }]);
});

test("explicit false and empty efforts refresh together without stale effort conflicts", async () => {
  const first = await enrichProviderModels(catalog({ reasoning: true, reasoning_options: [{ type: "effort", values: ["low"] }] }), ["model"], disabled);
  const primary = catalog({ reasoning: false, reasoning_options: [{ type: "effort", values: [] }] });
  const second = await enrichProviderModels(primary, ["model"], { ...disabled, models: first });
  assert.equal(second[0]?.reasoning, false);
  assert.deepEqual(second[0]?.reasoningEfforts, []);
  assert.equal(second[0]?.metadata?.fields?.reasoning?.value, false);
  assert.deepEqual(second[0]?.metadata?.fields?.reasoningEfforts?.value, []);
  assert.equal(second[0]?.metadata?.conflicts, undefined);
  assert.deepEqual(await enrichProviderModels(primary, ["model"], { ...disabled, models: second }), second);
  assert.equal(first[0]?.reasoning, true);
  assert.deepEqual(first[0]?.reasoningEfforts, ["low"]);
});

test("a false and empty-efforts source cannot remove manually edited effort settings", async () => {
  const first = await enrichProviderModels(catalog({ reasoning: true, reasoning_options: [{ type: "effort", values: ["low"] }] }), ["model"], disabled);
  first[0]!.reasoningEfforts!.push("custom");
  const [result] = await enrichProviderModels(catalog({ reasoning: false, reasoning_options: [{ type: "effort", values: [] }] }), ["model"], { ...disabled, models: first });
  assert.equal(result?.reasoning, true);
  assert.deepEqual(result?.reasoningEfforts, ["low", "custom"]);
  assert.equal(result?.metadata?.fields?.reasoningEfforts, undefined);
  assert.ok(result?.metadata?.conflicts?.some((entry) => entry.field === "reasoning" && entry.blockedBy === "reasoningEfforts"));
});

test("explicit alias remap clears stale primary fields even when both catalogs are unavailable", async () => {
  const original = await enrichProviderModels(catalog({ name: "Old name", limit: { context: 4096 }, cost: { input: 2 } }), ["local"], {
    ...enabled, gatewayModelAliases: { local: "creator/model" },
  }, { gateway: gateway({ maxOutput: 512 }) });
  original[0]!.name = "Manual name";
  original[0]!.cost!.output = 7;
  const result = await enrichProviderModels(undefined, ["local"], {
    ...enabled, models: original, gatewayModelAliases: { local: "other/model" },
  }, { gateway: null });
  assert.equal(result[0]!.contextWindow, undefined);
  assert.equal(result[0]!.maxOutput, undefined);
  assert.equal(result[0]!.cost?.input, undefined);
  assert.equal(result[0]!.name, "Manual name");
  assert.equal(result[0]!.cost?.output, 7);
  assert.equal(result[0]!.metadata?.gateway, undefined);
});

test("metadata modes default to auto, preserve stored options and support explicit transitions", () => {
  assert.equal(getMetadataMode({}), "auto");
  for (const stored of [undefined, "auto", true, false] as const) {
    const previous = { ...(stored === undefined ? {} : { gatewayMetadata: stored }), gatewayModelAliases: { local: "creator/model" } };
    assert.deepEqual(resolveMetadataOptions({}, previous), previous);
    assert.deepEqual(resolveMetadataOptions({ gatewayModels: "{}" }, previous), { ...previous, gatewayModelAliases: {} });
    for (const [metadataMode, value] of [["auto", "auto"], ["on", true], ["off", false]] as const) {
      const next = resolveMetadataOptions({ metadataMode }, previous);
      assert.deepEqual(next, { ...previous, gatewayMetadata: value });
      assert.equal(getMetadataMode(next), metadataMode);
    }
    assert.equal(resolveMetadataOptions({ gatewayMetadata: false }, previous).gatewayMetadata, false);
    assert.equal(resolveMetadataOptions({ gatewayMetadata: true }, previous).gatewayMetadata, true);
  }
  assert.deepEqual(resolveMetadataOptions({ metadataMode: "on", gatewayMetadata: true }), { gatewayMetadata: true });
  assert.deepEqual(resolveMetadataOptions({ metadataMode: "off", gatewayMetadata: false }), { gatewayMetadata: false });
});

test("invalid and conflicting modes reject before mutation or loading", async (t) => {
  const previous = { gatewayMetadata: false, gatewayModelAliases: { local: "creator/model" } };
  const backup = structuredClone(previous);
  for (const metadataMode of ["", "AUTO", "true", "false", "sometimes", null as unknown as string]) {
    assert.throws(() => resolveMetadataOptions({ metadataMode }, previous), /Metadata mode must be/);
  }
  for (const [metadataMode, gatewayMetadata] of [["on", false], ["off", true], ["auto", true], ["auto", false]] as const) {
    assert.throws(() => resolveMetadataOptions({ metadataMode, gatewayMetadata }, previous), /conflicts/);
  }
  assert.throws(() => resolveMetadataOptions({ gatewayMetadata: "auto" as unknown as boolean }), /must be a boolean/);
  assert.deepEqual(previous, backup);
  const gatewayLoader = t.mock.fn(async () => gateway({ contextWindow: 100 }));
  const models = [{ id: "model", contextWindow: 50 }];
  await assert.rejects(enrichProviderModels(undefined, ["model"], {
    gatewayMetadata: "on" as unknown as boolean, models,
  }, { gatewayLoader }), /Gateway metadata must be/);
  assert.deepEqual(models, [{ id: "model", contextWindow: 50 }]);
  assert.equal(gatewayLoader.mock.callCount(), 0);
});

test("default auto skips Gateway for complete primary and manual values including false and zero", async (t) => {
  const gatewayLoader = t.mock.fn(async () => gateway({ name: "Optional name", maxInput: 50, reasoningEfforts: [] }));
  const primary = catalog({ limit: { context: 0, output: 0 }, reasoning: false, modalities: { input: ["text"] } });
  const [result] = await enrichProviderModels(primary, ["creator/model"], {}, { gatewayLoader });
  assert.equal(result?.contextWindow, 0);
  assert.equal(result?.maxOutput, 0);
  assert.equal(result?.reasoning, false);
  assert.equal(result?.imageInput, false);
  assert.equal(result?.metadata?.fields?.reasoning?.source, "models.dev");
  assert.equal(result?.name, undefined);
  assert.equal(result?.maxInput, undefined);
  assert.equal(result?.reasoningEfforts, undefined);
  assert.equal(result?.cost, undefined);
  const manual: ModelSpec = { id: "creator/model", contextWindow: 0, maxOutput: 0, reasoning: false, imageInput: false };
  assert.deepEqual(await enrichProviderModels(undefined, [manual.id], { models: [manual] }, { gatewayLoader }), [manual]);
  const mixed = await enrichProviderModels(catalog({ reasoning: false, attachment: false }), [manual.id], {
    gatewayMetadata: "auto", models: [{ id: manual.id, contextWindow: 0, maxOutput: 0 }],
  }, { gatewayLoader });
  assert.equal(mixed[0]?.contextWindow, 0);
  assert.equal(mixed[0]?.metadata?.fields?.contextWindow, undefined);
  assert.equal(gatewayLoader.mock.callCount(), 0);
});

test("auto loads once for any missing core field and preserves discovery order and manual values", async (t) => {
  const complete: ModelSpec = { id: "creator/model", contextWindow: 100, maxOutput: 20, reasoning: false, imageInput: false };
  for (const field of ["contextWindow", "maxOutput", "reasoning", "imageInput"] as const) {
    const original = { ...complete };
    delete original[field];
    const gatewayLoader = t.mock.fn(async () => gateway(complete));
    const result = await enrichProviderModels(undefined, [original.id, original.id], { models: [original] }, { gatewayLoader });
    assert.equal(gatewayLoader.mock.callCount(), 1);
    assert.deepEqual(result.map((model) => model.id), [original.id, original.id]);
    assert.equal(result[0]?.[field], complete[field]);
    assert.equal(result[0]?.metadata?.fields?.[field]?.source, "ai-gateway");
    assert.deepEqual(Object.keys(result[0]?.metadata?.fields ?? {}), [field]);
    assert.deepEqual(result[0], result[1]);
    assert.notEqual(result[0], result[1]);
    assert.equal(original[field], undefined);
  }
});

test("auto refreshes unchanged Gateway-owned core and optional fields without missing core specs", async (t) => {
  const complete = { contextWindow: 100, maxOutput: 20, reasoning: false, imageInput: false };
  const original = await enrichProviderModels(undefined, ["creator/model"], enabled, { gateway: gateway(complete) });
  const gatewayLoader = t.mock.fn(async () => ({ ...gateway({ ...complete, contextWindow: 200 }), fetchedAt: laterFetch }));
  const [refreshed] = await enrichProviderModels(undefined, ["creator/model"], { models: original }, { gatewayLoader });
  assert.equal(gatewayLoader.mock.callCount(), 1);
  assert.equal(refreshed?.contextWindow, 200);
  assert.equal(refreshed?.metadata?.fields?.contextWindow?.source, "ai-gateway");
  assert.equal(refreshed?.metadata?.fields?.contextWindow?.fetchedAt, laterFetch);
  assert.equal(original[0]?.contextWindow, 100);
  const primary = catalog({ limit: { context: 100, output: 20 }, reasoning: false, attachment: false });
  const optional = await enrichProviderModels(primary, ["creator/model"], enabled, { gateway: gateway({ name: "Old name" }) });
  const optionalLoader = t.mock.fn(async () => gateway({ name: "New name" }));
  const [renamed] = await enrichProviderModels(primary, ["creator/model"], { models: optional }, { gatewayLoader: optionalLoader });
  assert.equal(optionalLoader.mock.callCount(), 1);
  assert.equal(renamed?.name, "New name");
  assert.equal(renamed?.metadata?.fields?.name?.source, "ai-gateway");
});

test("auto skips Gateway when primary replaces all ownership or manual edits detach the last owned field", async (t) => {
  const complete = { contextWindow: 100, maxOutput: 20, reasoning: false, imageInput: false };
  const original = await enrichProviderModels(undefined, ["creator/model"], enabled, { gateway: gateway(complete) });
  const primary = catalog({ limit: { context: 200, output: 40 }, reasoning: false, attachment: false });
  const gatewayLoader = t.mock.fn(async () => gateway({ ...complete, contextWindow: 500 }));
  const [result] = await enrichProviderModels(primary, ["creator/model"], { models: original }, { gatewayLoader });
  assert.equal(result?.contextWindow, 200);
  assert.ok(Object.values(result?.metadata?.fields ?? {}).every((origin) => origin.source === "models.dev"));
  const named = await enrichProviderModels(primary, ["creator/model"], enabled, { gateway: gateway({ name: "Gateway name" }) });
  named[0]!.name = "Manual name";
  const [manual] = await enrichProviderModels(primary, ["creator/model"], { models: named }, { gatewayLoader });
  assert.equal(manual?.name, "Manual name");
  assert.equal(manual?.metadata?.fields?.name, undefined);
  assert.equal(gatewayLoader.mock.callCount(), 0);
});

test("auto final merge uses original ownership for coordinated primary context and Gateway limit shrink", async (t) => {
  const original = await enrichProviderModels(undefined, ["creator/model"], enabled, {
    gateway: gateway({ contextWindow: 300, maxOutput: 200, reasoning: false, imageInput: false }),
  });
  const primary = catalog({ limit: { context: 100 }, reasoning: false, attachment: false });
  const gatewayLoader = t.mock.fn(async () => gateway({ maxOutput: 50 }));
  const [result] = await enrichProviderModels(primary, ["creator/model"], { models: original }, { gatewayLoader });
  assert.equal(gatewayLoader.mock.callCount(), 1);
  assert.equal(result?.contextWindow, 100);
  assert.equal(result?.maxOutput, 50);
  assert.equal(result?.metadata?.fields?.contextWindow?.source, "models.dev");
  assert.equal(result?.metadata?.fields?.maxOutput?.source, "ai-gateway");
  assert.equal(result?.metadata?.conflicts, undefined);
});

test("auto failures retain primary and manual values, and explicit null or catalogs never retry", async (t) => {
  const primary = catalog({ limit: { context: 100 }, reasoning: false });
  const original = { id: "creator/model", name: "Manual", maxOutput: 0, cost: { input: 0 } };
  for (const throws of [false, true]) {
    const gatewayLoader = t.mock.fn(async () => {
      if (throws) throw new Error("Unavailable");
      return null;
    });
    const [result] = await enrichProviderModels(primary, [original.id], { models: [original] }, { gatewayLoader });
    assert.equal(gatewayLoader.mock.callCount(), 1);
    assert.equal(result?.contextWindow, 100);
    assert.equal(result?.reasoning, false);
    assert.equal(result?.name, "Manual");
    assert.equal(result?.maxOutput, 0);
    assert.deepEqual(result?.cost, { input: 0 });
    assert.equal(result?.imageInput, undefined);
    assert.equal(result?.metadata?.fields?.contextWindow?.source, "models.dev");
  }
  const gatewayLoader = t.mock.fn(async () => gateway({ imageInput: true }));
  for (const gatewayMetadata of [undefined, "auto", true, false] as const) {
    await enrichProviderModels(primary, [original.id], { gatewayMetadata, models: [original] }, { gateway: null, gatewayLoader });
    await enrichProviderModels(primary, [original.id], { gatewayMetadata, models: [original] }, { gateway: gateway({}), gatewayLoader });
  }
  assert.equal(gatewayLoader.mock.callCount(), 0);
});

test("explicit on always loads, off uses legacy matching, and empty discovery never loads", async (t) => {
  const complete = { contextWindow: 100, maxOutput: 20, reasoning: false, imageInput: false };
  const gatewayLoader = t.mock.fn(async () => gateway({ ...complete, name: "Extra" }));
  const [on] = await enrichProviderModels(undefined, ["creator/model"], { ...enabled, models: [{ id: "creator/model", ...complete }] }, { gatewayLoader });
  assert.equal(gatewayLoader.mock.callCount(), 1);
  assert.equal(on?.name, "Extra");
  const wrong = catalog({ limit: { context: 999 } }, "other", "other/model");
  const [off] = await enrichProviderModels(wrong, ["creator/model"], disabled, { gatewayLoader });
  assert.equal(off?.contextWindow, 999);
  assert.equal(gatewayLoader.mock.callCount(), 1);
  for (const gatewayMetadata of [undefined, "auto", true, false] as const) {
    assert.deepEqual(await enrichProviderModels(undefined, [], { gatewayMetadata }, { gatewayLoader }), []);
  }
  assert.equal(gatewayLoader.mock.callCount(), 1);
});

test("default auto resolves unique exact bare IDs with absent or agreeing primary evidence", async (t) => {
  for (const primary of [undefined, catalog({ name: "Primary" }), catalog({ name: "Qualified primary" }, "creator", "creator/model")]) {
    const gatewayLoader = t.mock.fn(async () => gateway({ contextWindow: 100, imageInput: true }));
    const [result] = await enrichProviderModels(primary, ["model"], {}, { gatewayLoader });
    assert.equal(gatewayLoader.mock.callCount(), 1);
    assert.equal(result?.id, "model");
    assert.equal(result?.contextWindow, 100);
    assert.equal(result?.imageInput, true);
    assert.equal(result?.metadata?.gateway?.modelId, "creator/model");
    if (primary) assert.equal(result?.metadata?.fields?.name?.source, "models.dev");
  }
});

test("bare Gateway matches reject conflicting or ambiguous creators and qualified-prefix guesses", async () => {
  const unique = gateway({ imageInput: true });
  const conflict = await enrichProviderModels(catalog({ name: "Other primary" }, "other"), ["model"], {}, { gateway: unique });
  assert.equal(conflict[0]?.name, "Other primary");
  assert.equal(conflict[0]?.imageInput, undefined);
  assert.equal(conflict[0]?.metadata?.gateway, undefined);
  const ambiguousPrimary = { ...catalog({ name: "First" }), ...catalog({ name: "Second" }, "other") };
  assert.deepEqual(await enrichProviderModels(ambiguousPrimary, ["model"], {}, { gateway: unique }), [{ id: "model" }]);
  const ambiguousGateway = { fetchedAt, models: { ...unique.models, ...gateway({ imageInput: true }, {}, "other/model").models } };
  for (const primary of [undefined, catalog({ name: "Primary" })]) {
    const [result] = await enrichProviderModels(primary, ["model"], {}, { gateway: ambiguousGateway });
    assert.equal(result?.imageInput, undefined);
    assert.equal(result?.metadata?.gateway, undefined);
  }
  const prefixed = gateway({ imageInput: true }, {}, "creator/vendor/model");
  const ids = ["MODEL", "model:latest", "vendor/model", "prefix/creator/model"];
  assert.deepEqual(await enrichProviderModels(undefined, ids, { modelsDevId: "creator" }, { gateway: prefixed }), ids.map((id) => ({ id })));
});

test("off to auto verifies conflicting legacy identities even with complete core fields and preserves them offline", async (t) => {
  const wrong = catalog({ name: "Wrong", limit: { context: 900, output: 90 }, reasoning: false, attachment: false }, "other", "other/model");
  const original = await enrichProviderModels(wrong, ["creator/model"], disabled);
  const backup = structuredClone(original);
  const gatewayLoader = t.mock.fn(async () => gateway({ contextWindow: 100, maxOutput: 20, reasoning: false, imageInput: true }));
  const [result] = await enrichProviderModels(wrong, ["creator/model"], { models: original }, { gatewayLoader });
  assert.equal(gatewayLoader.mock.callCount(), 1);
  assert.equal(result?.name, undefined);
  assert.equal(result?.contextWindow, 100);
  assert.equal(result?.maxOutput, 20);
  assert.equal(result?.imageInput, true);
  assert.ok(Object.values(result?.metadata?.fields ?? {}).every((origin) => origin.modelId === "creator/model"));
  const unavailable = t.mock.fn(async () => null);
  assert.deepEqual(await enrichProviderModels(undefined, ["creator/model"], { models: original }, { gatewayLoader: unavailable }), original);
  assert.equal(unavailable.mock.callCount(), 1);
  assert.deepEqual(original, backup);
});

test("complete primary aliases and exact catalog identities do not prompt spurious auto refresh", async (t) => {
  const primary = catalog({ limit: { context: 100, output: 20 }, reasoning: false, attachment: false });
  const gatewayLoader = t.mock.fn(async () => gateway({ name: "Unneeded" }));
  const [aliased] = await enrichProviderModels(primary, ["proxy/model"], {
    gatewayModelAliases: { "proxy/model": "creator/model" },
  }, { gatewayLoader });
  assert.equal(aliased?.id, "proxy/model");
  assert.equal(aliased?.contextWindow, 100);
  assert.equal(aliased?.metadata?.fields?.contextWindow?.modelId, "creator/model");
  const exact: Catalog = { creator: { id: "creator", models: {
    "proxy/model": { id: "creator/model", limit: { context: 100, output: 20 }, reasoning: false, attachment: false },
  } } };
  const [matched] = await enrichProviderModels(exact, ["proxy/model"], {}, { gatewayLoader });
  assert.equal(matched?.contextWindow, 100);
  assert.equal(matched?.metadata?.fields?.contextWindow?.modelId, "creator/model");
  assert.equal(gatewayLoader.mock.callCount(), 0);
});

test("a provider hint is not a creator restriction when unique bare Gateway identity supplies primary evidence", async (t) => {
  const primary = catalog({ name: "Reseller primary", limit: { context: 500 } }, "reseller", "creator/model");
  const gatewayLoader = t.mock.fn(async () => gateway({ contextWindow: 100, imageInput: true }));
  const [result] = await enrichProviderModels(primary, ["model"], { modelsDevId: "reseller" }, { gatewayLoader });
  assert.equal(result?.id, "model");
  assert.equal(result?.name, "Reseller primary");
  assert.equal(result?.contextWindow, 500);
  assert.equal(result?.imageInput, true);
  assert.equal(result?.metadata?.fields?.contextWindow?.modelId, "creator/model");
  assert.equal(result?.metadata?.fields?.contextWindow?.source, "models.dev");
  assert.equal(result?.metadata?.gateway?.modelId, "creator/model");
  assert.equal(gatewayLoader.mock.callCount(), 1);
});

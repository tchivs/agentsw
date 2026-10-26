import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-discovery-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) delete process.env[name];
const { discoverProviderCatalog, discoverProviderModels, probeProtocols, MAX_MODEL_PAGES } = await import("../src/discover.js");
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
beforeEach((t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
});

const provider = { baseUrl: "https://fixture.example/tenant/v1?account=one#ignored", apiKey: "fixture-discovery-key", protocol: "anthropic" as const };

test("Anthropic pagination preserves query identity, follows every cursor, and deduplicates models", async (t) => {
  const requests: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.pathname, "/tenant/v1/models");
    assert.equal(url.searchParams.get("account"), "one");
    assert.equal(url.hash, "");
    assert.equal(new Headers(init?.headers).get("x-api-key"), provider.apiKey);
    assert.equal(new Headers(init?.headers).get("anthropic-version"), "2023-06-01");
    const pages = [
      { data: [{ id: "z" }, { id: "a" }], has_more: true, last_id: "cursor/one" },
      { data: [{ id: "a" }, { id: "b" }], has_more: true, last_id: "cursor two" },
      { data: [{ id: "c" }], has_more: false },
    ];
    return Response.json(pages[requests.length - 1]);
  });
  assert.deepEqual(await discoverProviderModels(provider), ["a", "b", "c", "z"]);
  assert.deepEqual(requests.map((url) => url.searchParams.get("after_id")), [null, "cursor/one", "cursor two"]);
});

test("operation URLs use pathname for roots, versioned paths, queries, and fragments", async (t) => {
  const cases = [
    ["https://fixture.example?tenant=a&route=%2Fv2#fragment", "/v1/models"],
    ["https://fixture.example/Tenant/?tenant=a&route=%2Fv2#fragment", "/Tenant/v1/models"],
    ["https://fixture.example/Tenant/v1/?tenant=a&route=%2Fv2#fragment", "/Tenant/v1/models"],
    ["https://fixture.example/Tenant/v2?tenant=a&route=%2Fv2#fragment", "/Tenant/v2/models"],
    ["https://fixture.example/Tenant/v2beta1?tenant=a&route=%2Fv2#fragment", "/Tenant/v2beta1/models"],
    ["https://fixture.example/Tenant/models?tenant=a&route=%2Fv2#fragment", "/Tenant/models"],
    ["https://fixture.example/models?tenant=a&route=%2Fv2#fragment", "/models"],
  ];
  for (const [baseUrl, expectedPath] of cases) {
    const requests: URL[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      assert.equal(url.pathname, expectedPath);
      assert.equal(url.search, "?tenant=a&route=%2Fv2");
      assert.equal(url.hash, "");
      return Response.json({ data: [{ id: "fixture-model" }] });
    });
    assert.deepEqual(await discoverProviderModels({ ...provider, baseUrl: baseUrl! }), ["fixture-model"]);
    assert.deepEqual(await probeProtocols({ ...provider, baseUrl: baseUrl! }), ["openai", "anthropic"]);
    assert.equal(requests.length, 3);
  }
});

test("pagination rejects missing cursors, repeated cursors and longer cursor cycles", async (t) => {
  for (const cursors of [[undefined], ["same", "same"], ["one", "two", "one"]]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      const cursor = cursors[calls++];
      assert.ok(calls <= cursors.length, "pagination must stop at the first invalid cursor");
      return Response.json({ data: [{ id: `model-${calls}` }], has_more: true, last_id: cursor });
    });
    await assert.rejects(discoverProviderModels(provider), /pagination.*(?:missing|repeated)/);
    assert.equal(calls, cursors.length);
  }
});

test("endless fresh cursors stop at the page cap instead of looping forever", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ data: [{ id: `model-${calls}` }], has_more: true, last_id: `cursor-${calls}` });
  });
  await assert.rejects(discoverProviderModels(provider), /pagination exceeded 100 pages/);
  assert.equal(calls, MAX_MODEL_PAGES, "the cap bounds the number of requests");
});

test("a later HTTP or malformed page rejects the entire discovery instead of returning partial models", async (t) => {
  for (const failedPage of [new Response("unavailable", { status: 503 }), Response.json({ data: "not an array" }), Response.json({ data: [], has_more: "yes" })]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => ++calls === 1
      ? Response.json({ data: [{ id: "partial" }], has_more: true, last_id: "partial" })
      : failedPage);
    await assert.rejects(discoverProviderModels(provider), /HTTP 503|model-list/);
    assert.equal(calls, 2);
  }
});

test("OpenAI models aliases and protocol-specific authentication remain supported", async (t) => {
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.has("x-api-key")) return new Response("unsupported", { status: 401 });
    assert.equal(headers.get("authorization"), `Bearer ${provider.apiKey}`);
    return Response.json({ models: [{ id: "b" }, { id: "" }, {}, { id: "a" }, { id: "b" }] });
  });
  assert.deepEqual(await discoverProviderModels({ ...provider, protocol: "openai" }), ["a", "b"]);
  assert.deepEqual(await probeProtocols(provider), ["openai"]);
});

test("pagination hooks report every page and leave the result untouched", async (t) => {
  const pages = [
    { data: [{ id: "b" }, { id: "a" }], has_more: true, last_id: "cursor-1" },
    { data: [{ id: "a" }, { id: "c" }], has_more: false },
  ];
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(pages[call++]));
  const seen: Array<{ page: number; count: number }> = [];
  assert.deepEqual(await discoverProviderModels(provider, { onPage: (info) => seen.push(info) }), ["a", "b", "c"]);
  // count is the running deduplicated total, which is what the progress line shows.
  assert.deepEqual(seen, [{ page: 1, count: 2 }, { page: 2, count: 3 }]);
  call = 0;
  assert.deepEqual(await discoverProviderModels(provider), ["a", "b", "c"], "hooks are optional");
});

test("probe hooks fire once per attempt, in probe order, before the request", async (t) => {
  const attempts: string[] = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "m" }] }));
  assert.deepEqual(await probeProtocols(provider, { onAttempt: (protocol) => attempts.push(protocol) }), ["openai", "anthropic"]);
  assert.deepEqual(attempts, ["openai", "anthropic"]);
  attempts.length = 0;
  assert.deepEqual(await probeProtocols(provider), ["openai", "anthropic"], "hooks are optional");
  assert.deepEqual(attempts, []);
});

test("endpoint-declared limits fold every alias and survive pagination", async (t) => {
  const pages = [
    { data: [
      { id: "gateway-style", context_window_tokens: 131072, maximum_output_tokens: 32768, supports_tools: true },
      { id: "bare" },
      { id: "zero-and-strings", context_window_tokens: 0, max_output_tokens: "64000", maximum_output_tokens: -1 },
    ], has_more: true, last_id: "cursor-1" },
    { data: [
      { id: "openrouter-style", context_length: 200000.9, max_output_tokens: 64000 },
      { id: "alias-priority", context_length: 100, max_context_length: 200 },
      { id: "bare" },
    ], has_more: false },
  ];
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(pages[call++]));
  const catalog = await discoverProviderCatalog(provider);
  assert.deepEqual(catalog.ids, ["alias-priority", "bare", "gateway-style", "openrouter-style", "zero-and-strings"]);
  assert.deepEqual([...catalog.facts], [
    ["gateway-style", { contextWindow: 131072, maxOutput: 32768 }],
    ["openrouter-style", { contextWindow: 200000, maxOutput: 64000 }],
    ["alias-priority", { contextWindow: 100 }],
  ], "only rows that declare a usable limit carry an entry");
});

test("a declared limit that floors to zero is no declaration at all", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "fraction", context_window_tokens: 0.5, context_length: 4096 },
    { id: "tiny-output", maximum_output_tokens: 0.4 },
  ] }));
  const catalog = await discoverProviderCatalog(provider);
  assert.deepEqual([...catalog.facts], [["fraction", { contextWindow: 4096 }]],
    "a fraction falls through to the next spelling, and declares nothing when it is the last one");
});

test("endpoint-declared prices keep their fraction and their own spelling", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "priced", maximum_output_tokens: 64000, input_cost_per_million_tokens_usd: 0.15,
      output_cost_per_million_tokens_usd: 1.5, cached_input_cost_per_million_tokens_usd: 0.075,
      cache_write_cost_per_million_tokens_usd: 0.3 },
    { id: "free", input_cost_per_million_tokens_usd: 0, output_cost_per_million_tokens_usd: 0 },
    { id: "bad-price", input_cost_per_million_tokens_usd: -1, output_cost_per_million_tokens_usd: "1.5" },
  ] }));
  const catalog = await discoverProviderCatalog(provider);
  assert.deepEqual([...catalog.facts], [
    ["priced", { maxOutput: 64000, cost: { input: 0.15, output: 1.5, cacheRead: 0.075, cacheWrite: 0.3 } }],
    ["free", { cost: { input: 0, output: 0 } }],
  ], "a per-million price keeps its fraction, 0 is a real price, and an unusable one declares nothing");
});

test("nano-USD prices under pricing convert; tier and per-image rates stay out", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "nano", pricing: {
      input_nano_usd_per_million_tokens: 800000000, output_nano_usd_per_million_tokens: 1600000000,
      cached_input_nano_usd_per_million_tokens: 200000000, cache_write_nano_usd_per_million_tokens: 300000000,
      cache_creation_1h_input_nano_usd_per_million_tokens: 1234567890, long_context: null,
    } },
    { id: "creation-only", pricing: {
      input_nano_usd_per_million_tokens: 250000000, cache_creation_input_nano_usd_per_million_tokens: 312500000,
    } },
    { id: "per-image", pricing: { units: { kind: "image", rates: { "": 20000000 } },
      input_nano_usd_per_million_tokens: null, output_nano_usd_per_million_tokens: null } },
  ] }));
  const catalog = await discoverProviderCatalog(provider);
  assert.deepEqual([...catalog.facts], [
    ["nano", { cost: { input: 0.8, output: 1.6, cacheRead: 0.2, cacheWrite: 0.3 } }],
    ["creation-only", { cost: { input: 0.25, cacheWrite: 0.3125 } }],
  ], "nano-USD becomes per-million USD, a tier rate beside the base one is not the base price, and a per-image rate is not a token price");
});

test("a later page's partial row keeps the limits an earlier page declared", async (t) => {
  const pages = [
    { data: [{ id: "split", context_window_tokens: 200000, maximum_output_tokens: 32000 }], has_more: true, last_id: "cursor-1" },
    { data: [{ id: "split", max_output_tokens: 8192 }, { id: "plain" }], has_more: false },
  ];
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(pages[call++]));
  const catalog = await discoverProviderCatalog(provider);
  assert.deepEqual([...catalog.facts], [["split", { contextWindow: 200000, maxOutput: 8192 }]],
    "only the key the later row declares is replaced");
});

test("id-only listings keep the limit map empty, as resellers do", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ models: [{ id: "a" }, { id: "b", name: "B" }] }));
  const catalog = await discoverProviderCatalog({ ...provider, protocol: "openai" });
  assert.deepEqual(catalog.ids, ["a", "b"]);
  assert.equal(catalog.facts.size, 0);
});

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider } from "../src/types.js";
import type { ProviderCandidate } from "../src/targets/types.js";

// Adapters resolve home at module init; isolate before dynamic imports.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ssw-import-"));
process.env.HOME = sandbox;
delete process.env.HERMES_HOME;
delete process.env.WORKBUDDY_CONFIG_DIR;
delete process.env.CODEBUDDY_CONFIG_DIR;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PRIME_AGENT_CODING_AGENT_DIR;

const { targets } = await import("../src/targets/index.js");
const { mergeCandidates } = await import("../src/import.js");

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("adapter candidates round-trip and dedupe by protocol plus base URL", async () => {
  for (const dir of [".codex", ".omp/agent", ".pi/agent"]) {
    fs.mkdirSync(path.join(sandbox, dir), { recursive: true });
  }

  const openai: Provider = {
    id: "sub",
    name: "Sub Responses",
    protocol: "openai",
    baseUrl: "https://sub.example/v1",
    apiKey: "sk-sub-openai",
    defaultModel: "gpt-5",
    models: [{ id: "gpt-5" }, { id: "glm-4.6" }],
  };
  const anthropic: Provider = {
    id: "sub-anthropic",
    name: "Sub Anthropic",
    protocol: "anthropic",
    baseUrl: "https://sub.example/v1",
    apiKey: "sk-sub-anthropic",
    defaultModel: "claude-sonnet-4-5",
    models: [{ id: "claude-sonnet-4-5" }],
  };

  const byId = (id: string) => targets.find((t) => t.id === id)!;
  await byId("codex").apply(openai);
  await byId("pi").apply(openai);
  await byId("omp").apply(anthropic);

  const rows: ProviderCandidate[] = ["codex", "pi", "omp"].flatMap((id) => byId(id).candidates?.() ?? []);
  const merged = mergeCandidates(rows, [
    { id: "existing-sub", protocol: "openai", baseUrl: "https://sub.example/v1/" },
  ]);

  assert.equal(merged.length, 2, "same URL is not deduped across different wire protocols");

  const responses = merged.find((c) => c.protocol === "openai")!;
  assert.equal(responses.id, "sub");
  assert.deepEqual(responses.sources.sort(), ["codex", "pi"]);
  assert.deepEqual(responses.models, ["gpt-5", "glm-4.6"]);
  assert.equal(responses.apiKey, "sk-sub-openai");
  assert.equal(responses.configured, "existing-sub", "trailing slash is ignored for existing-provider dedupe");

  const messages = merged.find((c) => c.protocol === "anthropic")!;
  assert.equal(messages.id, "sub-anthropic");
  assert.deepEqual(messages.sources, ["omp"]);
  assert.deepEqual(messages.models, ["claude-sonnet-4-5"]);
  assert.equal(messages.apiKey, "sk-sub-anthropic");
  assert.equal(messages.configured, undefined);
});

test("all eight adapters expose an applied custom provider for import", async () => {
  for (const dir of [
    ".claude",
    ".codex",
    ".omp/agent",
    ".pi/agent",
    ".prime/agent",
    ".config/opencode",
    ".hermes",
    ".workbuddy",
  ]) {
    fs.mkdirSync(path.join(sandbox, dir), { recursive: true });
  }

  for (const target of targets) {
    const protocol = target.id === "claude" ? "anthropic" : "openai";
    const baseUrl = `https://${target.id}.import.test/v1`;
    const model = `model-${target.id}`;
    const provider: Provider = {
      id: `round-${target.id}`,
      name: `Round ${target.name}`,
      protocol,
      baseUrl,
      apiKey: `sk-${target.id}`,
      defaultModel: model,
      models: [{ id: model }],
    };

    await target.apply(provider);
    const candidate = target.candidates?.().find((c) => c.baseUrl.replace(/\/+$/, "") === baseUrl);
    assert.ok(candidate, `${target.id} should expose its written provider`);
    assert.equal(candidate.protocol, protocol, `${target.id} protocol`);
    assert.equal(candidate.apiKey, provider.apiKey, `${target.id} API key`);
    assert.ok(candidate.models.includes(model), `${target.id} model list`);
    assert.equal(candidate.source, target.id, `${target.id} source marker`);
  }
});

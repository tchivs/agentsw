import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Catalog } from "../src/modelsdev.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-modelsdev-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
for (const name of ["HERMES_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) delete process.env[name];
const { findModelMeta, enrichModels } = await import("../src/modelsdev.js");
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
beforeEach((t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
});

const catalog: Catalog = {
  basename: { id: "basename", models: { "other/model": { id: "other/model", name: "Basename fallback", limit: { context: 100 } } } },
  exact: { id: "exact", models: { "vendor/model": { id: "vendor/model", name: "Exact identity", limit: { context: 200 }, reasoning: true } } },
};

test("global exact identities beat an earlier provider basename fallback", () => {
  const hit = findModelMeta(catalog, "vendor/model");
  assert.equal(hit?.provider, "exact");
  assert.equal(hit?.spec.id, "vendor/model");
  assert.equal(hit?.spec.contextWindow, 200);
  assert.equal(hit?.spec.reasoning, true);
  assert.equal(findModelMeta({ exact: catalog.exact!, basename: catalog.basename! }, "vendor/model")?.provider, "exact");
});

test("explicit provider hints retain documented exact-then-basename precedence", () => {
  assert.equal(findModelMeta(catalog, "vendor/model", "basename")?.provider, "basename");
  assert.equal(findModelMeta(catalog, "vendor/model", "exact")?.provider, "exact");
  assert.equal(findModelMeta(catalog, "vendor/model", "missing")?.provider, "exact");
  const withHint: Catalog = { ...catalog, hint: { id: "hint", models: {
    "other/model": { id: "other/model", limit: { context: 300 } },
    "vendor/model": { id: "vendor/model", limit: { context: 400 } },
  } } };
  assert.equal(findModelMeta(withHint, "vendor/model", "hint")?.spec.contextWindow, 400);
});

test("basename fallback is case insensitive only after exact identities are exhausted", () => {
  const fallback = findModelMeta(catalog, "reseller/MODEL");
  assert.equal(fallback?.provider, "basename");
  assert.equal(fallback?.spec.id, "reseller/MODEL");
  assert.deepEqual(enrichModels(catalog, ["vendor/model", "unknown"]), [findModelMeta(catalog, "vendor/model")!.spec, { id: "unknown" }]);
});

test("dry-run catalog refresh retains fetched metadata without requiring a cache file", async (t) => {
  const { loadCatalog, getCatalogFetchedAt } = await import("../src/modelsdev.js");
  const { setDryRun, drainPendingWrites } = await import("../src/fsutil.js");
  const { configDir } = await import("../src/store.js");
  t.mock.method(globalThis, "fetch", async () => Response.json(catalog));
  setDryRun(true);
  t.after(() => { setDryRun(false); drainPendingWrites(); });
  const loaded = await loadCatalog({ refresh: true });
  assert.deepEqual(loaded, catalog);
  assert.ok(getCatalogFetchedAt(loaded!));
  assert.equal(fs.existsSync(configDir), false);
});

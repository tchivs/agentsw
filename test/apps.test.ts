import { test } from "node:test";
import assert from "node:assert/strict";
import { appCommand, appPackages } from "../src/apps.js";

test("Windows uses native package-manager commands instead of Unix shell installers", () => {
  const command = (id: string, action: "install" | "upgrade") => {
    const app = appPackages.find((candidate) => candidate.id === id)!;
    return appCommand(app, action, "win32");
  };

  assert.match(command("claude", "install")!, /^npm install -g /);
  assert.match(command("codex", "install")!, /^npm install -g /);
  assert.match(command("pi", "upgrade")!, /^npm install -g /);
  assert.match(command("opencode", "install")!, /^npm install -g /);
  assert.match(command("hermes", "upgrade")!, /uv tool upgrade/);
  assert.match(command("dsh", "install")!, /^npm install -g /);
  assert.equal(command("omp", "install"), undefined);
  assert.equal(command("prime", "install"), undefined);
  assert.equal(command("workbuddy", "install"), undefined);
});

test("Unix commands remain unchanged", () => {
  const claude = appPackages.find((app) => app.id === "claude")!;
  assert.match(appCommand(claude, "install", "linux")!, /install\.sh \| bash$/);
  assert.equal(appCommand(claude, "upgrade", "darwin"), "claude update");
});

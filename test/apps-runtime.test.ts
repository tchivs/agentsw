import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-app-runtime-"));
process.env.AGENTSW_HOME = sandbox;
process.env.HOME = sandbox;
const originalPath = process.env.PATH;
const { installedVersion, binaryOnPath, isNewer, normalizeAppVersion, runShell } = await import("../src/apps.js");
afterEach(() => { process.env.PATH = originalPath; });
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox, { recursive: true });
});

for (const [installed, latest, expected] of [
  ["1.0.0-rc.1", "1.0.0", true],
  ["1.0.0-rc.2", "1.0.0-rc.10", true],
  ["1.0.0", "1.0.0-rc.1", false],
  ["1.0.0+1", "1.0.0+2", false],
  ["1.0.9", "1.0.10", true],
  ["v1.2", "1.3.0", true],
  ["?", "1.0.0", false],
  ["1.0.0", "garbage", false],
] as const) {
  test(`version precedence ${installed} -> ${latest}`, () => {
    assert.equal(isNewer(installed, latest), expected);
  });
}

test("version normalization does not coerce arbitrary failed probe output", () => {
  assert.equal(normalizeAppVersion("v1.2.3-rc.1+build"), "1.2.3-rc.1");
  assert.equal(normalizeAppVersion("1.2"), "1.2.0");
  assert.equal(normalizeAppVersion("failed with error 123"), undefined);
  assert.equal(normalizeAppVersion(undefined), undefined);
});

function fakeBinary(output: string, failure = false): string {
  const bin = path.join(sandbox, "commands with spaces");
  fs.mkdirSync(bin, { recursive: true });
  const windows = process.platform === "win32";
  const file = path.join(bin, "fixture-probe" + (windows ? ".cmd" : ""));
  fs.writeFileSync(file, windows
    ? `@echo off\r\necho ${output}\r\nexit /b ${failure ? 1 : 0}\r\n`
    : `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${failure ? 1 : 0}\n`, { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + (originalPath ?? "");
  return file;
}

test("version probe executes a real shim from a directory containing spaces", () => {
  fakeBinary("fixture-probe 1.2.3-rc.1");
  assert.equal(binaryOnPath("fixture-probe"), true);
  assert.equal(installedVersion({ id: "fixture", name: "Fixture", binary: "fixture-probe" }), "1.2.3-rc.1");
});

test("failed or unparseable version probes report unknown rather than not installed", () => {
  fakeBinary("unavailable", true);
  assert.equal(installedVersion({ id: "fixture", name: "Fixture", binary: "fixture-probe" }), "?");
  fakeBinary("no version string");
  assert.equal(installedVersion({ id: "fixture", name: "Fixture", binary: "fixture-probe" }), "?");
});

test("a directory on PATH is not mistaken for an executable", () => {
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(path.join(bin, "fixture-directory" + (process.platform === "win32" ? ".cmd" : "")), { recursive: true });
  process.env.PATH = bin;
  assert.equal(binaryOnPath("fixture-directory"), false);
});

test("installer failures propagate through the shell and Unix pipelines", () => {
  assert.throws(() => runShell(process.platform === "win32" ? "exit /b 23" : "false | true"));
});

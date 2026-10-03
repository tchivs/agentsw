import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  ActionCancelled,
  cancelInteractive,
  configureOutput,
  emitJson,
  error,
  isJson,
  isQuiet,
  note,
  out,
  setCommandName,
  setInMenu,
  warn,
} from "../src/ui.js";

/** picocolors drops color when stdout is not a TTY (as under the test runner). */
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

let stdout: string[] = [];
let stderr: string[] = [];

beforeEach((t) => {
  stdout = [];
  stderr = [];
  configureOutput({ json: false, quiet: false, version: "0.0.0-test" });
  setCommandName("status");
  setInMenu(false);
  t.mock.method(console, "log", (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); });
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; });
  t.mock.method(process, "exit", ((code?: number | null): never => {
    throw new Error(`process.exit(${String(code)})`);
  }) as typeof process.exit);
});
afterEach(() => mock.restoreAll());
after(() => configureOutput({ json: false, quiet: false }));

test("out writes through console.log and disappears in machine mode", () => {
  out("hello");
  assert.deepEqual(stdout, ["hello"]);
  configureOutput({ json: true });
  out("hidden");
  assert.deepEqual(stdout, ["hello"]);
  assert.equal(isJson(), true);
});

test("note and warn use stderr and honor --quiet", () => {
  note("loading");
  warn("be careful");
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr.map(plain), ["loading\n", "warning: be careful\n"]);
  stderr = [];
  configureOutput({ quiet: true });
  assert.equal(isQuiet(), true);
  note("loading");
  warn("be careful");
  assert.deepEqual(stderr, []);
});

test("emitJson writes exactly one parseable envelope", () => {
  emitJson({ providers: 2 });
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]!), {
    ok: true, command: "status", version: "0.0.0-test", data: { providers: 2 },
  });
});

test("error exits 1 with a colored stderr line, or a single stdout document in machine mode", () => {
  assert.throws(() => error("boom"), /process\.exit\(1\)/);
  assert.deepEqual(stderr.map(plain), ["error: boom\n"]);
  assert.deepEqual(stdout, []);

  stdout = [];
  stderr = [];
  configureOutput({ json: true });
  assert.throws(() => error("boom"), /process\.exit\(1\)/);
  assert.deepEqual(stderr, []);
  assert.deepEqual(JSON.parse(stdout[0]!), {
    ok: false, command: "status", version: "0.0.0-test", error: { message: "boom" },
  });
});

test("cancelInteractive unwinds inside the menu instead of exiting", () => {
  setInMenu(true);
  assert.throws(() => cancelInteractive(), ActionCancelled);
  setInMenu(false);
  assert.throws(() => cancelInteractive(), /process\.exit\(130\)/);
  assert.deepEqual(stderr.map(plain), ["cancelled\n"]);
});

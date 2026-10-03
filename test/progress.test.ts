import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { configureOutput } from "../src/ui.js";
import { progressEnabled, startProgress, withProgress } from "../src/progress.js";

/** Records everything a progress handle writes, without touching the real stderr. */
function fakeStream(): { isTTY: true; chunks: string[]; write(chunk: string): boolean } {
  return { isTTY: true, chunks: [], write(chunk: string) { this.chunks.push(chunk); return true; } };
}

let stderr: string[] = [];
beforeEach((t) => {
  stderr = [];
  configureOutput({ json: false, quiet: false });
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
});
afterEach(() => mock.restoreAll());

test("renders frames on a TTY and clears the line exactly once when stopped", async () => {
  const stream = fakeStream();
  const handle = startProgress("working", { stream, enabled: true, intervalMs: 1, delayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 12));
  handle.update("still working");
  await new Promise((resolve) => setTimeout(resolve, 12));
  handle.stop();
  const painted = stream.chunks.filter((chunk) => chunk.includes("working"));
  assert.ok(painted.length >= 2, "the spinner should repaint on its interval");
  assert.ok(painted.every((chunk) => chunk.startsWith("\r\u001b[2K")));
  assert.equal(stream.chunks.at(-1), "\r\u001b[2K");
  assert.deepEqual(stderr, [], "a TTY handle must not also write a plain line");
  // Re-entrant stop must not emit a second clear.
  const before = stream.chunks.length;
  handle.stop();
  assert.equal(stream.chunks.length, before);
});

test("withProgress always stops, including when the work throws", async () => {
  const stream = fakeStream();
  const listenersBefore = process.listenerCount("SIGINT");
  await assert.rejects(
    withProgress("failing", async () => { throw new Error("nope"); }, { stream, enabled: true, intervalMs: 1, delayMs: 0 }),
    /nope/,
  );
  assert.deepEqual(stream.chunks, [], "the throw landed before the first frame, so nothing needed clearing");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(stream.chunks, [], "a stopped handle never paints again");
  assert.equal(process.listenerCount("SIGINT"), listenersBefore, "the interrupt fallback is removed with the handle");
});

test("disabled progress writes the same single line the CLI printed before", () => {
  const stream = fakeStream();
  const handle = startProgress("loading catalog", { stream, enabled: false });
  handle.update("ignored");
  handle.stop();
  assert.deepEqual(stream.chunks, []);
  assert.deepEqual(stderr, ["loading catalog\n"]);
});

test("progressEnabled stays quiet under the test runner regardless of mode", () => {
  const stream = fakeStream();
  assert.equal(progressEnabled(), false, "npm test runs in a TTY but must stay quiet");
  assert.equal(progressEnabled({ stream }), false);
  configureOutput({ json: true });
  assert.equal(progressEnabled({ stream }), false);
  configureOutput({ json: false, quiet: true });
  assert.equal(progressEnabled({ stream }), false);
  configureOutput({ json: false, quiet: false });
  // An explicit override is the only way in, which is what the animation tests rely on.
  assert.equal(progressEnabled({ stream, enabled: true }), true);
});

test("a nested handle borrows the live line and restores the owner's text", async () => {
  const stream = fakeStream();
  const owner = startProgress("outer", { stream, enabled: true, intervalMs: 1, delayMs: 0 });
  const nested = startProgress("inner", { stream, enabled: true, intervalMs: 1, delayMs: 0 });
  nested.stop();
  await new Promise((resolve) => setTimeout(resolve, 8));
  // The owner is still alive and painting its own text after the borrower stopped.
  assert.ok(stream.chunks.some((chunk) => chunk.includes("outer")));
  owner.stop();
});

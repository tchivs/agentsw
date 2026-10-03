import { test } from "node:test";
import assert from "node:assert/strict";
import { table, truncateVisible, visibleWidth, padCell, terminalWidth } from "../src/ui.js";

const rows = [
  ["alpha", "https://very-long-endpoint.example/v1", "12"],
  ["b", "https://x.example/v1", "3"],
];
const header = ["ID", "BASE URL", "MODELS"];

test("width 0 keeps the original left-aligned rendering byte for byte", () => {
  const widths = header.map((_, i) => Math.max(...[header, ...rows].map((row) => row[i]!.length)));
  const rendered = [header, ...rows].map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
  const expected = [rendered[0], widths.map((w) => "-".repeat(w)).join("  "), ...rendered.slice(1)].join("\n");
  assert.equal(table(rows, header, { width: 0 }), expected);
  // The default is also 0 under a pipe or test runner, so nothing changes for scripts.
  assert.equal(table(rows, header), expected);
});

test("right alignment left-pads numeric cells", () => {
  const rendered = table([["a", "7"], ["bb", "100"]], undefined, { align: ["left", "right"], width: 0 });
  assert.deepEqual(rendered.split("\n"), ["a     7", "bb  100"]);
});

test("truncates only the eligible columns and marks every cut with an ellipsis", () => {
  const rendered = table(rows, header, { width: 30, truncate: [1, 0] });
  for (const line of rendered.split("\n")) assert.ok(visibleWidth(line) <= 30, line);
  const body = rendered.split("\n").slice(2);
  assert.ok(body.every((line) => line.includes("…")));
  // Column 2 was never eligible, so its values survive intact.
  assert.match(body[0]!, /12/);
  assert.match(body[1]!, /3/);
});

test("never truncates when no column is eligible", () => {
  const rendered = table(rows, header, { width: 10 });
  assert.equal(rendered, table(rows, header, { width: 0 }));
});

test("stops shrinking at minWidth instead of erasing a column", () => {
  const rendered = table([["identifier-value", "another-value"]], undefined, { width: 4, truncate: [0, 1], minWidth: 6 });
  for (const cell of rendered.split("  ")) assert.ok(visibleWidth(cell) >= 6, cell);
});

test("truncateVisible never cuts inside an SGR sequence and closes open color", () => {
  const cell = "\u001b[32mgreen-id\u001b[0m";
  const clipped = truncateVisible(cell, 6);
  assert.equal(visibleWidth(clipped), 6);
  assert.ok(clipped.endsWith("…\u001b[0m"));
  assert.doesNotMatch(clipped, /\u001b\[(?!\d*(?:;\d+)*m)/);
});

test("padCell pads to the requested visible width", () => {
  assert.equal(padCell("ab", 4), "ab  ");
  assert.equal(padCell("ab", 4, "right"), "  ab");
});

test("terminalWidth reports 0 when stdout has no column count", () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  try {
    Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
    assert.equal(terminalWidth(), 40);
    Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
    assert.equal(terminalWidth(), 0);
  } finally {
    if (original) Object.defineProperty(process.stdout, "columns", original);
    else Reflect.deleteProperty(process.stdout, "columns");
  }
});

import pc from "picocolors";
import { t } from "./i18n.js";

/** Thrown by cancelInteractive() inside the menu so a Ctrl-C returns to the menu instead of exiting. */
export class ActionCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "ActionCancelled";
  }
}

export interface OutputConfig {
  json?: boolean;
  quiet?: boolean;
  version?: string;
}

let json = false;
let quiet = false;
let version = "";
let command = "";
let inMenu = false;

export function configureOutput(config: OutputConfig): void {
  if (config.json !== undefined) json = config.json;
  if (config.quiet !== undefined) quiet = config.quiet;
  if (config.version !== undefined) version = config.version;
}

export function setCommandName(name: string): void {
  command = name;
}

export function setInMenu(value: boolean): void {
  inMenu = value;
}

export function isJson(): boolean {
  return json;
}

export function isQuiet(): boolean {
  return quiet;
}

/** Primary result channel. Machine mode suppresses it so stdout carries exactly one JSON document. */
export function out(line = ""): void {
  if (json) return;
  console.log(line);
}

/** Dimmed guidance ("next: ...", "run agentsw sync"). Dropped by --quiet and --json. */
export function note(message: string): void {
  if (json || quiet) return;
  process.stderr.write(pc.dim(message) + "\n");
}

/** Non-fatal problem. Keeps the literal "warning: " prefix callers and tests rely on. */
export function warn(message: string): void {
  if (json || quiet) return;
  process.stderr.write(pc.yellow(`warning: ${message}`) + "\n");
}

function emitJsonError(message: string): void {
  process.stdout.write(JSON.stringify({ ok: false, command, version, error: { message } }) + "\n");
}

export function emitJson(data: unknown): void {
  process.stdout.write(JSON.stringify({ ok: true, command, version, data }) + "\n");
}

/** Fatal error. In machine mode the failure becomes the single stdout document, so pipes stay parseable. */
export function error(message: string): never {
  if (json) emitJsonError(message);
  else process.stderr.write(pc.red(`error: ${message}`) + "\n");
  process.exit(1);
}

/**
 * Ctrl-C / Esc at an interactive prompt. Inside the menu this unwinds to the dispatch loop, which keeps the
 * session alive; standalone it exits 130 (the SIGINT convention), so a cancelled run is never mistaken for
 * a successful one. Prompts awaits onCancel inside a catch, so throwing here reliably rejects the prompt.
 */
export function cancelInteractive(): never {
  if (inMenu) throw new ActionCancelled();
  process.stderr.write(pc.dim(t("common.cancelled")) + "\n");
  process.exit(130);
}

/** 0 means "no known width" (pipe, file, test runner), which disables truncation entirely. */
export function terminalWidth(): number {
  const columns = process.stdout.columns;
  return typeof columns === "number" && Number.isFinite(columns) && columns > 0 ? columns : 0;
}

const SGR = /\u001b\[[0-9;]*m/g;

export function visibleWidth(text: string): number {
  return text.replace(SGR, "").length;
}

/** Clip to a visible width without ever cutting inside an SGR sequence; closes color that was left open. */
export function truncateVisible(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  const target = Math.max(0, max - 1);
  let out = "";
  let visible = 0;
  let colored = false;
  for (let i = 0; i < text.length && visible < target; ) {
    if (text.charAt(i) === "\u001b") {
      const match = /^\u001b\[[0-9;]*m/.exec(text.slice(i));
      if (match) {
        out += match[0];
        colored = true;
        i += match[0].length;
        continue;
      }
    }
    out += text.charAt(i);
    visible++;
    i++;
  }
  return `${out}…${colored ? "\u001b[0m" : ""}`;
}

export function padCell(text: string, width: number, align: "left" | "right" = "left"): string {
  const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
  return align === "right" ? padding + text : text + padding;
}

export interface TableOptions {
  /** Total width budget; defaults to the terminal, and 0 disables truncation. */
  width?: number;
  align?: Array<"left" | "right">;
  /** Column indices that may shrink, in priority order. Columns not listed are never truncated. */
  truncate?: number[];
  minWidth?: number;
}

export function table(rows: string[][], header?: string[], options: TableOptions = {}): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleWidth(cell));
    });
  }
  const minWidth = options.minWidth ?? 8;
  const width = options.width ?? terminalWidth();
  const eligible = (options.truncate ?? []).filter((i) => i < widths.length);
  if (width > 0 && eligible.length > 0) {
    const total = () => widths.reduce((sum, w, i) => sum + w + (i > 0 ? 2 : 0), 0);
    while (total() > width) {
      let widest = -1;
      for (const i of eligible) {
        if ((widths[i] ?? 0) <= minWidth) continue;
        if (widest === -1 || (widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i;
      }
      if (widest === -1) break;
      widths[widest] = (widths[widest] ?? 0) - 1;
    }
  }
  const render = (row: string[]) =>
    row
      .map((cell, i) => {
        const column = widths[i] ?? 0;
        const clipped = visibleWidth(cell) > column ? truncateVisible(cell, column) : cell;
        return padCell(clipped, column, options.align?.[i] ?? "left");
      })
      .join("  ")
      .trimEnd();
  const lines = all.map(render);
  if (header) lines.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
  return lines.join("\n");
}

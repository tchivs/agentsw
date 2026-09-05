import fs from "node:fs";
import {
  applyEdits,
  createScanner,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
  SyntaxKind,
} from "jsonc-parser";
import type { Edit, JSONPath, Node as JsoncNode, ParseError } from "jsonc-parser";

export interface JsoncDocument {
  file: string;
  text: string;
  value: Record<string, unknown>;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsoncObject(file: string, text: string): Record<string, unknown> {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { allowTrailingComma: true });
  const error = errors[0];
  if (error) {
    // Do not quote source text: config files can contain credentials.
    throw new Error(`${file}: invalid JSONC (${printParseErrorCode(error.error)} at offset ${error.offset})`);
  }
  if (root?.type !== "object") throw new Error(`${file}: expected a JSON object at the document root`);
  // Parsing resolves duplicate keys last-wins, but modify edits the first occurrence.
  // Reject that ambiguity at any depth rather than syncing a value the agent will not read.
  const checkDuplicates = (node: JsoncNode): void => {
    const names = node.type === "object" ? new Set<string>() : undefined;
    for (const child of node.children ?? []) {
      if (names) {
        const name = child.children![0]!.value as string;
        if (names.has(name)) {
          throw new Error(`${file}: invalid JSONC (duplicate object property at offset ${child.offset})`);
        }
        names.add(name);
      }
      checkDuplicates(child);
    }
  };
  checkDuplicates(root);
  return getNodeValue(root) as Record<string, unknown>;
}

/** Only missing files initialize to an empty object; unreadable or invalid files must not be replaced. */
export function readJsoncObject(file: string): JsoncDocument {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, text: "{}\n", value: {} };
    throw error;
  }
  return { file, text, value: parseJsoncObject(file, text) };
}

function comments(text: string): string[] {
  const result: string[] = [];
  const scanner = createScanner(text);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      result.push(text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
    }
  }
  return result;
}

/** modify() may include adjacent comments in deletion ranges; retain them as detached comments. */
function retainComments(text: string, edit: Edit, eol: string): Edit {
  const remaining = new Map<string, number>();
  for (const comment of comments(edit.content)) remaining.set(comment, (remaining.get(comment) ?? 0) + 1);
  const removed: string[] = [];
  for (const comment of comments(text.slice(edit.offset, edit.offset + edit.length))) {
    const count = remaining.get(comment) ?? 0;
    if (count) remaining.set(comment, count - 1);
    else removed.push(comment);
  }
  return removed.length ? { ...edit, content: eol + removed.join(eol) + eol + edit.content } : edit;
}

/** Change only differing values, leaving unrelated fields, comments, and string literals intact. */
export function editJsoncObject(document: JsoncDocument, value: Record<string, unknown>): string {
  const bom = document.text.startsWith("\uFEFF") ? "\uFEFF" : "";
  let text = bom ? document.text.slice(1) : document.text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const update = (location: JSONPath, previous: unknown, next: unknown): void => {
    if (previous === next) return;
    if (isJsonObject(previous) && isJsonObject(next)) {
      const keys = Object.keys(next);
      if (keys.length || !Object.keys(previous).length) {
        // Add before deleting, so a trailing-comma object never temporarily loses its last property.
        for (const key of keys) update([...location, key], previous[key], next[key]);
        for (const key of Object.keys(previous)) {
          if (!Object.hasOwn(next, key)) update([...location, key], previous[key], undefined);
        }
        return;
      }
      // Replacing an emptying object also removes its trailing comma (modify's last-property
      // deletion otherwise leaves `{,}`). retainComments keeps comments from the removed subtree.
    }
    // Replace shrinking arrays whole: modify's last-element deletion can truncate a compact
    // value incorrectly. Equal-length/growing arrays still get incremental, comment-safe edits.
    if (Array.isArray(previous) && Array.isArray(next) && next.length >= previous.length) {
      for (let index = 0; index < next.length; index++) {
        update([...location, index], previous[index], next[index]);
      }
      return;
    }
    const edits = modify(text, location, next, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } });
    text = applyEdits(text, edits.map((edit) => retainComments(text, edit, eol)));
  };
  update([], document.value, value);
  // Never let a library edit boundary or comment relocation write malformed output.
  parseJsoncObject(document.file, text);
  return bom + text;
}

export interface EnvAssignment {
  name: string;
  offset: number;
  value: string;
  start: number;
  length: number;
  valueStart: number;
  valueLength: number;
}

/** Tokenize complete dotenv assignments, including quoted multiline values. */
export function envAssignments(file: string, text: string): EnvAssignment[] {
  const result: EnvAssignment[] = [];
  let position = 0;
  const invalid = (): never => { throw new Error(`${file}: invalid environment configuration`); };
  const skipSpace = () => { while (text[position] === " " || text[position] === "\t") position++; };
  while (position < text.length) {
    const start = position;
    skipSpace();
    if (text[position] === "#") {
      while (position < text.length && text[position] !== "\n" && text[position] !== "\r") position++;
    } else if (position < text.length && text[position] !== "\r" && text[position] !== "\n") {
      if (text.startsWith("export", position) && /[\t ]/.test(text[position + 6] ?? "")) {
        position += 6;
        skipSpace();
      }
      const offset = position;
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(position))?.[0];
      if (!name) return invalid();
      position += name.length;
      skipSpace();
      if (text[position++] !== "=") invalid();
      skipSpace();
      const valueStart = position;
      let value: string;
      const quote = text[position];
      if (quote === '"' || quote === "'") {
        position++;
        const contentStart = position;
        while (position < text.length && text[position] !== quote) {
          if (quote === '"' && text[position] === "\\") position++;
          position++;
        }
        if (text[position] !== quote) invalid();
        value = text.slice(contentStart, position++);
        if (quote === '"') value = value.replace(/\\(\\|"|n|r)/g, (_escape, character: string) => character === "n" ? "\n" : character === "r" ? "\r" : character);
      } else {
        while (position < text.length && !"\r\n#".includes(text[position]!)) position++;
        value = text.slice(valueStart, position).trimEnd();
      }
      const valueLength = quote === '"' || quote === "'" ? position - valueStart : value.length;
      skipSpace();
      if (text[position] === "#") {
        while (position < text.length && text[position] !== "\n" && text[position] !== "\r") position++;
      }
      if (position < text.length && text[position] !== "\r" && text[position] !== "\n") invalid();
      if (text[position] === "\r") {
        if (text[position + 1] !== "\n") invalid();
        position++;
      }
      if (text[position] === "\n") position++;
      result.push({ name, offset, value, start, length: position - start, valueStart, valueLength });
      continue;
    }
    if (text[position] === "\r") {
      if (text[position + 1] !== "\n") invalid();
      position++;
    }
    if (text[position] === "\n") position++;
  }
  return result;
}

/** Quote only when necessary, with no dotenv escape round-trip ambiguity. */
function encodeEnvValue(value: string): string {
  if (/^[^\s#'"`]+$/.test(value) && !value.includes("\\")) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

/** Update complete parsed values, retaining exports, comments and unrelated bytes. */
export function upsertEnvAssignment(file: string, text: string, name: string, value: string): string {
  const assignments = envAssignments(file, text).filter((assignment) => assignment.name === name);
  const encoded = encodeEnvValue(value);
  if (!assignments.length) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    return text + (text === "" || text.endsWith("\n") ? "" : newline) + `${name}=${encoded}${newline}`;
  }
  for (const assignment of assignments.reverse()) {
    text = text.slice(0, assignment.valueStart) + encoded + text.slice(assignment.valueStart + assignment.valueLength);
  }
  return text;
}

/** Delete complete assignments, never lines embedded in another quoted value. */
export function removeEnvAssignments(file: string, text: string, names: ReadonlySet<string>): string {
  const assignments = envAssignments(file, text);
  for (const assignment of assignments.reverse()) {
    if (names.has(assignment.name)) text = text.slice(0, assignment.start) + text.slice(assignment.start + assignment.length);
  }
  return text;
}

export interface EnvAssignment {
  name: string;
  offset: number;
  value: string;
  start: number;
  length: number;
}

/** Tokenize complete dotenv assignments, including quoted multiline values. */
export function envAssignments(file: string, text: string): EnvAssignment[] {
  const result: EnvAssignment[] = [];
  const pattern = /^([\t ]*(?:export[\t ]+)?)([A-Za-z_][A-Za-z0-9_]*)([\t ]*=[\t ]*)("(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\r\n]*)(?:[\t ]*#[^\r\n]*)?[\t ]*(?:\r?\n|$)/gm;
  let end = 0;
  const trivia = (text: string) => text.split(/\r?\n/).every((line) => !line.trim() || line.trimStart().startsWith("#"));
  for (const match of text.matchAll(pattern)) {
    if (!trivia(text.slice(end, match.index))) throw new Error(`${file}: invalid environment configuration`);
    let value = match[4]!;
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.at(-1) !== value[0]) throw new Error(`${file}: invalid quoted environment value`);
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else value = value.split("#", 1)[0]!.trim();
    result.push({ name: match[2]!, offset: match.index! + match[1]!.length, value, start: match.index!, length: match[0].length });
    end = match.index! + match[0].length;
  }
  if (!trivia(text.slice(end))) throw new Error(`${file}: invalid environment configuration`);
  return result;
}

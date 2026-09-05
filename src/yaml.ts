import YAML from "yaml";

/** Resolve aliases in document context before edits can mutate or remove anchors. */
export function parseYamlMapping(file: string, text: string | undefined): YAML.Document {
  try {
    const doc = text ? YAML.parseDocument(text) : new YAML.Document({});
    if (doc.errors.length) throw new Error("parse error");
    if (doc.contents == null) doc.contents = doc.createNode({});
    // YAML permits cycles; application configuration does not. The document
    // conversion also enforces YAML's alias expansion limit before we detach.
    JSON.stringify(doc.toJS());
    const expanded = new Map<YAML.Alias, YAML.Node>();
    YAML.visit(doc, {
      Alias(_key, alias) {
        const node = doc.createNode(alias.toJS(doc), { aliasDuplicateObjects: false });
        node.comment = alias.comment;
        node.commentBefore = alias.commentBefore;
        node.spaceBefore = alias.spaceBefore;
        expanded.set(alias, node);
      },
    });
    // Resolve every alias before replacing any, since anchors may be reused.
    YAML.visit(doc, { Alias: (_key, alias) => expanded.get(alias) });
    if (!YAML.isMap(doc.contents)) throw new Error("expected a configuration mapping");
    return doc;
  } catch {
    // Parser messages include source lines, which may contain credentials.
    throw new Error(`${file}: invalid YAML configuration (expected an acyclic mapping with valid aliases)`);
  }
}

/** Validate the emitted configuration before any backup or write. */
export function serializeYamlMapping(file: string, doc: YAML.Document): string {
  const text = doc.toString();
  parseYamlMapping(file, text);
  return text;
}

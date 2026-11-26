/**
 * Adding an entry to a list in a file's frontmatter while the user edits its
 * markdown: a workflow's `steps` from the step picker, a step's `tools` from
 * the tool picker. The text stays the user's; only that field changes.
 */

/**
 * The file with `entry` (a step name, or `@name` for a workflow) added at
 * the end of its `steps`: to a `[a, b]` list, to a block list, or in place
 * of `steps: dynamic` or a missing field.
 */
export const addToSteps = (text: string, entry: string): string =>
  addToList(text, "steps", entry);

/** The file with a tool's name added at the end of its `tools`. */
export const addToTools = (text: string, entry: string): string =>
  addToList(text, "tools", entry);

function addToList(text: string, field: string, entry: string): string {
  const flow = new RegExp(
    `^(${field}:[ \\t]*\\[)([^\\]\\n]*)(\\][ \\t]*)$`,
    "m",
  ).exec(text);
  if (flow) {
    const items = flow[2]!.trim();
    const list = items ? `${items.replace(/,\s*$/, "")}, ${entry}` : entry;
    return text.replace(flow[0], `${flow[1]}${list}${flow[3]}`);
  }
  const block = new RegExp(
    `^${field}:[ \\t]*\\n((?:[ \\t]+-[^\\n]*(?:\\n|$))+)`,
    "m",
  ).exec(text);
  if (block) {
    const items = block[1]!;
    const indent = /^([ \t]+)-/.exec(items)?.[1] ?? "  ";
    const ending = items.endsWith("\n") ? "" : "\n";
    return text.replace(
      block[0],
      `${field}:\n${items}${ending}${indent}- ${entry}${ending ? "" : "\n"}`,
    );
  }
  const line = new RegExp(`^${field}:.*$`, "m");
  if (line.test(text)) return text.replace(line, `${field}: [${entry}]`);
  // No such field: it goes last in the frontmatter.
  const close = /^(---\r?\n[\s\S]*?\r?\n)(---)/.exec(text);
  return close
    ? text.replace(close[0], `${close[1]}${field}: [${entry}]\n${close[2]}`)
    : text;
}

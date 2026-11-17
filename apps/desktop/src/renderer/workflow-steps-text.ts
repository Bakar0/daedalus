/**
 * Adding an entry to a workflow file's `steps` while the user edits its
 * markdown: the step picker's one job. The text stays the user's; only the
 * `steps` field changes.
 */

/**
 * The file with `entry` (a step name, or `@name` for a workflow) added at
 * the end of its `steps`: to a `[a, b]` list, to a block list, or in place
 * of `steps: dynamic` or a missing field.
 */
export function addToSteps(text: string, entry: string): string {
  const flow = /^(steps:[ \t]*\[)([^\]\n]*)(\][ \t]*)$/m.exec(text);
  if (flow) {
    const items = flow[2]!.trim();
    const list = items ? `${items.replace(/,\s*$/, "")}, ${entry}` : entry;
    return text.replace(flow[0], `${flow[1]}${list}${flow[3]}`);
  }
  const block = /^steps:[ \t]*\n((?:[ \t]+-[^\n]*(?:\n|$))+)/m.exec(text);
  if (block) {
    const items = block[1]!;
    const indent = /^([ \t]+)-/.exec(items)?.[1] ?? "  ";
    const ending = items.endsWith("\n") ? "" : "\n";
    return text.replace(
      block[0],
      `steps:\n${items}${ending}${indent}- ${entry}${ending ? "" : "\n"}`,
    );
  }
  if (/^steps:.*$/m.test(text))
    return text.replace(/^steps:.*$/m, `steps: [${entry}]`);
  // No steps field: it goes last in the frontmatter.
  const close = /^(---\r?\n[\s\S]*?\r?\n)(---)/.exec(text);
  return close
    ? text.replace(close[0], `${close[1]}steps: [${entry}]\n${close[2]}`)
    : text;
}

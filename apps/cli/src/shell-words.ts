/**
 * One argument as a shell reads it back: bare when it is plain, else in
 * double quotes with `"`, `\`, `$` and backticks escaped. Used to print a
 * command a caller can run as is, such as the replacement for an old one.
 */
export function shellWord(value: string): string {
  if (/^[\w@%+=:,./^-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** A command line from its words, each quoted as the shell needs. */
export function shellLine(words: readonly string[]): string {
  return words.map(shellWord).join(" ");
}

import { DaedalusError } from "@daedalus/core";

export interface ParsedArguments {
  positionals: string[];
  values: Record<string, string>;
  flags: Set<string>;
}

export function parseArguments(
  args: string[],
  valueOptions: string[],
  booleanOptions: string[] = [],
): ParsedArguments {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleanOptions.includes(name)) {
      flags.add(name);
      continue;
    }
    if (!valueOptions.includes(name))
      throw new DaedalusError("VALIDATION", `Unknown option '--${name}'`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new DaedalusError(
        "VALIDATION",
        `Option '--${name}' requires a value`,
      );
    if (values[name] !== undefined)
      throw new DaedalusError(
        "VALIDATION",
        `Option '--${name}' was provided more than once`,
      );
    values[name] = value;
    index += 1;
  }
  return { positionals, values, flags };
}

export function required(
  value: string | undefined,
  description: string,
): string {
  if (value === undefined)
    throw new DaedalusError("VALIDATION", `${description} is required`);
  return value;
}

export function expectPositionals(
  values: string[],
  count: number,
  usage: string,
): void {
  if (values.length !== count)
    throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
}

export function printResult(
  data: unknown,
  json: boolean,
  human: () => void,
): void {
  if (json) console.log(JSON.stringify({ ok: true, data }));
  else human();
}

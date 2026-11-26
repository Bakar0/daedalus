import { DaedalusError, type ApplicationContext } from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const toolHelp = `Tool commands. A tool is the user's instructions for one recurring thing, such
as getting access, reading logs or using a CLI. A workflow step may suggest
tools; any session may open any tool:
  daedal tool list
      Every tool with what it is for.
  daedal tool show <name>
      A tool's instructions.
Tools are files in <home>/workflows/tools/<name>.md with frontmatter 'name'
and 'description'; the body is the instructions.`;

export async function toolCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(toolHelp);
    return 0;
  }
  const parsed = parseArguments(args, [], []);
  const { tools } = await context.workflows.catalog();
  if (action === "list") {
    expectPositionals(parsed.positionals, 0, "daedal tool list");
    printResult(tools, json, () => {
      if (!tools.length) console.log("No tools");
      for (const tool of tools)
        console.log(
          `${tool.name}${tool.description ? `: ${tool.description}` : ""}`,
        );
    });
    return 0;
  }
  if (action === "show") {
    expectPositionals(parsed.positionals, 1, "daedal tool show <name>");
    const name = parsed.positionals[0]!;
    const tool = tools.find((item) => item.name === name);
    if (!tool)
      throw new DaedalusError(
        "NOT_FOUND",
        `No tool '${name}'. 'daedal tool list' shows the ones there are`,
      );
    printResult(tool, json, () => {
      if (tool.description) console.log(`${tool.description}\n`);
      console.log(tool.body.trim());
    });
    return 0;
  }
  throw new DaedalusError(
    "VALIDATION",
    `Unknown tool command '${action}'. Run 'daedal tool help'`,
  );
}
